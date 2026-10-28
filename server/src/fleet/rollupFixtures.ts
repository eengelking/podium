// Shared builders for the rollup and report tests (#484). Not used at run time.
import type { AgentRow, SessionRow } from './db.js';
import { openSqliteStorage, type SqliteStorage } from '../storage/sqlite/index.js';
import { Pricing } from './pricing.js';
import type { ReportDeps } from './reports.js';
import { DEFAULT_CONFIG } from './fleet.js';
import { localDay } from './rollups.js';

/** 2026-10-20 15:00 in the server's zone, so a test reads the same wherever it runs. */
export const NOW = new Date(2026, 9, 20, 15, 0, 0).getTime();
export const TODAY = localDay(NOW);
export const DAY_MS = 86_400_000;

/** A time on the day `daysAgo` before NOW, at `hour` o'clock local. */
export const at = (daysAgo: number, hour = 10): number => {
  const d = new Date(NOW);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo, hour, 0, 0).getTime();
};

export function session(over: Partial<SessionRow> & { id: string }): SessionRow {
  return {
    name: `session ${over.id}`, status: 'done', wait_reason: null, wait_note: null, end_reason: 'completed', resume_id: null,
    started_at: at(0, 9), last_seen_at: at(0, 10), ended_at: at(0, 10), dropped_at: null, cwd: '/Users/dev/demo', project_root: null,
    repo_name: 'demo', git_json: null, model: 'claude-opus-5-5', effort: 'high', context_tokens: null, context_window: null,
    context_percent: 40, cost_usd: 1, tok_in: 100, tok_out: 50, tok_cr: 10, tok_cw: 5, rate_limits_json: null,
    blowouts: 0, plan_json: null, reporter_version: '1.2.2', engine_version: '2.1.301', loop_json: null, files_json: null,
    attached: null, detached_at: null, owner: null, machine_json: null, background_json: null, usage_json: null, cleared_from: null,
    ...over,
  };
}

export function agent(sessionId: string, id: string, over: Partial<AgentRow> = {}): AgentRow {
  return {
    session_id: sessionId, id, parent_id: null, kind: 'sub', type: 'Explore', name: null, description: 'look around', model: 'claude-haiku-4-5',
    effort: null, effort_source: null, status: 'done', started_at: at(0, 9), ended_at: at(0, 10), context_tokens: null, context_window: null,
    context_percent: null, tok_in: 0, tok_out: 0, tok_cr: 0, tok_cw: 0, cost_usd_est: 0, skills_json: null, last_tool: null, tool_calls: 0,
    tool_counts_json: null, usage_json: null, blowouts: 0, steps_done: null, steps_total: null, prompt_excerpt: null, answer_excerpt: null, failure_json: null,
    ...over,
  };
}

export const failure = (cls: string, tool: string | null): string =>
  JSON.stringify({ class: cls, at: 1, tool, call: 'secret command line', exitCode: 1, outputTail: ['secret output'], evidence: [], explanation: null, retriedAs: null });

export interface World {
  /** The storage over the one in-memory database; `storage.fleet` is the async fleet store. */
  storage: SqliteStorage;
  /** The async fleet store, `storage.fleet`. */
  fdb: SqliteStorage['fleet'];
  /** The async people store, `storage.people`. */
  people: SqliteStorage['people'];
  clock: { t: number };
  deps: ReportDeps;
}

/** An empty database with the clock at NOW, the default prices and the default retention. */
export function world(): World {
  const storage = openSqliteStorage(':memory:');
  const fdb = storage.fleet;
  const people = storage.people;
  const clock = { t: NOW };
  const pricing = new Pricing({});
  return { storage, fdb, people, clock, deps: { db: fdb, now: () => clock.t, pricing: () => pricing, retention: DEFAULT_CONFIG.retention } };
}

/**
 * Two groups of people and a spread of sessions over the last days: Priya (Backend) and Dana (no group) report, Quiet is
 * known and has not, and a session of the Admin has no group. Returns the session ids by name.
 */
export async function populate(w: World): Promise<void> {
  const backend = await w.people.createGroup('Backend', NOW);
  const priya = (await w.people.createPerson('Priya', backend.id, NOW - 60 * DAY_MS)).person;
  await w.people.createPerson('Dana', null, NOW - 60 * DAY_MS);
  await w.people.createPerson('Quiet', null, NOW - 60 * DAY_MS);
  const raw = w.storage.sqliteHandle;
  raw.prepare('UPDATE people SET last_report_at = ? WHERE id = ?').run(at(0, 10), priya.id);
  raw.prepare("UPDATE people SET last_report_at = ? WHERE name = 'Dana'").run(at(2, 10));
  const add = (s: Parameters<typeof session>[0]) => w.fdb.upsertSession(session(s));
  // Priya: three days of work, one on a model nobody priced, one with agents and a failure.
  await add({ id: 'p1', owner: 'Priya', started_at: at(3, 9), last_seen_at: at(3, 11), ended_at: at(3, 11), cost_usd: 2, usage_json: JSON.stringify([{ model: 'claude-opus-5-5', tier: 'std', tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } }]), plan_json: JSON.stringify({ title: null, source: 'TodoWrite', steps: [] }), machine_json: JSON.stringify({ name: 'mbp', id: 'm1' }), blowouts: 1, context_percent: 91 });
  await add({ id: 'p2', owner: 'Priya', started_at: at(2, 9), last_seen_at: at(2, 12), ended_at: at(2, 12), cost_usd: null, model: 'llama-local', end_reason: 'error' });
  await add({ id: 'p3', owner: 'Priya', started_at: at(1, 9), last_seen_at: at(1, 10), ended_at: at(1, 10), cost_usd: 3, repo_name: 'api', reporter_version: '1.2.1' });
  await add({ id: 'p4', owner: 'Priya', started_at: at(1, 22), last_seen_at: at(0, 1), ended_at: null, status: 'running', end_reason: null, cost_usd: 4 });
  await add({ id: 'd1', owner: 'Dana', started_at: at(2, 9), last_seen_at: at(2, 10), ended_at: at(2, 10), cost_usd: 1.5, model: 'claude-sonnet-5-5', effort: null });
  await add({ id: 'a1', owner: 'Admin', started_at: at(0, 9), last_seen_at: at(0, 10), ended_at: at(0, 10), cost_usd: 0.5 });
  await add({ id: 'n1', owner: null, started_at: at(0, 11), last_seen_at: at(0, 12), ended_at: at(0, 12), cost_usd: 0.25, repo_name: null, model: null, effort: null });
  // p4 ran over midnight: its last sample before it had spent nothing, so all 4 of its cost came today.
  await w.fdb.insertSampleIfAbsent({ session_id: 'p4', t: Math.floor(at(1, 23) / 1000), tokens_total: 0, tokens_delta: 0, peak_context: 0, running_agents: 0, cost_usd: 0 });
  await w.fdb.upsertAgent(agent('p1', 'g1', { cost_usd_est: 0.5, failure_json: failure('permission', 'Bash') }));
  await w.fdb.upsertAgent(agent('p1', 'g2', { cost_usd_est: 0.5, failure_json: failure('timeout', 'WebFetch') }));
  await w.fdb.upsertAgent(agent('p3', 'g3', { cost_usd_est: 1.5, failure_json: failure('permission', 'Bash') }));
  await w.fdb.upsertAgent(agent('p4', 'g4', { cost_usd_est: 1 }));
  await w.fdb.upsertAgent(agent('p4', 'g5', { cost_usd_est: 1 }));
  raw.prepare("INSERT INTO reporters (key, kind, machine_id, owner, reporter_version, engine_version, first_seen_at, last_seen_at) VALUES ('m1', 'mod', 'm1', 'Priya', '1.2.2', '2.1.301', 1, 2)").run();
  raw.prepare("INSERT INTO reporter_sessions (reporter_key, session_id) VALUES ('m1', 'p1'), ('m1', 'p3')").run();
}
