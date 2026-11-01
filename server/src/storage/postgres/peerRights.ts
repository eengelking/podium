// Orchestrator messaging (#347, #412): the rights between one owner's reporters, each owner's defaults and stricter
// limits, and the requests the owner answers (SPEC 7.7, DECISIONS 37). Every write that joins two reporters checks,
// here and whatever the settings say, that both belong to the same person and neither reports with the admin secret;
// a refusal stores nothing. Text in a request (an orchestrator's reason) is never logged here: trails carry rows, and
// the routes decide what goes in a log line. All statements are parameterized.
import { randomBytes } from 'node:crypto';
import { PEER_ANSWERS, PEER_LEVELS, PEER_LIMITS, type PeerAnswer, type PeerLevel, type PeerRequestKind } from '../../fleet/protocol.js';
import {
  OWNER_DEFAULTS,
  refuse,
  type AccessOutcome,
  type Actor,
  type AnswerOutcome,
  type EffectiveRight,
  type OwnerDefaults,
  type PeerRequestRow,
  type Refusal,
  type ReporterRef,
  type RightRow,
  type RightsTrail,
} from '../../fleet/peerTypes.js';
import { ADMIN_OWNER, nameKey } from '../rows.js';
import { PEER_LIMIT_KEYS, peerSettingError, type PeerLimits } from '../settings.js';
import type { AsyncPeerReporterLookup, PeerRightsStoreApi } from '../types.js';
import type { PgDb } from './conn.js';

/** How far each level reaches, so a request that is allowed never lowers a right the owner already gave. */
const RANK: Record<PeerLevel, number> = { none: 0, see: 1, ask: 2, send: 3 };
const ON_REQUEST: readonly OwnerDefaults['onRequest'][] = ['ask', 'allow', 'decline'];
const NEW_SEND: readonly OwnerDefaults['newSend'][] = ['ask', 'send'];
const NO_ADMIN = 'a reporter on the admin secret cannot take part';

interface DbRight {
  from_key: string;
  to_key: string;
  owner: string;
  level: PeerLevel;
  paused: number;
  set_at: number;
}

interface DbRequest {
  id: string;
  owner: string;
  kind: PeerRequestKind;
  from_key: string;
  to_key: string;
  level: PeerLevel | null;
  reason: string | null;
  by: string;
  from_session: string | null;
  message_id: string | null;
  created_at: number;
  closed_at: number | null;
  outcome: PeerRequestRow['outcome'];
}

interface DbDefaults {
  trust: number;
  on_request: string;
  new_send: string;
  limits_json: string | null;
}

type Owned = ReporterRef & { owner: string };

/** A reporter that can take part: owned by a person, not by no one or `Admin`, and not on the admin secret. */
const eligible = (r: ReporterRef): r is Owned => !r.adminSecret && r.owner !== null && nameKey(r.owner) !== nameKey(ADMIN_OWNER);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The directions of a link: one when it joins a reporter to itself (two orchestrators on one machine), else two. */
const directions = (a: string, b: string): [string, string][] => (a === b ? [[a, a]] : [[a, b], [b, a]]);

/** An orchestrator's reason: control characters other than line breaks and tabs taken out, then trimmed. */
function cleanReason(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c === 9 || c === 10 || c === 13 || (c > 31 && c !== 127)) out += ch;
  }
  return out.trim();
}

const toRight = (r: DbRight): RightRow => ({ from: r.from_key, to: r.to_key, owner: r.owner, level: r.level, paused: r.paused === 1, setAt: r.set_at });

const toRequest = (r: DbRequest): PeerRequestRow => ({
  id: r.id,
  owner: r.owner,
  kind: r.kind,
  fromKey: r.from_key,
  toKey: r.to_key,
  level: r.level,
  reason: r.reason,
  by: r.by,
  fromSession: r.from_session,
  messageId: r.message_id,
  createdAt: r.created_at,
  closedAt: r.closed_at,
  outcome: r.outcome,
});


export class PgPeerRights implements PeerRightsStoreApi {
  constructor(
    private readonly db: PgDb,
    private readonly reporters: AsyncPeerReporterLookup,
    private readonly now: () => number = Date.now,
    /** Called once per event, after it is stored, for the admin and server logs. It may be async: the step waits for it. */
    private readonly trail: (t: RightsTrail) => void | Promise<void> = () => {},
  ) {}

  /**
   * The checks every write that joins two reporters makes. `owner` is the person acting from the browser or a session,
   * who must own both; null is an Admin acting. Returns the owner's name as the server stored it.
   */
  private async pair(owner: string | null, a: string, b: string): Promise<{ ok: true; owner: string } | Refusal> {
    const ra = await this.reporters.get(a);
    const rb = a === b ? ra : await this.reporters.get(b);
    if (!ra || !rb) return refuse(404, 'no such reporter');
    if (!eligible(ra) || !eligible(rb)) return refuse(403, NO_ADMIN);
    if (owner !== null && (nameKey(owner) !== nameKey(ra.owner) || nameKey(owner) !== nameKey(rb.owner))) return refuse(403, 'not your reporter');
    if (nameKey(ra.owner) !== nameKey(rb.owner)) return refuse(403, 'a link can only join two reporters with the same owner');
    return { ok: true, owner: ra.owner };
  }

  // ---- defaults and limits -----------------------------------------------------------------------------------

  async defaults(owner: string): Promise<OwnerDefaults> {
    const r = await this.db.get<DbDefaults>('SELECT trust, on_request, new_send, limits_json FROM peer_owner_settings WHERE owner_lower = ?', [nameKey(owner)]);
    if (!r) return { ...OWNER_DEFAULTS, limits: {} };
    let saved: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(r.limits_json ?? '{}');
      if (isObj(parsed)) saved = parsed;
    } catch {
      saved = {};
    }
    const limits: Partial<PeerLimits> = {};
    for (const k of PEER_LIMIT_KEYS) if (peerSettingError(k, saved[k]) === null) limits[k] = saved[k] as number;
    return {
      trust: r.trust === 1,
      onRequest: ON_REQUEST.find((v) => v === r.on_request) ?? OWNER_DEFAULTS.onRequest,
      newSend: NEW_SEND.find((v) => v === r.new_send) ?? OWNER_DEFAULTS.newSend,
      limits,
    };
  }

  /** Applies a `limits` patch to `into`, each value at most the Admin's; null removes one. Returns the error, or null. */
  private static patchLimits(into: Partial<PeerLimits>, v: unknown, server: PeerLimits): string | null {
    if (!isObj(v)) return 'limits must be an object';
    for (const [k, value] of Object.entries(v)) {
      const key = PEER_LIMIT_KEYS.find((x) => x === k);
      if (!key) return `unknown limit: ${k}`;
      if (value === null) {
        delete into[key];
        continue;
      }
      const err = peerSettingError(key, value, server[key]);
      if (err) return err;
      into[key] = value as number;
    }
    return null;
  }

  setDefaults(owner: string, patch: Record<string, unknown>, server: PeerLimits, actor: Actor): Promise<{ ok: true; defaults: OwnerDefaults } | Refusal> {
    return this.db.tx(async () => {
      if (!isObj(patch) || !Object.keys(patch).length) return refuse(400, 'nothing to change');
      const next = await this.defaults(owner);
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'trust') {
          if (typeof v !== 'boolean') return refuse(400, 'trust must be true or false');
          next.trust = v;
        } else if (k === 'onRequest') {
          const on = ON_REQUEST.find((x) => x === v);
          if (!on) return refuse(400, 'onRequest must be ask, allow or decline');
          next.onRequest = on;
        } else if (k === 'newSend') {
          const ns = NEW_SEND.find((x) => x === v);
          if (!ns) return refuse(400, 'newSend must be ask or send');
          next.newSend = ns;
        } else if (k === 'limits') {
          const err = PgPeerRights.patchLimits(next.limits, v, server);
          if (err) return refuse(400, err);
        } else {
          return refuse(400, `unknown setting: ${k}`);
        }
      }
      await this.db.run(
        `INSERT INTO peer_owner_settings (owner_lower, trust, on_request, new_send, limits_json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(owner_lower) DO UPDATE SET trust = excluded.trust, on_request = excluded.on_request,
           new_send = excluded.new_send, limits_json = excluded.limits_json`,
        [nameKey(owner), Number(next.trust), next.onRequest, next.newSend, JSON.stringify(next.limits)],
      );
      await this.trail({ kind: 'defaults', owner, actor });
      return { ok: true as const, defaults: next };
    });
  }

  async limits(owner: string, server: PeerLimits): Promise<PeerLimits> {
    const own = (await this.defaults(owner)).limits;
    return {
      roundTrips: Math.min(server.roundTrips, own.roundTrips ?? server.roundTrips),
      perMinute: Math.min(server.perMinute, own.perMinute ?? server.perMinute),
      maxChars: Math.min(server.maxChars, own.maxChars ?? server.maxChars),
    };
  }

  // ---- rights ------------------------------------------------------------------------------------------------

  private async row(from: string, to: string): Promise<RightRow | null> {
    const r = await this.db.get<DbRight>('SELECT * FROM peer_rights WHERE from_key = ? AND to_key = ?', [from, to]);
    return r ? toRight(r) : null;
  }

  private async write(from: string, to: string, owner: string, level: PeerLevel, paused: boolean): Promise<RightRow> {
    const setAt = this.now();
    await this.db.run(
      `INSERT INTO peer_rights (from_key, to_key, owner, level, paused, set_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(from_key, to_key) DO UPDATE SET owner = excluded.owner, level = excluded.level, paused = excluded.paused, set_at = excluded.set_at`,
      [from, to, owner, level, Number(paused), setAt],
    );
    return { from, to, owner, level, paused, setAt };
  }

  private async drop(from: string, to: string): Promise<void> {
    await this.db.run('DELETE FROM peer_rights WHERE from_key = ? AND to_key = ?', [from, to]);
  }

  /** Gives `from` at least `level` to `to`, keeping a pause and never lowering what is there. */
  private async raise(from: string, to: string, owner: string, level: PeerLevel): Promise<{ right: RightRow; changed: boolean }> {
    const had = await this.row(from, to);
    if (had && RANK[had.level] >= RANK[level]) return { right: had, changed: false };
    return { right: await this.write(from, to, owner, level, had?.paused ?? false), changed: true };
  }

  /** Pauses or resumes every direction of a link. A pause with no right yet is kept as a `none` row so it holds; a resume drops such rows. */
  private async pausePair(owner: string, a: string, b: string, paused: boolean): Promise<void> {
    for (const [f, t] of directions(a, b)) {
      const had = await this.row(f, t);
      if (paused) await this.write(f, t, owner, had?.level ?? 'none', true);
      else if (had?.level === 'none') await this.drop(f, t);
      else if (had) await this.write(f, t, owner, had.level, false);
    }
  }

  async effective(from: string, to: string): Promise<EffectiveRight> {
    const p = await this.pair(null, from, to);
    if (!p.ok) return { level: 'none', paused: false };
    const had = await this.row(from, to);
    return { level: (await this.defaults(p.owner)).trust ? 'send' : (had?.level ?? 'none'), paused: had?.paused ?? false };
  }

  /** Owners are compared with `nameKey` in JS, the way the SQLite store does, so one rule folds case on every adapter. */
  async rightsOf(owner: string): Promise<RightRow[]> {
    const key = nameKey(owner);
    return (await this.db.all<DbRight>('SELECT * FROM peer_rights ORDER BY from_key, to_key')).filter((r) => nameKey(r.owner) === key).map(toRight);
  }

  setRight(owner: string, from: string, to: string, level: PeerLevel, actor: Actor): Promise<{ ok: true; right: RightRow | null } | Refusal> {
    return this.db.tx(async () => {
      if (!PEER_LEVELS.includes(level)) return refuse(400, 'level must be none, see, ask or send');
      const p = await this.pair(owner, from, to);
      if (!p.ok) return p;
      const paused = (await this.row(from, to))?.paused ?? false;
      let right: RightRow | null = null;
      if (level === 'none' && !paused) await this.drop(from, to);
      else right = await this.write(from, to, p.owner, level, paused);
      await this.trail({ kind: 'set', right: right ?? { from, to, owner: p.owner, level: 'none' }, actor });
      return { ok: true as const, right };
    });
  }

  pauseLink(owner: string | null, a: string, b: string, paused: boolean, actor: Actor): Promise<{ ok: true } | Refusal> {
    return this.db.tx(async () => {
      const p = await this.pair(owner, a, b);
      if (!p.ok) return p;
      await this.db.savepoint('peer_rights', () => this.pausePair(p.owner, a, b, paused));
      await this.trail({ kind: paused ? 'paused' : 'resumed', owner: p.owner, a, b, actor });
      return { ok: true as const };
    });
  }

  removeLink(owner: string | null, a: string, b: string, actor: Actor): Promise<{ ok: true } | Refusal> {
    return this.db.tx(async () => {
      const p = await this.pair(owner, a, b);
      if (!p.ok) return p;
      // Under Trust a link with no rows can still send, so a removal leaves it paused instead, or it would not hold.
      const trust = (await this.defaults(p.owner)).trust;
      await this.db.savepoint('peer_rights', async () => {
        for (const [f, t] of directions(a, b)) {
          if (trust) await this.write(f, t, p.owner, 'none', true);
          else await this.drop(f, t);
        }
      });
      await this.trail({ kind: 'removed', owner: p.owner, a, b, actor });
      return { ok: true as const };
    });
  }

  pauseReporter(key: string, paused: boolean, actor: Actor): Promise<{ ok: true; links: number } | Refusal> {
    return this.db.tx(async () => {
      const r = await this.reporters.get(key);
      if (!r) return refuse(404, 'no such reporter');
      if (!eligible(r)) return refuse(403, NO_ADMIN);
      const others = new Set([key, ...(await this.reporters.ofOwner(r.owner)).filter(eligible).map((o) => o.key)]);
      await this.db.savepoint('peer_rights', async () => {
        for (const o of others) await this.pausePair(r.owner, key, o, paused);
      });
      for (const o of others) await this.trail({ kind: paused ? 'paused' : 'resumed', owner: r.owner, a: key, b: o, actor });
      return { ok: true as const, links: others.size };
    });
  }

  // ---- requests ----------------------------------------------------------------------------------------------

  private async insertRequest(r: Omit<PeerRequestRow, 'id' | 'createdAt' | 'closedAt' | 'outcome'>): Promise<PeerRequestRow> {
    const row: PeerRequestRow = { ...r, id: `prq_${randomBytes(12).toString('hex')}`, createdAt: this.now(), closedAt: null, outcome: null };
    await this.db.run(
      `INSERT INTO peer_requests (id, owner, kind, from_key, to_key, level, reason, by, from_session, message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.owner, row.kind, row.fromKey, row.toKey, row.level, row.reason, row.by, row.fromSession, row.messageId, row.createdAt],
    );
    return row;
  }

  private async close(req: PeerRequestRow, outcome: NonNullable<PeerRequestRow['outcome']>): Promise<PeerRequestRow> {
    const closedAt = this.now();
    await this.db.run('UPDATE peer_requests SET closed_at = ?, outcome = ? WHERE id = ?', [closedAt, outcome, req.id]);
    return { ...req, closedAt, outcome };
  }

  propose(from: string, to: string, level: PeerLevel, actor: Actor): Promise<{ ok: true; request: PeerRequestRow } | Refusal> {
    return this.db.tx(async () => {
      if (level === 'none' || !PEER_LEVELS.includes(level)) return refuse(400, 'level must be see, ask or send');
      const p = await this.pair(null, from, to);
      if (!p.ok) return p;
      // A proposal only ever raises a right: the owner lowers or removes one themselves (SPEC 7.7).
      const stored = (await this.row(from, to))?.level ?? 'none';
      if (RANK[level] <= RANK[stored]) return refuse(409, `a proposal must raise the right; it is already ${stored}`);
      const open = await this.db.get<DbRequest>("SELECT * FROM peer_requests WHERE kind = 'proposal' AND from_key = ? AND to_key = ? AND closed_at IS NULL", [from, to]);
      let request: PeerRequestRow;
      if (open) {
        // One open proposal per direction: proposing again changes it rather than asking the owner twice.
        request = { ...toRequest(open), level, createdAt: this.now() };
        await this.db.run('UPDATE peer_requests SET level = ?, created_at = ? WHERE id = ?', [level, request.createdAt, request.id]);
      } else {
        request = await this.insertRequest({ owner: p.owner, kind: 'proposal', fromKey: from, toKey: to, level, reason: null, by: ADMIN_OWNER, fromSession: null, messageId: null });
      }
      await this.trail({ kind: 'proposed', request, actor });
      return { ok: true as const, request };
    });
  }

  requestAccess(input: { owner: string; fromKey: string; toKey: string; right: 'see' | 'send'; reason: string; by: string; fromSession: string }): Promise<AccessOutcome | Refusal> {
    return this.db.tx(async () => {
      if (input.right !== 'see' && input.right !== 'send') return refuse(400, 'right must be see or send');
      if (typeof input.reason !== 'string') return refuse(400, 'reason must be text');
      const reason = cleanReason(input.reason);
      if (reason.length > PEER_LIMITS.reason) return refuse(400, `the reason must be at most ${PEER_LIMITS.reason} characters`);
      const p = await this.pair(input.owner, input.fromKey, input.toKey);
      if (!p.ok) return p;
      const d = await this.defaults(p.owner);
      const level: PeerLevel = input.right === 'see' ? 'see' : d.newSend;
      if (d.onRequest === 'decline') return { ok: true as const, state: 'declined' as const };
      if (d.onRequest === 'allow') {
        const { right, changed } = await this.raise(input.fromKey, input.toKey, p.owner, level);
        if (changed) await this.trail({ kind: 'set', right, actor: { name: p.owner, admin: false } });
        return { ok: true as const, state: 'allowed' as const, applied: right };
      }
      const same = await this.db.get<DbRequest>(
        `SELECT * FROM peer_requests WHERE kind = 'access' AND from_key = ? AND to_key = ? AND level = ? AND reason IS NOT DISTINCT FROM ? AND from_session = ? AND closed_at IS NULL`,
        [input.fromKey, input.toKey, level, reason || null, input.fromSession],
      );
      if (same) return { ok: true as const, state: 'asked' as const, request: toRequest(same) };
      const request = await this.insertRequest({
        owner: p.owner,
        kind: 'access',
        fromKey: input.fromKey,
        toKey: input.toKey,
        level,
        reason: reason || null,
        by: input.by,
        fromSession: input.fromSession,
        messageId: null,
      });
      await this.trail({ kind: 'access-requested', request });
      return { ok: true as const, state: 'asked' as const, request };
    });
  }

  openMessageRequest(input: { owner: string; fromKey: string; toKey: string; by: string; fromSession: string; messageId: string }): Promise<PeerRequestRow> {
    return this.insertRequest({ owner: input.owner, kind: 'message', fromKey: input.fromKey, toKey: input.toKey, level: null, reason: null, by: input.by, fromSession: input.fromSession, messageId: input.messageId });
  }

  async closeMessageRequest(messageId: string, outcome: 'delivered' | 'dropped' | 'declined'): Promise<void> {
    await this.db.run("UPDATE peer_requests SET closed_at = ?, outcome = ? WHERE kind = 'message' AND message_id = ? AND closed_at IS NULL", [this.now(), outcome, messageId]);
  }

  async openRequests(owner: string, about?: string): Promise<PeerRequestRow[]> {
    // The owner is compared in JS (see rightsOf), so one rule folds case on every adapter.
    const key = nameKey(owner);
    const rows =
      about === undefined
        ? await this.db.all<DbRequest>('SELECT * FROM peer_requests WHERE closed_at IS NULL ORDER BY created_at, id')
        : await this.db.all<DbRequest>('SELECT * FROM peer_requests WHERE closed_at IS NULL AND (from_key = ? OR to_key = ?) ORDER BY created_at, id', [about, about]);
    return rows.filter((r) => nameKey(r.owner) === key).map(toRequest);
  }

  async getRequest(id: string): Promise<PeerRequestRow | null> {
    const r = await this.db.get<DbRequest>('SELECT * FROM peer_requests WHERE id = ?', [id]);
    return r ? toRequest(r) : null;
  }

  answer(id: string, owner: string, answer: PeerAnswer, actor: Actor): Promise<AnswerOutcome | Refusal> {
    return this.db.tx(async () => {
      const req = await this.getRequest(id);
      if (!req) return refuse(404, 'no such request');
      if (nameKey(owner) !== nameKey(req.owner)) return refuse(403, 'not your request');
      if (req.closedAt !== null) return refuse(410, `already ${req.outcome}`);
      if (!PEER_ANSWERS.includes(answer)) return refuse(422, 'the answer must be allow, decline or deliver');
      if (req.kind === 'message') {
        if (answer === 'allow') return refuse(422, 'a message is delivered or declined');
        const deliver = answer === 'deliver';
        // No trail: the message store logs what became of the message.
        return { ok: true as const, request: await this.close(req, deliver ? 'delivered' : 'declined'), message: { id: req.messageId as string, deliver } };
      }
      if (answer === 'deliver') return refuse(422, `${req.kind === 'proposal' ? 'a proposal' : 'a request for access'} is allowed or declined`);
      if (answer === 'decline') {
        const request = await this.close(req, 'declined');
        await this.trail({ kind: 'declined', request, actor });
        return { ok: true as const, request, applied: null };
      }
      const p = await this.pair(owner, req.fromKey, req.toKey);
      if (!p.ok) return p;
      const level = req.level as PeerLevel;
      // Neither an accepted proposal nor an allowed access request lowers a right, even one that rose after it was made.
      const applied = (await this.raise(req.fromKey, req.toKey, p.owner, level)).right;
      const request = await this.close(req, 'allowed');
      await this.trail({ kind: 'accepted', request, actor });
      return { ok: true as const, request, applied };
    });
  }

  retain(cutoff: number): Promise<number> {
    return this.db.tx(async () => {
      // A message deleted by retention or with its session would otherwise leave its approval request open for good.
      await this.db.run(
        "UPDATE peer_requests SET closed_at = ?, outcome = 'dropped' WHERE kind = 'message' AND closed_at IS NULL AND message_id NOT IN (SELECT id FROM peer_messages)",
        [this.now()],
      );
      let n = await this.db.run('DELETE FROM peer_requests WHERE closed_at IS NOT NULL AND closed_at < ?', [cutoff]);
      const keys = await this.db.all<{ k: string }>(
        'SELECT from_key AS k FROM peer_requests UNION SELECT to_key FROM peer_requests UNION SELECT from_key FROM peer_rights UNION SELECT to_key FROM peer_rights',
      );
      for (const { k } of keys) {
        if (await this.reporters.get(k)) continue;
        n += await this.db.run('DELETE FROM peer_requests WHERE from_key = ? OR to_key = ?', [k, k]);
        await this.db.run('DELETE FROM peer_rights WHERE from_key = ? OR to_key = ?', [k, k]);
      }
      return n;
    });
  }
}
