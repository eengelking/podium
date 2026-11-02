// Every podium-reporter the server has heard from, on PostgreSQL (#822): the SQLite `ReporterStore` over `PgDb`. One row per machine and reporter (#849), keyed on the
// machine id the reporter sends, or on its source address when it sends none. A method that reads and then writes is one transaction,
// which is what the SQLite lock gave it. All statements are parameterized.
import { checkReporter } from '../../fleet/compat.js';
import { keyOf, nameSuffix, DEFAULT_REPORTER_NAME, REPORTER_STATES, ADMIN_SECRET, IGNORE_KINDS, type ReporterSeen, type ReporterState, type ReporterSort, type ReporterRow, type ReporterList, type ReporterDetail, type IgnoreKind, type IgnoreRule, type IgnoreTarget, type ForgetSetting } from '../rows.js';
import type { ReporterStoreApi } from '../types.js';
import type { PgDb } from './conn.js';
import { pgPeerLookup, STATE_SQL } from './peerLookup.js';
import { clampPage, likeTerm } from './people.js';

const MAX_REJECTED = 200;
const SHOWN_REJECTED = 20;
const DAY_MS = 24 * 60 * 60_000;
/** After a start, reporters are not forgotten for this long, so a long outage does not empty the list before anyone could report. */
const FORGET_GRACE_MS = 60 * 60_000;
const MAX_PATTERN = 120;
const MAX_FORGET_DAYS = 3650;
const DEFAULT_FORGET_DAYS = 30;
const SORTS: readonly ReporterSort[] = ['state', 'name', 'who', 'token', 'ver', 'last', 'sessions'];

interface DbReporter {
  key: string;
  kind: 'mod' | 'hooks';
  reporter_name: string;
  machine_id: string | null;
  machine_name: string | null;
  source_address: string | null;
  owner: string | null;
  credential: string | null;
  reporter_version: string;
  engine_version: string | null;
  first_seen_at: number;
  last_seen_at: number;
  os: string | null;
  peers: number | null;
  state: ReporterState;
  sessions: number;
  live: number;
  project: string | null;
}

/** The project of the newest session a reporter reported: what an unnamed reporter is called. */
const PROJECT_SQL = `SELECT COALESCE(s.repo_name, s.name) FROM reporter_sessions x JOIN sessions s ON s.id = x.session_id
  WHERE x.reporter_key = r.key ORDER BY s.last_seen_at DESC, s.id DESC LIMIT 1`;
const NAME_SQL = `COALESCE(r.machine_name, CASE r.kind WHEN 'hooks' THEN 'Hooks only' ELSE COALESCE((${PROJECT_SQL}), r.source_address, 'Unnamed reporter') END)`;
const SESSIONS_SQL = 'SELECT COUNT(*) FROM reporter_sessions x WHERE x.reporter_key = r.key';
const LIVE_SQL = `SELECT COUNT(*) FROM reporter_sessions x JOIN sessions s ON s.id = x.session_id
  WHERE x.reporter_key = r.key AND s.ended_at IS NULL AND s.dropped_at IS NULL`;
const ORDER: Record<ReporterSort, string> = {
  state: `CASE state WHEN 'reporting' THEN 0 WHEN 'idle' THEN 1 WHEN 'silent' THEN 2 ELSE 3 END`,
  name: `podium_lower(${NAME_SQL.replace(/r\./g, 'q.')})`,
  who: `podium_lower(COALESCE(q.owner, 'Unassigned'))`,
  token: `CASE WHEN q.credential = '${ADMIN_SECRET}' THEN 0 ELSE 1 END, q.credential`,
  ver: 'q.reporter_version',
  last: 'q.last_seen_at',
  sessions: 'q.sessions',
};

const ruleOf = (r: { id: number; kind: string; pattern: string; created_at: number }): IgnoreRule => ({ id: r.id, kind: r.kind as IgnoreKind, pattern: r.pattern, createdAt: r.created_at });

/** A pattern is exact text, compared without regard to case, with * for "anything". Never a regular expression. */
function matches(pattern: string, value: string): boolean {
  // Two-pointer wildcard match: * takes any run of characters, and the work stays proportional to the two lengths.
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  let pi = 0;
  let vi = 0;
  let star = -1;
  let mark = 0;
  while (vi < v.length) {
    if (pi < p.length && p[pi] === '*') {
      star = pi++;
      mark = vi;
    } else if (pi < p.length && p[pi] === v[vi]) {
      pi++;
      vi++;
    } else if (star >= 0) {
      pi = star + 1;
      vi = ++mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

export class PgReporterStore implements ReporterStoreApi {
  private rejections: { source: string; t: number; reason: string }[] = [];

  constructor(
    private readonly db: PgDb,
    /** When the server started: a reporter last heard before this has not reported since the restart. */
    private readonly startedAt: number,
  ) {}

  /**
   * The key one account on a machine is filed under (#221). Two accounts on a machine report the same machine id, so
   * the first one keeps the machine id as its key (rows and ignore rules made before this stay valid) and each
   * other account gets `<machine id>#<owner>`. A reporter with no machine id is keyed by `keyOf` alone.
   */
  private async accountKey(s: Pick<ReporterSeen, 'kind' | 'machineId' | 'source' | 'owner' | 'reporterName'>): Promise<string> {
    const own = keyOf(s);
    if (!s.machineId) return own;
    const apart = `${s.machineId}#${s.owner ?? ''}${nameSuffix(s.reporterName)}`;
    const has = (key: string) => this.db.get<{ owner: string | null }>('SELECT owner FROM reporters WHERE key = ?', [key]);
    if (await has(apart)) return apart;
    const bare = await has(own);
    return !bare || bare.owner === s.owner ? own : apart;
  }

  /**
   * The key an earlier report of the same session was filed under, for a reporter that sends no machine id. A session
   * belongs to one reporter, so a report from a new source address that carries a known session is the same reporter
   * on a new address (a container that restarted), not a new one (issue #166). The oldest row wins.
   */
  private async knownKey(s: Pick<ReporterSeen, 'kind' | 'machineId' | 'sessionId' | 'reporterName'>): Promise<string | undefined> {
    if (s.machineId) return undefined;
    const prefix = s.kind === 'hooks' ? 'hooks:' : 'addr:';
    const hit = await this.db.get<{ key: string }>(
      `SELECT r.key FROM reporter_sessions x JOIN reporters r ON r.key = x.reporter_key
       WHERE x.session_id = ? AND r.machine_id IS NULL AND r.kind = ? AND r.reporter_name = ? AND r.key LIKE ? ORDER BY r.first_seen_at, r.key LIMIT 1`,
      [s.sessionId, s.kind, s.reporterName ?? DEFAULT_REPORTER_NAME, `${prefix}%`],
    );
    return hit?.key;
  }

  async keysFor(s: Pick<ReporterSeen, 'kind' | 'machineId' | 'source' | 'sessionId' | 'reporterName'> & { owner?: string | null }): Promise<string[]> {
    const own = keyOf(s);
    const known = await this.knownKey(s);
    const account = await this.accountKey({ ...s, owner: s.owner ?? null });
    // The machine id comes first, so a rule on it covers every account on the machine (#221).
    // The per-account form is always included, so a rule on `<machine id>#<owner>` still turns that account away when its row is keyed on the bare machine id.
    const apart = s.machineId ? [`${s.machineId}#${s.owner ?? ''}${nameSuffix(s.reporterName)}`] : [];
    // A rule on the bare machine id also covers a reporter other than the Claude Code one on that machine (#849).
    const machine = s.machineId ? [s.machineId] : [];
    return [...new Set([own, account, ...machine, ...apart, ...(known ? [known] : [])])];
  }

  record(s: ReporterSeen, now: number): Promise<string> {
    return this.db.tx(async () => {
      const own = keyOf(s);
      const known = await this.knownKey(s);
      const key = known ?? (await this.accountKey(s));
      // A row made for this address before a known session turned up here is the same reporter: fold it in.
      if (known && known !== own) await this.merge(own, known);
      const peers = s.peers === undefined || s.peers === null ? null : Number(s.peers);
      await this.db.run(
        `INSERT INTO reporters (key, kind, reporter_name, machine_id, machine_name, source_address, owner, credential, reporter_version, engine_version, first_seen_at, last_seen_at, os, peers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, machine_name = excluded.machine_name, source_address = excluded.source_address,
           owner = excluded.owner, credential = excluded.credential, reporter_version = excluded.reporter_version,
           engine_version = excluded.engine_version, last_seen_at = excluded.last_seen_at,
           os = COALESCE(excluded.os, reporters.os), peers = COALESCE(excluded.peers, reporters.peers)`,
        [
          key,
          s.kind,
          s.reporterName ?? DEFAULT_REPORTER_NAME,
          s.machineId,
          s.machineName?.slice(0, 64) ?? null,
          s.source?.slice(0, 120) ?? null,
          s.owner,
          s.credential,
          s.version.slice(0, 64),
          s.engineVersion?.slice(0, 64) ?? null,
          now,
          now,
          s.os?.slice(0, 80) ?? null,
          peers,
        ],
      );
      await this.db.run(
        `INSERT INTO reporter_sessions (reporter_key, session_id, peers) VALUES (?, ?, ?)
         ON CONFLICT(reporter_key, session_id) DO UPDATE SET peers = COALESCE(excluded.peers, reporter_sessions.peers)`,
        [key, s.sessionId, peers],
      );
      // The reporter takes part while any live session does (#838): a session that reports false (a `claude -p` run) leaves it On.
      if (peers === 0) {
        await this.db.run(
          `UPDATE reporters SET peers = 1 WHERE key = ? AND EXISTS (
             SELECT 1 FROM reporter_sessions x WHERE x.reporter_key = reporters.key AND x.peers = 1 AND x.session_id != ?
               AND NOT EXISTS (SELECT 1 FROM sessions v WHERE v.id = x.session_id AND (v.ended_at IS NOT NULL OR v.dropped_at IS NOT NULL)))`,
          [key, s.sessionId],
        );
      }
      return key;
    });
  }

  peerLookup() {
    return pgPeerLookup(this.db, this.startedAt);
  }

  async hasAny(): Promise<boolean> {
    return (await this.db.get('SELECT 1 FROM reporters LIMIT 1')) !== undefined;
  }

  /** Moves `from`'s session links to `into`, keeps the earlier first-seen time, and drops `from`. */
  private async merge(from: string, into: string): Promise<void> {
    await this.db.run('INSERT INTO reporter_sessions (reporter_key, session_id, peers) SELECT ?::text, session_id, peers FROM reporter_sessions WHERE reporter_key = ? ON CONFLICT DO NOTHING', [into, from]);
    await this.db.run('UPDATE reporters SET first_seen_at = LEAST(first_seen_at, COALESCE((SELECT first_seen_at FROM reporters WHERE key = ?), first_seen_at)) WHERE key = ?', [from, into]);
    await this.db.run('DELETE FROM reporters WHERE key = ?', [from]);
  }

  /** Memory only, as in the SQLite store. The reason is one of the server's own fixed phrases. */
  async rejected(source: string | null, reason: string, now: number): Promise<void> {
    if (!source) return;
    this.rejections.push({ source, t: now, reason: reason.slice(0, 200) });
    if (this.rejections.length > MAX_REJECTED) this.rejections.splice(0, this.rejections.length - MAX_REJECTED);
  }

  private toRow(r: DbReporter): ReporterRow {
    return {
      key: r.key,
      state: r.state,
      name: r.machine_name ?? (r.kind === 'hooks' ? 'Hooks only' : (r.project ?? r.source_address ?? 'Unnamed reporter')),
      named: r.machine_name !== null,
      who: r.owner ?? 'Unassigned',
      credential: r.credential,
      adminSecret: r.credential === ADMIN_SECRET,
      version: r.reporter_version,
      reporterName: r.reporter_name,
      compat: checkReporter(r.reporter_version),
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      sessions: r.sessions,
      live: r.live,
      os: r.os,
      peers: r.peers === null ? null : r.peers === 1,
    };
  }

  /** The query behind `list` and `keys`: the filtered rows with their state, the parameters, and the state filter. */
  private view(opts: { q?: string; state?: string; admin?: boolean }, now: number) {
    const q = (opts.q ?? '').trim().slice(0, 100);
    const state = REPORTER_STATES.find((s) => s === opts.state);
    const base = { now, started: this.startedAt };
    const where: string[] = [];
    const params: Record<string, string | number> = { ...base };
    if (opts.admin) {
      where.push('r.credential = :adminSecret');
      params.adminSecret = ADMIN_SECRET;
    }
    if (q) {
      where.push(`(podium_lower(${NAME_SQL}) LIKE :like ESCAPE '\\' OR podium_lower(COALESCE(r.owner, 'unassigned')) LIKE :like ESCAPE '\\'
        OR podium_lower(COALESCE(r.source_address, '')) LIKE :like ESCAPE '\\' OR podium_lower(COALESCE(r.machine_id, '')) LIKE :like ESCAPE '\\'
        OR podium_lower(r.reporter_version) LIKE :like ESCAPE '\\')`);
      params.like = likeTerm(q);
    }
    const sub = `SELECT r.*, ${STATE_SQL} AS state, (${SESSIONS_SQL}) AS sessions, (${LIVE_SQL}) AS live, (${PROJECT_SQL}) AS project FROM reporters r${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
    const filter = state ? ' WHERE q.state = :state' : '';
    if (state) params.state = state;
    return { sub, params, filter, base };
  }

  async list(opts: { page?: number; pageSize?: number; q?: string; state?: string; sort?: string; dir?: number; admin?: boolean }, now: number): Promise<ReporterList> {
    const { page, pageSize } = clampPage(opts);
    const sort = SORTS.find((s) => s === opts.sort) ?? 'last';
    const dir = opts.dir !== undefined ? (opts.dir > 0 ? 'ASC' : 'DESC') : sort === 'last' ? 'DESC' : 'ASC';
    // SQLite sorts a missing value first when ascending and last when descending; PostgreSQL does the opposite unless told.
    const nulls = dir === 'ASC' ? 'NULLS FIRST' : 'NULLS LAST';
    const { sub, params, filter, base } = this.view(opts, now);

    const counts: ReporterList['counts'] = { all: 0, reporting: 0, idle: 0, silent: 0, restart: 0 };
    // order-insensitive: the rows are counted per state into an object.
    for (const c of await this.db.all<{ state: ReporterState; n: number }>(`SELECT ${STATE_SQL} AS state, COUNT(*) AS n FROM reporters r GROUP BY state`, base)) {
      counts[c.state] = c.n;
      counts.all += c.n;
    }

    const total = (await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM (${sub}) q${filter}`, params))!.n;
    const rows = await this.db.all<DbReporter>(`SELECT q.* FROM (${sub}) q${filter} ORDER BY ${ORDER[sort]} ${dir} ${nulls}, q.key LIMIT :limit OFFSET :offset`, {
      ...params,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    const admin = (await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reporters WHERE credential = ?', [ADMIN_SECRET]))!.n;
    return { total, page, pageSize, rows: rows.map((r) => this.toRow(r)), counts, serverStartedAt: this.startedAt, adminSecret: admin };
  }

  async keys(opts: { q?: string; state?: string; admin?: boolean }, now: number): Promise<string[]> {
    const { sub, params, filter } = this.view(opts, now);
    return (await this.db.all<{ key: string }>(`SELECT q.key FROM (${sub}) q${filter} ORDER BY q.key`, params)).map((r) => r.key);
  }

  async get(key: string, now: number, opts: { page?: number; pageSize?: number } = {}): Promise<ReporterDetail | undefined> {
    const r = await this.db.get<DbReporter>(
      `SELECT r.*, ${STATE_SQL} AS state, (${SESSIONS_SQL}) AS sessions, (${LIVE_SQL}) AS live, (${PROJECT_SQL}) AS project FROM reporters r WHERE r.key = :key`,
      { key, now, started: this.startedAt },
    );
    if (!r) return undefined;
    const { page, pageSize } = clampPage(opts);
    const recentTotal = (await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reporter_sessions x JOIN sessions s ON s.id = x.session_id WHERE x.reporter_key = ?', [key]))!.n;
    const recent = await this.db.all<{ id: string; name: string; status: string; last_seen_at: number; cost_usd: number | null }>(
      `SELECT s.id, s.name, s.status, s.last_seen_at, s.cost_usd FROM reporter_sessions x JOIN sessions s ON s.id = x.session_id
       WHERE x.reporter_key = ? ORDER BY s.last_seen_at DESC, s.id LIMIT ? OFFSET ?`,
      [key, pageSize, (page - 1) * pageSize],
    );
    const rejected = r.source_address
      ? this.rejections
          .filter((x) => x.source === r.source_address)
          .slice(-SHOWN_REJECTED)
          .reverse()
          .map((x) => ({ t: x.t, reason: x.reason }))
      : [];
    return {
      ...this.toRow(r),
      serverStartedAt: this.startedAt,
      kind: r.kind,
      machineId: r.machine_id,
      source: r.source_address,
      credential: r.credential,
      engineVersion: r.engine_version,
      recent: recent.map((s) => ({ id: s.id, name: s.name, status: s.status, lastSeenAt: s.last_seen_at, costUsd: s.cost_usd })),
      recentTotal,
      recentPage: page,
      recentPageSize: pageSize,
      rejected,
    };
  }

  async remove(key: string): Promise<boolean> {
    return (await this.db.run('DELETE FROM reporters WHERE key = ?', [key])) > 0;
  }

  /** In one transaction; called inside one (the Admin adds an ignore rule and counts what went in one), it joins that one. */
  removeMany(keys: string[]): Promise<number> {
    return this.db.tx(async () => {
      let n = 0;
      for (const k of keys) n += await this.db.run('DELETE FROM reporters WHERE key = ?', [k]);
      return n;
    });
  }

  removeState(state: ReporterState, now: number): Promise<number> {
    return this.db.run(`DELETE FROM reporters WHERE key IN (SELECT r.key FROM reporters r WHERE ${STATE_SQL} = :state)`, { now, started: this.startedAt, state });
  }

  // ---- ignore rules (issue #167) --------------------------------------------------------------

  async listIgnores(): Promise<IgnoreRule[]> {
    return (await this.db.all<{ id: number; kind: string; pattern: string; created_at: number }>('SELECT id, kind, pattern, created_at FROM reporter_ignores ORDER BY id')).map(ruleOf);
  }

  async ignoredBy(t: IgnoreTarget): Promise<IgnoreRule | undefined> {
    return (await this.listIgnores()).find((r) => {
      if (r.kind === 'key') return [t.key, ...(t.otherKeys ?? [])].some((k) => matches(r.pattern, k));
      const v = r.kind === 'address' ? t.source : t.version;
      return v !== null && matches(r.pattern, v);
    });
  }

  async addIgnore(kind: IgnoreKind, pattern: string, now: number): Promise<IgnoreRule> {
    const p = pattern.trim();
    if (!IGNORE_KINDS.includes(kind)) throw new Error('kind must be key, address or version');
    if (/^\*+$/.test(p)) throw new Error('pattern must name something besides *');
    if (p.length < 1 || p.length > MAX_PATTERN) throw new Error(`pattern must be 1 to ${MAX_PATTERN} characters`);
    return this.db.tx(async () => {
      await this.db.run('INSERT INTO reporter_ignores (kind, pattern, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [kind, p, now]);
      const rule = ruleOf((await this.db.get<{ id: number; kind: string; pattern: string; created_at: number }>('SELECT id, kind, pattern, created_at FROM reporter_ignores WHERE kind = ? AND pattern = ?', [kind, p]))!);
      // order-insensitive: every row is tested against the rule, in whatever order.
      const all = await this.db.all<{ key: string; machine_id: string | null; source_address: string | null; reporter_version: string }>('SELECT key, machine_id, source_address, reporter_version FROM reporters');
      await this.removeMany(
        all
          .filter((r) => {
            // A rule on a machine id covers every account on that machine, so a key rule also tries the row's machine id (#221).
            if (kind === 'key') return matches(p, r.key) || (r.machine_id !== null && matches(p, r.machine_id));
            const v = kind === 'address' ? r.source_address : r.reporter_version;
            return v !== null && matches(p, v);
          })
          .map((r) => r.key),
      );
      return rule;
    });
  }

  async removeIgnore(id: number): Promise<boolean> {
    return (await this.db.run('DELETE FROM reporter_ignores WHERE id = ?', [id])) > 0;
  }

  // ---- forgetting by age (issue #167) ---------------------------------------------------------

  private async setting(key: string): Promise<string | undefined> {
    return (await this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]))?.value;
  }

  private async putSetting(key: string, value: string): Promise<void> {
    await this.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
  }

  async forgetSetting(): Promise<ForgetSetting> {
    const days = Number(await this.setting('forget_reporters_days'));
    return { enabled: (await this.setting('forget_reporters_enabled')) === '1', days: Number.isInteger(days) && days >= 1 ? days : DEFAULT_FORGET_DAYS };
  }

  async setForgetSetting(s: Partial<ForgetSetting>): Promise<void> {
    if (s.days !== undefined && (!Number.isInteger(s.days) || s.days < 1 || s.days > MAX_FORGET_DAYS)) throw new Error(`days must be a whole number from 1 to ${MAX_FORGET_DAYS}`);
    await this.db.tx(async () => {
      if (s.days !== undefined) await this.putSetting('forget_reporters_days', String(s.days));
      if (s.enabled !== undefined) await this.putSetting('forget_reporters_enabled', s.enabled ? '1' : '0');
    });
  }

  forgetStale(now: number): Promise<number> {
    return this.db.tx(async () => {
      const f = await this.forgetSetting();
      if (!f.enabled) return 0;
      // A server that was down for longer than the setting has heard from nobody yet: give every reporter time to report first.
      if (now - this.startedAt < FORGET_GRACE_MS) return 0;
      return this.db.run('DELETE FROM reporters WHERE last_seen_at < ?', [now - f.days * DAY_MS]);
    });
  }
}

/** `startedAt` is when the server started; it defaults to now, as the SQLite store's `now` does. */
export const pgReporters = (db: PgDb, startedAt: number = Date.now()): ReporterStoreApi => new PgReporterStore(db, startedAt);
