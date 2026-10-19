// Orchestrator messaging (#347, #412): the rights between one owner's reporters, each owner's defaults and stricter
// limits, and the requests the owner answers (SPEC 7.7, DECISIONS 37). Every write that joins two reporters checks,
// here and whatever the settings say, that both belong to the same person and neither reports with the admin secret;
// a refusal stores nothing. Text in a request (an orchestrator's reason) is never logged here: trails carry rows, and
// the routes decide what goes in a log line. All statements are parameterized.
import { randomBytes } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { PEER_ANSWERS, PEER_LEVELS, PEER_LIMITS, type PeerAnswer, type PeerLevel, type PeerRequestKind } from './protocol.js';
import { ADMIN_OWNER, nameKey } from './people.js';
import { PEER_LIMIT_KEYS, peerSettingError, type PeerLimits } from './peerSettings.js';
import {
  OWNER_DEFAULTS,
  refuse,
  type AccessOutcome,
  type Actor,
  type AnswerOutcome,
  type EffectiveRight,
  type OwnerDefaults,
  type PeerRequestRow,
  type PeerRightsApi,
  type Refusal,
  type ReporterLookup,
  type ReporterRef,
  type RightRow,
  type RightsTrail,
} from './peerTypes.js';

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

export class PeerRights implements PeerRightsApi {
  private readonly stmts = new Map<string, StatementSync>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly reporters: ReporterLookup,
    private readonly now: () => number = Date.now,
    /** Called once per event, after it is stored, for the admin and server logs. */
    private readonly trail: (t: RightsTrail) => void = () => {},
  ) {}

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** Runs `fn` as one step. A savepoint, so it nests inside a transaction the caller may already hold. */
  private tx(fn: () => void): void {
    this.db.exec('SAVEPOINT peer_rights');
    try {
      fn();
      this.db.exec('RELEASE peer_rights');
    } catch (err) {
      this.db.exec('ROLLBACK TO peer_rights');
      this.db.exec('RELEASE peer_rights');
      throw err;
    }
  }

  /**
   * The checks every write that joins two reporters makes. `owner` is the person acting from the browser or a session,
   * who must own both; null is an Admin acting. Returns the owner's name as the server stored it.
   */
  private pair(owner: string | null, a: string, b: string): { ok: true; owner: string } | Refusal {
    const ra = this.reporters.get(a);
    const rb = a === b ? ra : this.reporters.get(b);
    if (!ra || !rb) return refuse(404, 'no such reporter');
    if (!eligible(ra) || !eligible(rb)) return refuse(403, NO_ADMIN);
    if (owner !== null && (nameKey(owner) !== nameKey(ra.owner) || nameKey(owner) !== nameKey(rb.owner))) return refuse(403, 'not your reporter');
    if (nameKey(ra.owner) !== nameKey(rb.owner)) return refuse(403, 'a link can only join two reporters with the same owner');
    return { ok: true, owner: ra.owner };
  }

  // ---- defaults and limits -----------------------------------------------------------------------------------

  defaults(owner: string): OwnerDefaults {
    const r = this.stmt('SELECT trust, on_request, new_send, limits_json FROM peer_owner_settings WHERE owner_lower = ?').get(nameKey(owner)) as
      | DbDefaults
      | undefined;
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

  setDefaults(owner: string, patch: Record<string, unknown>, server: PeerLimits, actor: Actor): { ok: true; defaults: OwnerDefaults } | Refusal {
    if (!isObj(patch) || !Object.keys(patch).length) return refuse(400, 'nothing to change');
    const next = this.defaults(owner);
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
        const err = PeerRights.patchLimits(next.limits, v, server);
        if (err) return refuse(400, err);
      } else {
        return refuse(400, `unknown setting: ${k}`);
      }
    }
    this.stmt(
      `INSERT INTO peer_owner_settings (owner_lower, trust, on_request, new_send, limits_json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(owner_lower) DO UPDATE SET trust = excluded.trust, on_request = excluded.on_request,
         new_send = excluded.new_send, limits_json = excluded.limits_json`,
    ).run(nameKey(owner), Number(next.trust), next.onRequest, next.newSend, JSON.stringify(next.limits));
    this.trail({ kind: 'defaults', owner, actor });
    return { ok: true, defaults: next };
  }

  limits(owner: string, server: PeerLimits): PeerLimits {
    const own = this.defaults(owner).limits;
    return {
      roundTrips: Math.min(server.roundTrips, own.roundTrips ?? server.roundTrips),
      perMinute: Math.min(server.perMinute, own.perMinute ?? server.perMinute),
      maxChars: Math.min(server.maxChars, own.maxChars ?? server.maxChars),
    };
  }

  // ---- rights ------------------------------------------------------------------------------------------------

  private row(from: string, to: string): RightRow | null {
    const r = this.stmt('SELECT * FROM peer_rights WHERE from_key = ? AND to_key = ?').get(from, to) as DbRight | undefined;
    return r ? toRight(r) : null;
  }

  private write(from: string, to: string, owner: string, level: PeerLevel, paused: boolean): RightRow {
    const setAt = this.now();
    this.stmt(
      `INSERT INTO peer_rights (from_key, to_key, owner, level, paused, set_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(from_key, to_key) DO UPDATE SET owner = excluded.owner, level = excluded.level, paused = excluded.paused, set_at = excluded.set_at`,
    ).run(from, to, owner, level, Number(paused), setAt);
    return { from, to, owner, level, paused, setAt };
  }

  private drop(from: string, to: string): void {
    this.stmt('DELETE FROM peer_rights WHERE from_key = ? AND to_key = ?').run(from, to);
  }

  /** Gives `from` at least `level` to `to`, keeping a pause and never lowering what is there. */
  private raise(from: string, to: string, owner: string, level: PeerLevel): { right: RightRow; changed: boolean } {
    const had = this.row(from, to);
    if (had && RANK[had.level] >= RANK[level]) return { right: had, changed: false };
    return { right: this.write(from, to, owner, level, had?.paused ?? false), changed: true };
  }

  /** Pauses or resumes every direction of a link. A pause with no right yet is kept as a `none` row so it holds; a resume drops such rows. */
  private pausePair(owner: string, a: string, b: string, paused: boolean): void {
    for (const [f, t] of directions(a, b)) {
      const had = this.row(f, t);
      if (paused) this.write(f, t, owner, had?.level ?? 'none', true);
      else if (had?.level === 'none') this.drop(f, t);
      else if (had) this.write(f, t, owner, had.level, false);
    }
  }

  effective(from: string, to: string): EffectiveRight {
    const p = this.pair(null, from, to);
    if (!p.ok) return { level: 'none', paused: false };
    const had = this.row(from, to);
    return { level: this.defaults(p.owner).trust ? 'send' : (had?.level ?? 'none'), paused: had?.paused ?? false };
  }

  /** Owners are compared with `nameKey` in JS: SQLite's lower() folds only ASCII, so `Émile` would never match `émile`. */
  rightsOf(owner: string): RightRow[] {
    const key = nameKey(owner);
    return (this.stmt('SELECT * FROM peer_rights ORDER BY from_key, to_key').all() as unknown as DbRight[]).filter((r) => nameKey(r.owner) === key).map(toRight);
  }

  setRight(owner: string, from: string, to: string, level: PeerLevel, actor: Actor): { ok: true; right: RightRow | null } | Refusal {
    if (!PEER_LEVELS.includes(level)) return refuse(400, 'level must be none, see, ask or send');
    const p = this.pair(owner, from, to);
    if (!p.ok) return p;
    const paused = this.row(from, to)?.paused ?? false;
    let right: RightRow | null = null;
    if (level === 'none' && !paused) this.drop(from, to);
    else right = this.write(from, to, p.owner, level, paused);
    this.trail({ kind: 'set', right: right ?? { from, to, owner: p.owner, level: 'none' }, actor });
    return { ok: true, right };
  }

  pauseLink(owner: string | null, a: string, b: string, paused: boolean, actor: Actor): { ok: true } | Refusal {
    const p = this.pair(owner, a, b);
    if (!p.ok) return p;
    this.tx(() => this.pausePair(p.owner, a, b, paused));
    this.trail({ kind: paused ? 'paused' : 'resumed', owner: p.owner, a, b, actor });
    return { ok: true };
  }

  removeLink(owner: string | null, a: string, b: string, actor: Actor): { ok: true } | Refusal {
    const p = this.pair(owner, a, b);
    if (!p.ok) return p;
    // Under Trust a link with no rows can still send, so a removal leaves it paused instead, or it would not hold.
    const trust = this.defaults(p.owner).trust;
    this.tx(() => {
      for (const [f, t] of directions(a, b)) {
        if (trust) this.write(f, t, p.owner, 'none', true);
        else this.drop(f, t);
      }
    });
    this.trail({ kind: 'removed', owner: p.owner, a, b, actor });
    return { ok: true };
  }

  pauseReporter(key: string, paused: boolean, actor: Actor): { ok: true; links: number } | Refusal {
    const r = this.reporters.get(key);
    if (!r) return refuse(404, 'no such reporter');
    if (!eligible(r)) return refuse(403, NO_ADMIN);
    const others = new Set([key, ...this.reporters.ofOwner(r.owner).filter(eligible).map((o) => o.key)]);
    this.tx(() => {
      for (const o of others) this.pausePair(r.owner, key, o, paused);
    });
    for (const o of others) this.trail({ kind: paused ? 'paused' : 'resumed', owner: r.owner, a: key, b: o, actor });
    return { ok: true, links: others.size };
  }

  // ---- requests ----------------------------------------------------------------------------------------------

  private insertRequest(r: Omit<PeerRequestRow, 'id' | 'createdAt' | 'closedAt' | 'outcome'>): PeerRequestRow {
    const row: PeerRequestRow = { ...r, id: `prq_${randomBytes(12).toString('hex')}`, createdAt: this.now(), closedAt: null, outcome: null };
    this.stmt(
      `INSERT INTO peer_requests (id, owner, kind, from_key, to_key, level, reason, by, from_session, message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.owner, row.kind, row.fromKey, row.toKey, row.level, row.reason, row.by, row.fromSession, row.messageId, row.createdAt);
    return row;
  }

  private close(req: PeerRequestRow, outcome: NonNullable<PeerRequestRow['outcome']>): PeerRequestRow {
    const closedAt = this.now();
    this.stmt('UPDATE peer_requests SET closed_at = ?, outcome = ? WHERE id = ?').run(closedAt, outcome, req.id);
    return { ...req, closedAt, outcome };
  }

  propose(from: string, to: string, level: PeerLevel, actor: Actor): { ok: true; request: PeerRequestRow } | Refusal {
    if (level === 'none' || !PEER_LEVELS.includes(level)) return refuse(400, 'level must be see, ask or send');
    const p = this.pair(null, from, to);
    if (!p.ok) return p;
    const open = this.stmt("SELECT * FROM peer_requests WHERE kind = 'proposal' AND from_key = ? AND to_key = ? AND closed_at IS NULL").get(from, to) as
      | DbRequest
      | undefined;
    let request: PeerRequestRow;
    if (open) {
      // One open proposal per direction: proposing again changes it rather than asking the owner twice.
      request = { ...toRequest(open), level, createdAt: this.now() };
      this.stmt('UPDATE peer_requests SET level = ?, created_at = ? WHERE id = ?').run(level, request.createdAt, request.id);
    } else {
      request = this.insertRequest({ owner: p.owner, kind: 'proposal', fromKey: from, toKey: to, level, reason: null, by: ADMIN_OWNER, fromSession: null, messageId: null });
    }
    this.trail({ kind: 'proposed', request, actor });
    return { ok: true, request };
  }

  requestAccess(input: { owner: string; fromKey: string; toKey: string; right: 'see' | 'send'; reason: string; by: string; fromSession: string }): AccessOutcome | Refusal {
    if (input.right !== 'see' && input.right !== 'send') return refuse(400, 'right must be see or send');
    if (typeof input.reason !== 'string') return refuse(400, 'reason must be text');
    const reason = cleanReason(input.reason);
    if (reason.length > PEER_LIMITS.reason) return refuse(400, `the reason must be at most ${PEER_LIMITS.reason} characters`);
    const p = this.pair(input.owner, input.fromKey, input.toKey);
    if (!p.ok) return p;
    const d = this.defaults(p.owner);
    const level: PeerLevel = input.right === 'see' ? 'see' : d.newSend;
    if (d.onRequest === 'decline') return { ok: true, state: 'declined' };
    if (d.onRequest === 'allow') {
      const { right, changed } = this.raise(input.fromKey, input.toKey, p.owner, level);
      if (changed) this.trail({ kind: 'set', right, actor: { name: p.owner, admin: false } });
      return { ok: true, state: 'allowed', applied: right };
    }
    const same = this.stmt(
      `SELECT * FROM peer_requests WHERE kind = 'access' AND from_key = ? AND to_key = ? AND level = ? AND reason IS ? AND from_session = ? AND closed_at IS NULL`,
    ).get(input.fromKey, input.toKey, level, reason || null, input.fromSession) as DbRequest | undefined;
    if (same) return { ok: true, state: 'asked', request: toRequest(same) };
    const request = this.insertRequest({
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
    this.trail({ kind: 'access-requested', request });
    return { ok: true, state: 'asked', request };
  }

  openMessageRequest(input: { owner: string; fromKey: string; toKey: string; by: string; fromSession: string; messageId: string }): PeerRequestRow {
    return this.insertRequest({ owner: input.owner, kind: 'message', fromKey: input.fromKey, toKey: input.toKey, level: null, reason: null, by: input.by, fromSession: input.fromSession, messageId: input.messageId });
  }

  closeMessageRequest(messageId: string, outcome: 'delivered' | 'dropped' | 'declined'): void {
    this.stmt("UPDATE peer_requests SET closed_at = ?, outcome = ? WHERE kind = 'message' AND message_id = ? AND closed_at IS NULL").run(this.now(), outcome, messageId);
  }

  openRequests(owner: string, about?: string): PeerRequestRow[] {
    // The owner is compared in JS (see rightsOf): SQLite's lower() folds only ASCII.
    const key = nameKey(owner);
    const rows =
      about === undefined
        ? this.stmt('SELECT * FROM peer_requests WHERE closed_at IS NULL ORDER BY created_at, id').all()
        : this.stmt('SELECT * FROM peer_requests WHERE closed_at IS NULL AND (from_key = ? OR to_key = ?) ORDER BY created_at, id').all(about, about);
    return (rows as unknown as DbRequest[]).filter((r) => nameKey(r.owner) === key).map(toRequest);
  }

  getRequest(id: string): PeerRequestRow | null {
    const r = this.stmt('SELECT * FROM peer_requests WHERE id = ?').get(id) as DbRequest | undefined;
    return r ? toRequest(r) : null;
  }

  answer(id: string, owner: string, answer: PeerAnswer, actor: Actor): AnswerOutcome | Refusal {
    const req = this.getRequest(id);
    if (!req) return refuse(404, 'no such request');
    if (nameKey(owner) !== nameKey(req.owner)) return refuse(403, 'not your request');
    if (req.closedAt !== null) return refuse(410, `already ${req.outcome}`);
    if (!PEER_ANSWERS.includes(answer)) return refuse(422, 'the answer must be allow, decline or deliver');
    if (req.kind === 'message') {
      if (answer === 'allow') return refuse(422, 'a message is delivered or declined');
      const deliver = answer === 'deliver';
      // No trail: the message store logs what became of the message.
      return { ok: true, request: this.close(req, deliver ? 'delivered' : 'declined'), message: { id: req.messageId as string, deliver } };
    }
    if (answer === 'deliver') return refuse(422, `${req.kind === 'proposal' ? 'a proposal' : 'a request for access'} is allowed or declined`);
    if (answer === 'decline') {
      const request = this.close(req, 'declined');
      this.trail({ kind: 'declined', request, actor });
      return { ok: true, request, applied: null };
    }
    const p = this.pair(owner, req.fromKey, req.toKey);
    if (!p.ok) return p;
    const level = req.level as PeerLevel;
    // A proposal is what the Admin set out and the owner accepted, as is; an allowed access request never lowers a right.
    const applied =
      req.kind === 'proposal' ? this.write(req.fromKey, req.toKey, p.owner, level, this.row(req.fromKey, req.toKey)?.paused ?? false) : this.raise(req.fromKey, req.toKey, p.owner, level).right;
    const request = this.close(req, 'allowed');
    this.trail({ kind: 'accepted', request, actor });
    return { ok: true, request, applied };
  }

  retain(cutoff: number): number {
    // A message deleted by retention or with its session would otherwise leave its approval request open for good.
    this.stmt(
      "UPDATE peer_requests SET closed_at = ?, outcome = 'dropped' WHERE kind = 'message' AND closed_at IS NULL AND message_id NOT IN (SELECT id FROM peer_messages)",
    ).run(this.now());
    let n = Number(this.stmt('DELETE FROM peer_requests WHERE closed_at IS NOT NULL AND closed_at < ?').run(cutoff).changes);
    const keys = this.stmt(
      'SELECT from_key AS k FROM peer_requests UNION SELECT to_key FROM peer_requests UNION SELECT from_key FROM peer_rights UNION SELECT to_key FROM peer_rights',
    ).all() as unknown as { k: string }[];
    for (const { k } of keys) {
      if (this.reporters.get(k)) continue;
      n += Number(this.stmt('DELETE FROM peer_requests WHERE from_key = ? OR to_key = ?').run(k, k).changes);
      this.stmt('DELETE FROM peer_rights WHERE from_key = ? OR to_key = ?').run(k, k);
    }
    return n;
  }
}
