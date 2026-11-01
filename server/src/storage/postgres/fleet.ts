// The fleet store on PostgreSQL (#822): sessions, agents, events, blowouts, samples and spend, and the report and rollup queries. It is
// the SQLite `FleetDb` over `PgDb`: the same SQL where PostgreSQL allows it, the same spend and cost arithmetic in code. A method that
// reads and then writes is one transaction, which is what the SQLite lock gave it.
import { type SessionRow, type AgentRow, type EventRow, type BlowoutRow, type SampleRow, SAME_USAGE, type CostRow, type CostOf, type SessionSpend, type RetentionPolicy, ADMIN_LOG_KEEP } from '../rows.js';
import type { FleetStore, FleetStoreApi } from '../types.js';
import type { PgDb, Params } from './conn.js';
import { PgReportQueries } from './reportQueries.js';

const storedCost: CostOf = (r) => r.cost_usd;

/** Whether a compact event's `data_json` is an object whose `trigger` is exactly the string `auto`; anything else, unreadable JSON included, is not. */
function isAutoCompact(dataJson: string | null): boolean {
  if (dataJson === null) return false;
  try {
    const data: unknown = JSON.parse(dataJson);
    return typeof data === 'object' && data !== null && !Array.isArray(data) && (data as { trigger?: unknown }).trigger === 'auto';
  } catch {
    return false;
  }
}

/** The tables a session owns rows in, in the order a delete takes them. */
const SESSION_CHILDREN = ['events', 'blowouts', 'samples', 'agents', 'agent_texts'] as const;

export class PgFleetStore implements FleetStoreApi {
  constructor(private readonly db: PgDb) {}

  // ---- sessions -------------------------------------------------------------------------------

  async upsertSession(row: SessionRow): Promise<void> {
    const cols = Object.keys(row) as (keyof SessionRow)[];
    const sql =
      `INSERT INTO sessions (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')}) ` +
      `ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}`;
    await this.db.run(sql, row as unknown as Params);
  }

  getSession(id: string): Promise<SessionRow | undefined> {
    return this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [id]);
  }

  /** Sessions that may be in the live set: not dropped, and either not ended or ended after `endedAfter`. */
  liveCandidates(endedAfter: number): Promise<SessionRow[]> {
    return this.db.all<SessionRow>('SELECT * FROM sessions WHERE dropped_at IS NULL AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at, id', [endedAfter]);
  }

  async setDropped(id: string, at: number): Promise<void> {
    await this.db.run('UPDATE sessions SET dropped_at = ? WHERE id = ?', [at, id]);
  }

  private async removeSession(id: string): Promise<number> {
    for (const table of SESSION_CHILDREN) await this.db.run(`DELETE FROM ${table} WHERE session_id = ?`, [id]);
    return this.db.run('DELETE FROM sessions WHERE id = ?', [id]);
  }

  deleteSession(id: string): Promise<boolean> {
    return this.db.tx(async () => (await this.removeSession(id)) > 0);
  }

  /** The session that continued `id` after a /clear, if any (the newest when there are several). */
  async clearedInto(id: string): Promise<string | null> {
    const r = await this.db.get<{ id: string }>('SELECT id FROM sessions WHERE cleared_from = ? ORDER BY started_at DESC, id DESC LIMIT 1', [id]);
    return r?.id ?? null;
  }

  /** Sessions that ended (or were dropped) in [from, to). */
  endedBetween(from: number, to: number): Promise<SessionRow[]> {
    return this.db.all<SessionRow>(
      `SELECT * FROM sessions WHERE (dropped_at >= :from AND dropped_at < :to)
         OR (dropped_at IS NULL AND ended_at >= :from AND ended_at < :to) ORDER BY started_at, id`,
      { from, to },
    );
  }

  /**
   * What each session spent at or after `since`, with its owner and the owner's group. A session that started
   * after `since` counts whole. One that started before counts the share of its cost that came after the ledger's
   * last sample before `since` (samples are cumulative), so a session left running over midnight adds only today's
   * spend. One first heard of after `since` has no sample before it and counts what it spent since its first sample; one with
   * no sample at all adds nothing. `cost` says what a session costs in all (the Admin's
   * prices repriced from its usage); by default its stored cost_usd. That total is scaled by the ledger's share.
   */
  private async spendSince(since: number, cost: CostOf): Promise<SessionSpend[]> {
    const rows = await this.db.all<
      CostRow & { id: string; name: string; model: string | null; owner: string | null; grp: string | null; started_at: number; last_seen_at: number; base: number | null }
    >(
      `SELECT s.id AS id, s.name AS name, s.model AS model, s.owner AS owner, g.name AS grp, s.cost_usd AS cost_usd, s.usage_json AS usage_json, s.started_at AS started_at, s.last_seen_at AS last_seen_at,
         COALESCE(
           (SELECT m.cost_usd FROM samples m WHERE m.session_id = s.id AND m.t < :sec AND m.cost_usd IS NOT NULL ORDER BY m.t DESC LIMIT 1),
           (SELECT m.cost_usd FROM samples m WHERE m.session_id = s.id AND m.cost_usd IS NOT NULL ORDER BY m.t ASC LIMIT 1)
         ) AS base
       FROM sessions s LEFT JOIN people p ON p.name = s.owner LEFT JOIN groups g ON g.id = p.group_id
       WHERE s.started_at >= :since OR s.ended_at IS NULL OR s.ended_at >= :since`,
      { since, sec: Math.floor(since / 1000) },
    );
    const out: SessionSpend[] = [];
    for (const r of rows) {
      const whole = cost(r);
      const total = whole ?? 0;
      const id = { id: r.id, name: r.name, model: r.model, owner: r.owner, grp: r.grp, priced: whole !== null, usageJson: r.usage_json, lastSeenAt: r.last_seen_at, whole };
      if (r.started_at >= since) {
        out.push({ ...id, usd: total });
        continue;
      }
      // No ledger figure now (the mod sends none on a local model): split by the priced usage on the sample before
      // `since` instead, so the Claude spend of an earlier part of the day is not lost (#286).
      if (r.cost_usd === null) {
        out.push({ ...id, usd: Math.max(0, total - (await this.pricedUsageAt(r.id, since, cost))) });
        continue;
      }
      const ledger = r.cost_usd;
      const share = r.base === null || ledger <= 0 ? 0 : Math.max(0, ledger - r.base) / ledger;
      out.push({ ...id, usd: total * share });
    }
    return out;
  }

  /**
   * What a session had cost, priced from its usage, at its last sample before `since`; its first sample when it has
   * none before (a session first heard of after `since`, as in `spendSince`). 0 when no sample kept any usage, so a
   * session from a reporter older than 0.12.0 on a local model still counts nothing today. A sample may hold
   * `SAME_USAGE` for the usage of the one before it, so the usage is the newest one stored in full at or before it.
   */
  private async pricedUsageAt(sessionId: string, since: number, cost: CostOf): Promise<number> {
    const sec = Math.floor(since / 1000);
    const at =
      (await this.db.get<{ t: number; usage_json: string }>('SELECT t, usage_json FROM samples WHERE session_id = ? AND t < ? AND usage_json IS NOT NULL ORDER BY t DESC LIMIT 1', [sessionId, sec])) ??
      (await this.db.get<{ t: number; usage_json: string }>('SELECT t, usage_json FROM samples WHERE session_id = ? AND usage_json IS NOT NULL ORDER BY t ASC LIMIT 1', [sessionId]));
    if (!at) return 0;
    let usage: string | null = at.usage_json;
    if (usage === SAME_USAGE) {
      const full = await this.db.get<{ usage_json: string }>(
        'SELECT usage_json FROM samples WHERE session_id = ? AND t <= ? AND usage_json IS NOT NULL AND usage_json != ? ORDER BY t DESC LIMIT 1',
        [sessionId, at.t, SAME_USAGE],
      );
      usage = full?.usage_json ?? null;
    }
    return usage === null ? 0 : (cost({ cost_usd: null, usage_json: usage }) ?? 0);
  }

  /**
   * Every session's share of the spend at or after `since`, in the order `costTodayByOwner` adds them, so a cut of it adds up
   * to the same total (#482). `priced` is false when the session has no price (its `usd` is then 0).
   */
  sessionSpendSince(since: number, cost: CostOf = storedCost): Promise<SessionSpend[]> {
    return this.spendSince(since, cost);
  }

  /**
   * Σ cost_usd_est of the agents of each session `spendSince(since)` looks at, repriced with `cost`, in one query; agents
   * with no figure add nothing, and a session with no agents is not in the map.
   */
  async agentCostsSince(since: number, cost: CostOf): Promise<Map<string, number>> {
    const rows = await this.db.all<CostRow & { id: string }>(
      `SELECT a.session_id AS id, a.cost_usd_est AS cost_usd, a.usage_json AS usage_json FROM agents a JOIN sessions s ON s.id = a.session_id
       WHERE s.started_at >= :since OR s.ended_at IS NULL OR s.ended_at >= :since`,
      { since },
    );
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.id, (out.get(r.id) ?? 0) + (cost(r) ?? 0));
    return out;
  }

  /** Σ spend at or after `since` (see `spendSince`). */
  async costSince(since: number, cost: CostOf = storedCost): Promise<number> {
    return (await this.spendSince(since, cost)).reduce((n, r) => n + r.usd, 0);
  }

  /** `costSince` split by owner, with the group each owner is in (Admin, no owner and no group give null), largest first. */
  async costByOwnerSince(since: number, cost: CostOf = storedCost): Promise<{ owner: string | null; group: string | null; costUsd: number }[]> {
    return this.spendBy(await this.spendSince(since, cost));
  }

  /** `costSince` and `costByOwnerSince` from one pass over the sessions, so the total is the sum of the split. */
  async spendTotals(since: number, cost: CostOf = storedCost): Promise<{ total: number; byOwner: { owner: string | null; group: string | null; costUsd: number }[] }> {
    const rows = await this.spendSince(since, cost);
    return { total: rows.reduce((n, r) => n + r.usd, 0), byOwner: this.spendBy(rows) };
  }

  private spendBy(rows: { owner: string | null; grp: string | null; usd: number }[]): { owner: string | null; group: string | null; costUsd: number }[] {
    const by = new Map<string, { owner: string | null; group: string | null; costUsd: number }>();
    for (const r of rows) {
      const k = `${r.owner ?? ''}\u0000${r.grp ?? ''}`;
      const e = by.get(k) ?? { owner: r.owner, group: r.grp, costUsd: 0 };
      e.costUsd += r.usd;
      by.set(k, e);
    }
    return [...by.values()].sort((a, b) => b.costUsd - a.costUsd || (a.owner ?? '').localeCompare(b.owner ?? ''));
  }

  /** The group a session owner is in; null for Admin, an unknown name or a person with no group. */
  async groupOfOwner(owner: string | null): Promise<string | null> {
    if (owner === null) return null;
    const r = await this.db.get<{ grp: string }>('SELECT g.name AS grp FROM people p JOIN groups g ON g.id = p.group_id WHERE p.name = ?', [owner]);
    return r?.grp ?? null;
  }

  async distinctReporterVersions(): Promise<string[]> {
    return (await this.db.all<{ v: string }>('SELECT DISTINCT reporter_version AS v FROM sessions WHERE reporter_version IS NOT NULL')).map((r) => r.v);
  }

  // ---- agents ---------------------------------------------------------------------------------

  async upsertAgent(row: AgentRow): Promise<void> {
    const cols = Object.keys(row) as (keyof AgentRow)[];
    const sql =
      `INSERT INTO agents (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')}) ` +
      `ON CONFLICT(session_id, id) DO UPDATE SET ${cols
        .filter((c) => c !== 'id' && c !== 'session_id')
        .map((c) => `${c} = excluded.${c}`)
        .join(', ')}`;
    await this.db.run(sql, row as unknown as Params);
  }

  getAgents(sessionId: string): Promise<AgentRow[]> {
    return this.db.all<AgentRow>(
      'SELECT a.*, length(t.prompt_text) AS prompt_chars, length(t.answer_text) AS answer_chars FROM agents a ' +
        'LEFT JOIN agent_texts t ON t.session_id = a.session_id AND t.agent_id = a.id ' +
        'WHERE a.session_id = ? ORDER BY a.started_at, a.id',
      [sessionId],
    );
  }

  /** Keeps the full texts a report carried; a text the report leaves out is left as it was. */
  async upsertAgentTexts(sessionId: string, agentId: string, t: { prompt?: string; answer?: string }): Promise<void> {
    await this.db.run(
      'INSERT INTO agent_texts (session_id, agent_id, prompt_text, answer_text) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(session_id, agent_id) DO UPDATE SET ' +
        'prompt_text = COALESCE(excluded.prompt_text, agent_texts.prompt_text), answer_text = COALESCE(excluded.answer_text, agent_texts.answer_text)',
      [sessionId, agentId, t.prompt ?? null, t.answer ?? null],
    );
  }

  async getAgentTexts(sessionId: string, agentId: string): Promise<{ prompt: string | null; answer: string | null } | null> {
    const r = await this.db.get<{ prompt_text: string | null; answer_text: string | null }>('SELECT prompt_text, answer_text FROM agent_texts WHERE session_id = ? AND agent_id = ?', [sessionId, agentId]);
    return r ? { prompt: r.prompt_text, answer: r.answer_text } : null;
  }

  /** Marks every running or queued agent of a session aborted. */
  async abortOpenAgents(sessionId: string, at: number): Promise<void> {
    await this.db.run(
      `UPDATE agents SET status = 'aborted', ended_at = COALESCE(ended_at, ?)
       WHERE session_id = ? AND status IN ('running', 'queued')`,
      [at, sessionId],
    );
  }

  // ---- events ---------------------------------------------------------------------------------

  /** Inserts an event unless its id exists. Resolves true when it was new. */
  async insertEvent(row: EventRow): Promise<boolean> {
    return (
      (await this.db.run(
        `INSERT INTO events (id, session_id, agent_id, t, kind, text, data_json)
         VALUES (:id, :session_id, :agent_id, :t, :kind, :text, :data_json) ON CONFLICT DO NOTHING`,
        row as unknown as Params,
      )) > 0
    );
  }

  /** Newest first. `before` is exclusive on event time. */
  listEvents(opts: { sessionId?: string | null; before?: number | null; limit: number }): Promise<EventRow[]> {
    const before = opts.before ?? Number.MAX_SAFE_INTEGER;
    if (opts.sessionId) return this.db.all<EventRow>('SELECT * FROM events WHERE session_id = ? AND t < ? ORDER BY t DESC, id DESC LIMIT ?', [opts.sessionId, before, opts.limit]);
    return this.db.all<EventRow>('SELECT * FROM events WHERE t < ? ORDER BY t DESC, id DESC LIMIT ?', [before, opts.limit]);
  }

  async countEvents(sessionId?: string): Promise<number> {
    const r = sessionId ? await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE session_id = ?', [sessionId]) : await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events');
    return Number(r!.n);
  }

  // ---- blowouts -------------------------------------------------------------------------------

  async insertBlowout(row: Omit<BlowoutRow, 'id'>): Promise<void> {
    await this.db.run(
      `INSERT INTO blowouts (session_id, agent_id, t, kind, tokens_before, tokens_after)
       VALUES (:session_id, :agent_id, :t, :kind, :tokens_before, :tokens_after) ON CONFLICT DO NOTHING`,
      row as unknown as Params,
    );
  }

  getBlowouts(sessionId: string): Promise<BlowoutRow[]> {
    return this.db.all<BlowoutRow>('SELECT * FROM blowouts WHERE session_id = ? ORDER BY t, id', [sessionId]);
  }

  async countBlowouts(sessionId?: string): Promise<number> {
    const r = sessionId ? await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM blowouts WHERE session_id = ?', [sessionId]) : await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM blowouts');
    return Number(r!.n);
  }

  /**
   * How many times Claude Code compacted the session on its own (any loop): its stored `compact` events with trigger auto (#805).
   * Counted in code over the compact events, so the query uses no database's JSON functions (#808).
   */
  async countAutoCompactions(sessionId: string): Promise<number> {
    const rows = await this.db.all<{ data_json: string | null }>(`SELECT data_json FROM events WHERE session_id = ? AND kind = 'compact'`, [sessionId]);
    let n = 0;
    for (const r of rows) if (isAutoCompact(r.data_json)) n++;
    return n;
  }

  // ---- samples --------------------------------------------------------------------------------

  /** The latest sample strictly before second `t`. */
  sampleBefore(sessionId: string, t: number): Promise<SampleRow | undefined> {
    return this.db.get<SampleRow>('SELECT * FROM samples WHERE session_id = ? AND t < ? ORDER BY t DESC LIMIT 1', [sessionId, t]);
  }

  latestSample(sessionId: string): Promise<SampleRow | undefined> {
    return this.db.get<SampleRow>('SELECT * FROM samples WHERE session_id = ? ORDER BY t DESC LIMIT 1', [sessionId]);
  }

  /** Writes the sample for second `t`, replacing one already there (at most one per second). */
  async upsertSample(row: SampleRow): Promise<void> {
    await this.db.run(
      `INSERT INTO samples (session_id, t, tokens_total, tokens_delta, peak_context, running_agents, cost_usd, usage_json)
       VALUES (:session_id, :t, :tokens_total, :tokens_delta, :peak_context, :running_agents, :cost_usd, :usage_json)
       ON CONFLICT(session_id, t) DO UPDATE SET tokens_total = excluded.tokens_total,
         tokens_delta = excluded.tokens_delta, peak_context = excluded.peak_context,
         running_agents = excluded.running_agents, cost_usd = excluded.cost_usd,
         usage_json = CASE WHEN excluded.usage_json = '=' THEN samples.usage_json ELSE excluded.usage_json END`,
      { ...row, usage_json: row.usage_json ?? null } as unknown as Params,
    );
  }

  /** Writes a sample only if that second has none yet. */
  async insertSampleIfAbsent(row: SampleRow): Promise<void> {
    await this.db.run(
      `INSERT INTO samples (session_id, t, tokens_total, tokens_delta, peak_context, running_agents, cost_usd, usage_json)
       VALUES (:session_id, :t, :tokens_total, :tokens_delta, :peak_context, :running_agents, :cost_usd, :usage_json)
       ON CONFLICT DO NOTHING`,
      { ...row, usage_json: row.usage_json ?? null } as unknown as Params,
    );
  }

  samplesSince(sessionId: string, fromT: number): Promise<SampleRow[]> {
    return this.db.all<SampleRow>('SELECT * FROM samples WHERE session_id = ? AND t >= ? ORDER BY t', [sessionId, fromT]);
  }

  /** Σ tokens_delta per second across all sessions, for seconds >= fromT. */
  async fleetTokensPerSecond(fromT: number): Promise<{ t: number; v: number }[]> {
    return (await this.db.all<{ t: number; v: number }>('SELECT t, SUM(tokens_delta) AS v FROM samples WHERE t >= ? GROUP BY t ORDER BY t', [fromT])).map((r) => ({ t: Number(r.t), v: Number(r.v) }));
  }

  /** Positive cost increase per minute across all sessions, for seconds >= fromT (minute = floor(t/60)). */
  async fleetCostPerMinute(fromT: number, cost: CostOf = storedCost): Promise<{ m: number; v: number }[]> {
    const rows = await this.db.all<{ session_id: string; t: number; cost_usd: number | null; usage_json: string | null }>(
      'SELECT session_id, t, cost_usd, usage_json FROM samples WHERE t >= ? ORDER BY session_id, t',
      [fromT],
    );
    const by = new Map<number, number>();
    let session = '';
    let prev = 0;
    let hadUsage = false;
    let carried: string | null = null; // the last usage a sample of this session stored in full
    let lastUsage: string | null = null;
    let lastStored: number | null = null;
    let lastCost: number | null = null;
    for (const r of rows) {
      if (r.session_id !== session) carried = null;
      const usage: string | null = r.usage_json === SAME_USAGE ? carried : r.usage_json;
      carried = usage;
      // Cost depends only on the usage and the stored figure, which hardly change from one sample to the next.
      if (lastCost === null || usage === null || usage !== lastUsage || r.cost_usd !== lastStored) {
        lastCost = cost({ cost_usd: r.cost_usd, usage_json: usage });
        lastUsage = usage;
        lastStored = r.cost_usd;
      }
      const c = lastCost ?? 0;
      // The first sample in the window, or one where the source of the figure changes (an older sample priced from
      // the ledger next to a newer one priced from usage), has nothing comparable before it.
      const d = r.session_id !== session || (usage !== null) !== hadUsage ? 0 : Math.max(0, c - prev);
      session = r.session_id;
      hadUsage = usage !== null;
      prev = c;
      const m = Math.floor(r.t / 60);
      by.set(m, (by.get(m) ?? 0) + d);
    }
    return [...by].sort((a, b) => a[0] - b[0]).map(([m, v]) => ({ m, v }));
  }

  // ---- retention ------------------------------------------------------------------------------

  /** Deletes old samples, events, ended sessions (with their rows) and admin log rows. Resolves with what was deleted. */
  retain(now: number, p: RetentionPolicy): Promise<{ samples: number; events: number; sessions: number; adminLog: number }> {
    return this.db.tx(async () => {
      const samples = await this.db.run('DELETE FROM samples WHERE t < ?', [Math.floor((now - p.samplesMs) / 1000)]);
      const events = await this.db.run('DELETE FROM events WHERE t < ?', [now - p.eventsMs]);
      const cutoff = now - p.sessionsMs;
      const old = await this.db.all<{ id: string }>('SELECT id FROM sessions WHERE (ended_at IS NOT NULL AND ended_at < ?) OR (dropped_at IS NOT NULL AND dropped_at < ?)', [cutoff, cutoff]);
      for (const { id } of old) await this.removeSession(id);
      const adminLog = await this.db.run('DELETE FROM admin_log WHERE t < ? AND id NOT IN (SELECT id FROM admin_log ORDER BY id DESC LIMIT ?)', [now - p.adminLogMs, ADMIN_LOG_KEEP]);
      return { samples, events, sessions: old.length, adminLog };
    });
  }
}

/** The fleet store and the report queries over one `PgDb`. */
export const pgFleet = (db: PgDb): FleetStore => {
  const fleet = new PgFleetStore(db);
  const reports = new PgReportQueries(db);
  return Object.assign(Object.create(null), bind(fleet), bind(reports)) as FleetStore;
};

/** The methods of a class instance as own properties bound to it, so the two objects merge into one without losing `this`. */
function bind<T extends object>(o: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(o))) {
    const f = (o as Record<string, unknown>)[name];
    if (name !== 'constructor' && typeof f === 'function') out[name] = (f as (...a: unknown[]) => unknown).bind(o);
  }
  return out;
}
