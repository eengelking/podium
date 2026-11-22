// Orchestrator messaging (#347, #412): the rights between one owner's reporters, each owner's defaults and stricter
// limits, and the requests the owner answers (SPEC 7.7, DECISIONS 37). Every write that joins two reporters checks,
// here and whatever the settings say, that both belong to the same person and neither reports with the admin secret;
// a refusal stores nothing. Text in a request (an orchestrator's reason) is never logged here: trails carry rows, and
// the routes decide what goes in a log line. All statements are parameterized.
import { randomBytes } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { PEER_ANSWERS, PEER_LEVELS, PEER_LIMITS, type PeerAnswer, type PeerLevel, type PeerRequestKind } from '../../fleet/protocol.js';
import {
  isPersonKey,
  personKeyOf,
  refuse,
  type LinkPauser,
  type PersonLinkOp,
  type AccessOutcome,
  type Actor,
  type AnswerOutcome,
  type EffectiveRight,
  type OwnerDefaults,
  type PeerRequestRow,
  type PeerRightsApi,
  type Refusal,
  type ReporterLookup,
  type RightRow,
  type RightsTrail,
} from '../../fleet/peerTypes.js';
import { ADMIN_OWNER } from '../rows.js';
import { chunksOf } from '../batches.js';
import { ON_REQUEST, NEW_SEND, distinctOwners, eligible, effectivesOf, isObj, limitsOf, limitsOfMany, rightKey, toDefaults, trustOwners, type DbDefaults } from '../peerRightsRows.js';
import { PEER_LIMIT_KEYS, peerSettingError, type PeerLimits } from '../settings.js';

/** How far each level reaches, so a request that is allowed never lowers a right the owner already gave. */
const RANK: Record<PeerLevel, number> = { none: 0, see: 1, ask: 2, send: 3 };
const ADMIN_PAUSED = 'An Administrator paused this link, so only an Administrator can resume it.';
const NO_ADMIN = 'a reporter on the admin secret cannot take part';

interface DbRight {
  from_key: string;
  to_key: string;
  owner: string;
  owner_id: number | null;
  level: PeerLevel;
  paused: number;
  paused_by: string | null;
  paused_by_admin: string | null;
  set_at: number;
}

interface DbRequest {
  id: string;
  owner: string;
  owner_id: number | null;
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

/** The owner a write is made for: the name as recorded (display text) and the `people.id` that binds it (#1284). */
type Who = { owner: string; ownerId: number };

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

const toRight = (r: DbRight): RightRow => ({ from: r.from_key, to: r.to_key, owner: r.owner, level: r.level, paused: r.paused === 1, ...(r.paused === 1 && r.paused_by ? { pausedBy: r.paused_by as LinkPauser } : {}), ...(r.paused === 1 && r.paused_by === 'admin' && r.paused_by_admin ? { pausedByAdmin: r.paused_by_admin } : {}), setAt: r.set_at });

const toRequest = (r: DbRequest): PeerRequestRow => ({
  id: r.id,
  owner: r.owner,
  ownerId: r.owner_id == null ? null : Number(r.owner_id),
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
   * The checks every write that joins two reporters makes. `ownerId` is the `people.id` of the person acting from the browser or a session,
   * who must own both; null is an Admin acting. Returns the owner as the server stored it: the name (display) and the id (#1284).
   */
  private pair(ownerId: number | null, a: string, b: string): ({ ok: true } & Who) | Refusal {
    const ra = this.reporters.get(a);
    const rb = a === b ? ra : this.reporters.get(b);
    if (!ra || !rb) return refuse(404, 'no such reporter');
    if (!eligible(ra) || !eligible(rb)) return refuse(403, NO_ADMIN);
    if (ownerId !== null && (ownerId !== ra.ownerId || ownerId !== rb.ownerId)) return refuse(403, 'not your reporter');
    if (ra.ownerId !== rb.ownerId) return refuse(403, 'a link can only join two reporters with the same owner');
    return { ok: true, owner: ra.owner, ownerId: ra.ownerId };
  }

  // ---- defaults and limits -----------------------------------------------------------------------------------

  defaults(ownerId: number | null): OwnerDefaults {
    return toDefaults(ownerId === null ? undefined : (this.stmt('SELECT trust, on_request, new_send, limits_json FROM peer_owner_settings WHERE owner_id = ?').get(ownerId) as DbDefaults | undefined));
  }

  /** The defaults of many owners in one read (#1309): an owner with none stored has the built-in ones. */
  private defaultsMany(ownerIds: readonly number[]): Map<number, OwnerDefaults> {
    const out = new Map<number, OwnerDefaults>();
    // order-insensitive: the rows are put into a map by owner.
    for (const part of chunksOf(ownerIds)) for (const r of this.db.prepare(`SELECT owner_id, trust, on_request, new_send, limits_json FROM peer_owner_settings WHERE owner_id IN (${part.map(() => '?').join(', ')})`).all(...part) as unknown as (DbDefaults & { owner_id: number })[]) out.set(Number(r.owner_id), toDefaults(r));
    return out;
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

  setDefaults(ownerId: number, patch: Record<string, unknown>, server: PeerLimits, actor: Actor): { ok: true; defaults: OwnerDefaults } | Refusal {
    if (!isObj(patch) || !Object.keys(patch).length) return refuse(400, 'nothing to change');
    const next = this.defaults(ownerId);
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
    // A row is the person's by `owner_id` (#1284). `owner_lower` was the folded name and is still the primary key, so it holds the id as text: no name, so a newcomer's row never meets another's.
    this.stmt(
      `INSERT INTO peer_owner_settings (owner_lower, owner_id, trust, on_request, new_send, limits_json) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_lower) DO UPDATE SET owner_id = excluded.owner_id, trust = excluded.trust, on_request = excluded.on_request,
         new_send = excluded.new_send, limits_json = excluded.limits_json`,
    ).run(String(ownerId), ownerId, Number(next.trust), next.onRequest, next.newSend, JSON.stringify(next.limits));
    this.trail({ kind: 'defaults', owner: actor.name, actor });
    return { ok: true, defaults: next };
  }

  limits(ownerId: number | null, server: PeerLimits): PeerLimits {
    return limitsOf(this.defaults(ownerId).limits, server);
  }

  /** `limits` for many owners in one read (#1309), one answer for each, in order. */
  limitsMany(ownerIds: readonly (number | null)[], server: PeerLimits): PeerLimits[] {
    return limitsOfMany(ownerIds, this.defaultsMany(distinctOwners(ownerIds)), server);
  }

  // ---- rights ------------------------------------------------------------------------------------------------

  private row(from: string, to: string): RightRow | null {
    const r = this.stmt('SELECT * FROM peer_rights WHERE from_key = ? AND to_key = ?').get(from, to) as DbRight | undefined;
    return r ? toRight(r) : null;
  }

  private write(from: string, to: string, who: Who, level: PeerLevel, paused: boolean, pausedBy: LinkPauser | null = null, adminName: string | null = null): RightRow {
    const { owner } = who;
    const setAt = this.now();
    const by = paused ? pausedBy : null;
    const named = by === 'admin' ? adminName : null;
    this.stmt(
      `INSERT INTO peer_rights (from_key, to_key, owner, owner_id, level, paused, paused_by, paused_by_admin, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(from_key, to_key) DO UPDATE SET owner = excluded.owner, owner_id = excluded.owner_id, level = excluded.level, paused = excluded.paused, paused_by = excluded.paused_by, paused_by_admin = excluded.paused_by_admin, set_at = excluded.set_at`,
    ).run(from, to, owner, who.ownerId, level, Number(paused), by, named, setAt);
    return { from, to, owner, level, paused, ...(by ? { pausedBy: by } : {}), ...(named ? { pausedByAdmin: named } : {}), setAt };
  }

  private drop(from: string, to: string): void {
    this.stmt('DELETE FROM peer_rights WHERE from_key = ? AND to_key = ?').run(from, to);
  }

  /** Gives `from` at least `level` to `to`, keeping a pause and never lowering what is there. */
  private raise(from: string, to: string, who: Who, level: PeerLevel): { right: RightRow; changed: boolean } {
    const had = this.row(from, to);
    if (had && RANK[had.level] >= RANK[level]) return { right: had, changed: false };
    return { right: this.write(from, to, who, level, had?.paused ?? false), changed: true };
  }

  /** Pauses or resumes every direction of a link. A pause with no right yet is kept as a `none` row so it holds; a resume drops such rows. */
  private pausePair(who: Who, a: string, b: string, paused: boolean, by: LinkPauser | null = null, adminName: string | null = null): void {
    for (const [f, t] of directions(a, b)) {
      const had = this.row(f, t);
      // An Admin's pause stays an Admin's: a pause by anyone else does not take it over, and only an Admin lifts it (#1034).
      const theirs = had?.paused === true && had.pausedBy === 'admin';
      if (paused) this.write(f, t, who, had?.level ?? 'none', true, theirs ? 'admin' : by, theirs ? (had?.pausedByAdmin ?? null) : adminName);
      else if (theirs && by !== 'admin') continue;
      else if (had?.level === 'none') this.drop(f, t);
      else if (had) this.write(f, t, who, had.level, false);
    }
  }

  /** What `from` can do to `to` now (the one rule is `effectiveOf`). */
  effective(from: string, to: string): EffectiveRight {
    return this.effectiveMany([[from, to]])[0] as EffectiveRight;
  }

  /** `effective` for many links: the stored rights, the reporters and the owners' trust are each read once for all of them, so the number of statements does not grow with the links (#1309). */
  effectiveMany(links: readonly (readonly [string, string])[]): EffectiveRight[] {
    const rights = new Map<string, RightRow>();
    // order-insensitive: the rows are put into a map by the two keys of each right.
    for (const part of chunksOf([...new Map(links.map((l) => [`${l[0]}\0${l[1]}`, l])).values()])) for (const r of this.db.prepare(`SELECT * FROM peer_rights WHERE ${part.map(() => '(from_key = ? AND to_key = ?)').join(' OR ')}`).all(...part.flat()) as unknown as DbRight[]) rights.set(rightKey(r.from_key, r.to_key), toRight(r));
    const reps = new Map(this.reporters.getMany(links.flatMap(([from, to]) => (isPersonKey(from) ? [] : [from, to]))).map((r) => [r.key, r]));
    const trust = this.defaultsMany(trustOwners(links, (key) => reps.get(key)));
    return effectivesOf(links, rights, reps, trust);
  }

  /** The rows of the person with this `people.id` (#1284); a name never finds one. */
  rightsOf(ownerId: number | null): RightRow[] {
    if (ownerId === null) return [];
    // A person's link (#1034) is not one of the reporters' Grid, so it is left out; `personLink` reads it.
    return (this.stmt('SELECT * FROM peer_rights WHERE owner_id = ? ORDER BY from_key, to_key').all(ownerId) as unknown as DbRight[]).filter((r) => !isPersonKey(r.from_key)).map(toRight);
  }

  personLink(personKey: string, toKey: string): RightRow | null {
    return isPersonKey(personKey) ? this.row(personKey, toKey) : null;
  }

  setPersonLink(personKey: string, toKey: string, op: PersonLinkOp, actor: Actor, pausedBy?: LinkPauser): { ok: true; right: RightRow | null } | Refusal {
    if (!isPersonKey(personKey) || personKey.length <= 'person:'.length) return refuse(400, 'a person link starts at a person');
    const r = this.reporters.get(toKey);
    if (!r) return refuse(404, 'no such reporter');
    if (!eligible(r)) return refuse(403, NO_ADMIN);
    if (personKeyOf(r.ownerId) === personKey) return refuse(403, "a person's own agents need no link");
    const had = this.row(personKey, toKey);
    let right: RightRow | null;
    // An allow opens a link that is removed or not there yet. It never lifts a pause: whoever paused it (the sender, the owner or an Admin) resumes it (#1051).
    if (op === 'allow') {
      if (had?.paused) return refuse(409, 'this link is paused, so it is resumed, not allowed again');
      right = this.write(personKey, toKey, r, 'send', false);
    }
    else if (op === 'remove') {
      if (!had || had.level === 'none') return refuse(404, 'there is no link to remove');
      // A `none` row is kept, so a removed link holds: the person's next message is refused, not asked about again.
      right = this.write(personKey, toKey, r, 'none', false);
    } else {
      if (!had || had.level === 'none') return refuse(404, 'there is no link to pause');
      right = this.write(personKey, toKey, r, had.level, op === 'pause', op === 'pause' ? (pausedBy ?? null) : null, actor.name);
    }
    this.trail({ kind: 'person-link', op, owner: r.owner, person: personKey, toKey, actor });
    return { ok: true, right };
  }

  setRight(ownerId: number, from: string, to: string, level: PeerLevel, actor: Actor): { ok: true; right: RightRow | null } | Refusal {
    if (!PEER_LEVELS.includes(level)) return refuse(400, 'level must be none, see, ask or send');
    const p = this.pair(ownerId, from, to);
    if (!p.ok) return p;
    const paused = this.row(from, to)?.paused ?? false;
    let right: RightRow | null = null;
    if (level === 'none' && !paused) this.drop(from, to);
    else right = this.write(from, to, p, level, paused);
    this.trail({ kind: 'set', right: right ?? { from, to, owner: p.owner, level: 'none' }, actor });
    return { ok: true, right };
  }

  pauseLink(ownerId: number | null, a: string, b: string, paused: boolean, actor: Actor): { ok: true } | Refusal {
    const p = this.pair(ownerId, a, b);
    if (!p.ok) return p;
    // ownerId === null is an Admin acting on someone else's link: their pause is theirs, and the owner cannot lift it.
    const admin = ownerId === null;
    if (!paused && !admin && directions(a, b).some(([f, t]) => this.row(f, t)?.pausedBy === 'admin')) return refuse(403, ADMIN_PAUSED);
    this.tx(() => this.pausePair(p, a, b, paused, admin ? 'admin' : null, admin ? actor.name : null));
    this.trail({ kind: paused ? 'paused' : 'resumed', owner: p.owner, a, b, actor });
    return { ok: true };
  }

  removeLink(ownerId: number | null, a: string, b: string, actor: Actor): { ok: true } | Refusal {
    const p = this.pair(ownerId, a, b);
    if (!p.ok) return p;
    // Under Trust a link with no rows can still send, so a removal leaves it paused instead, or it would not hold.
    const trust = this.defaults(p.ownerId).trust;
    this.tx(() => {
      for (const [f, t] of directions(a, b)) {
        if (trust) this.write(f, t, p, 'none', true);
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
    // A bulk pause by an Admin is the Admin's, named like a pause of one link, and only an Admin lifts it (#1077).
    const by: LinkPauser | null = actor.admin ? 'admin' : null;
    const others = new Set([key, ...this.reporters.ofOwner(r.ownerId).filter(eligible).map((o) => o.key)]);
    this.tx(() => {
      for (const o of others) this.pausePair(r, key, o, paused, by, by ? actor.name : null);
    });
    for (const o of others) this.trail({ kind: paused ? 'paused' : 'resumed', owner: r.owner, a: key, b: o, actor });
    return { ok: true, links: others.size };
  }

  // ---- requests ----------------------------------------------------------------------------------------------

  private insertRequest(r: Omit<PeerRequestRow, 'id' | 'createdAt' | 'closedAt' | 'outcome'>): PeerRequestRow {
    const row: PeerRequestRow = { ...r, id: `prq_${randomBytes(12).toString('hex')}`, createdAt: this.now(), closedAt: null, outcome: null };
    this.stmt(
      `INSERT INTO peer_requests (id, owner, owner_id, kind, from_key, to_key, level, reason, by, from_session, message_id, created_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM peer_requests))`,
    ).run(row.id, row.owner, row.ownerId, row.kind, row.fromKey, row.toKey, row.level, row.reason, row.by, row.fromSession, row.messageId, row.createdAt);
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
    // A proposal only ever raises a right: the owner lowers or removes one themselves (SPEC 7.7).
    const stored = this.row(from, to)?.level ?? 'none';
    if (RANK[level] <= RANK[stored]) return refuse(409, `a proposal must raise the right; it is already ${stored}`);
    const open = this.stmt("SELECT * FROM peer_requests WHERE kind = 'proposal' AND from_key = ? AND to_key = ? AND closed_at IS NULL").get(from, to) as
      | DbRequest
      | undefined;
    let request: PeerRequestRow;
    if (open) {
      // One open proposal per direction: proposing again changes it rather than asking the owner twice.
      request = { ...toRequest(open), level, createdAt: this.now() };
      this.stmt('UPDATE peer_requests SET level = ?, created_at = ? WHERE id = ?').run(level, request.createdAt, request.id);
    } else {
      request = this.insertRequest({ owner: p.owner, ownerId: p.ownerId, kind: 'proposal', fromKey: from, toKey: to, level, reason: null, by: ADMIN_OWNER, fromSession: null, messageId: null });
    }
    this.trail({ kind: 'proposed', request, actor });
    return { ok: true, request };
  }

  requestAccess(input: { ownerId: number; fromKey: string; toKey: string; right: 'see' | 'send'; reason: string; by: string; fromSession: string }): AccessOutcome | Refusal {
    if (input.right !== 'see' && input.right !== 'send') return refuse(400, 'right must be see or send');
    if (typeof input.reason !== 'string') return refuse(400, 'reason must be text');
    const reason = cleanReason(input.reason);
    if (reason.length > PEER_LIMITS.reason) return refuse(400, `the reason must be at most ${PEER_LIMITS.reason} characters`);
    const p = this.pair(input.ownerId, input.fromKey, input.toKey);
    if (!p.ok) return p;
    const d = this.defaults(p.ownerId);
    const level: PeerLevel = input.right === 'see' ? 'see' : d.newSend;
    if (d.onRequest === 'decline') return { ok: true, state: 'declined' };
    if (d.onRequest === 'allow') {
      const { right, changed } = this.raise(input.fromKey, input.toKey, p, level);
      if (changed) this.trail({ kind: 'set', right, actor: { name: p.owner, admin: false } });
      return { ok: true, state: 'allowed', applied: right };
    }
    const same = this.stmt(
      `SELECT * FROM peer_requests WHERE kind = 'access' AND from_key = ? AND to_key = ? AND level = ? AND reason IS ? AND from_session = ? AND closed_at IS NULL`,
    ).get(input.fromKey, input.toKey, level, reason || null, input.fromSession) as DbRequest | undefined;
    if (same) return { ok: true, state: 'asked', request: toRequest(same) };
    const request = this.insertRequest({
      owner: p.owner,
      ownerId: p.ownerId,
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

  openMessageRequest(input: { owner: string; ownerId: number; fromKey: string; toKey: string; by: string; fromSession: string; messageId: string }): PeerRequestRow {
    return this.insertRequest({ owner: input.owner, ownerId: input.ownerId, kind: 'message', fromKey: input.fromKey, toKey: input.toKey, level: null, reason: null, by: input.by, fromSession: input.fromSession, messageId: input.messageId });
  }

  closeMessageRequest(messageId: string, outcome: 'delivered' | 'dropped' | 'declined'): void {
    this.stmt("UPDATE peer_requests SET closed_at = ?, outcome = ? WHERE kind = 'message' AND message_id = ? AND closed_at IS NULL").run(this.now(), outcome, messageId);
  }

  openRequests(ownerId: number | null, about?: string): PeerRequestRow[] {
    if (ownerId === null) return [];
    const rows =
      about === undefined
        ? this.stmt('SELECT * FROM peer_requests WHERE closed_at IS NULL ORDER BY created_at, seq').all()
        : this.stmt('SELECT * FROM peer_requests WHERE closed_at IS NULL AND (from_key = ? OR to_key = ?) ORDER BY created_at, seq').all(about, about);
    return (rows as unknown as DbRequest[]).filter((r) => r.owner_id !== null && Number(r.owner_id) === ownerId).map(toRequest);
  }

  getRequest(id: string): PeerRequestRow | null {
    const r = this.stmt('SELECT * FROM peer_requests WHERE id = ?').get(id) as DbRequest | undefined;
    return r ? toRequest(r) : null;
  }

  answer(id: string, ownerId: number, answer: PeerAnswer, actor: Actor): AnswerOutcome | Refusal {
    const req = this.getRequest(id);
    if (!req) return refuse(404, 'no such request');
    if (req.ownerId === null || ownerId !== req.ownerId) return refuse(403, 'not your request');
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
    const p = this.pair(ownerId, req.fromKey, req.toKey);
    if (!p.ok) return p;
    const level = req.level as PeerLevel;
    // Neither an accepted proposal nor an allowed access request lowers a right, even one that rose after it was made.
    const applied = this.raise(req.fromKey, req.toKey, p, level).right;
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
    // order-insensitive: every key listed is checked, in whatever order.
    const keys = this.stmt(
      'SELECT from_key AS k FROM peer_requests UNION SELECT to_key FROM peer_requests UNION SELECT from_key FROM peer_rights UNION SELECT to_key FROM peer_rights',
    ).all() as unknown as { k: string }[];
    for (const { k } of keys) {
      // A person's end of a link is not a reporter; it goes with the reporter on the other end.
      if (isPersonKey(k) || this.reporters.get(k)) continue;
      n += Number(this.stmt('DELETE FROM peer_requests WHERE from_key = ? OR to_key = ?').run(k, k).changes);
      this.stmt('DELETE FROM peer_rights WHERE from_key = ? OR to_key = ?').run(k, k);
    }
    return n;
  }
}
