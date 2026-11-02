import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { ACTIVITY_STEPS, MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { pgFleet } from './fleet.js';
import { pgPeople } from './people.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';
import { SAME_USAGE, type AgentRow, type SessionRow } from '../rows.js';
import type { FleetStore, PeopleStoreApi } from '../types.js';

function session(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 's1', name: 'demo', status: 'running', wait_reason: null, wait_note: null, end_reason: null, resume_id: null,
    started_at: 1000, last_seen_at: 2000, ended_at: null, dropped_at: null, cwd: '/tmp/demo', project_root: null,
    repo_name: null, git_json: null, model: 'opus', effort: 'high', context_tokens: null, context_window: null,
    context_percent: null, cost_usd: 1.5, tok_in: 0, tok_out: 0, tok_cr: 0, tok_cw: 0, rate_limits_json: null,
    blowouts: 0, plan_json: null, reporter_version: '0.1.0', engine_version: null, loop_json: null, files_json: null, attached: null, detached_at: null, owner: null, machine_json: null, background_json: null, usage_json: null, cleared_from: null, harness: 'claude-code', cost_source: null,
    ...over,
  };
}

function agent(sessionId: string, id: string, over: Partial<AgentRow> = {}): AgentRow {
  return {
    session_id: sessionId, id, parent_id: null, kind: 'sub', type: 'Explore', name: null, description: 'look', model: null, effort: null, effort_source: null,
    status: 'running', started_at: 10, ended_at: null, context_tokens: null, context_window: null, context_percent: null, tok_in: 0, tok_out: 0, tok_cr: 0,
    tok_cw: 0, cost_usd_est: 0, skills_json: null, last_tool: null, tool_calls: 0, tool_counts_json: null, usage_json: null, blowouts: 0, steps_done: null,
    steps_total: null, prompt_excerpt: null, answer_excerpt: null, failure_json: null, ...over,
  };
}

describe.skipIf(!TEST_PG)('postgres fleet store', () => {
  let td: TestDatabase;
  let db: PgDb;
  let f: FleetStore;
  let people: PeopleStoreApi;
  beforeAll(async () => {
    td = await createTestDatabase();
    db = new PgDb({ connectionString: td.url, schema: MAIN_SCHEMA, max: 4, name: 'test' });
    await migrate(db, MAIN_SCHEMA, MAIN_STEPS);
    f = pgFleet(db);
    people = pgPeople(db);
    void ACTIVITY_STEPS;
  });
  afterAll(async () => {
    await db.close();
    await td.drop();
  });
  beforeEach(async () => {
    await db.exec('TRUNCATE sessions, agents, agent_texts, events, blowouts, samples, people, admin_log RESTART IDENTITY CASCADE');
    await db.exec("DELETE FROM groups WHERE name_lower <> 'administrators'");
  });

  it('stores hostile strings as data, never as SQL', async () => {
    const evil = "'); DROP TABLE sessions;--";
    await f.upsertSession(session({ name: evil, id: evil }));
    await f.insertEvent({ id: evil, session_id: evil, agent_id: null, t: 1, kind: 'note', text: evil, data_json: null });
    expect((await f.getSession(evil))?.name).toBe(evil);
    expect((await f.listEvents({ sessionId: evil, limit: 10 }))[0]?.text).toBe(evil);
    expect(await db.get("SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'sessions'")).toBeDefined();
  });

  it('counts a session\'s automatic compaction events, and nothing else', async () => {
    await f.upsertSession(session());
    await f.upsertSession(session({ id: 's2' }));
    const ev = (id: string, sid: string, agentId: string | null, kind: string, data: string | null) => ({ id, session_id: sid, agent_id: agentId, t: 1, kind, text: 'x', data_json: data });
    await f.insertEvent(ev('e1', 's1', null, 'compact', '{"trigger":"auto","percent":22}'));
    await f.insertEvent(ev('e2', 's1', 'ag1', 'compact', '{"percent":30,"trigger":"auto"}'));
    await f.insertEvent(ev('e3', 's1', null, 'compact', '{"tokensBefore":1}'));
    await f.insertEvent(ev('e4', 's1', null, 'compact', null));
    await f.insertEvent(ev('e5', 's1', null, 'blow', '{"trigger":"auto"}'));
    await f.insertEvent(ev('e6', 's1', null, 'compact', '{"trigger":"AUTO"}'));
    await f.insertEvent(ev('e7', 's1', null, 'compact', '["auto"]'));
    await f.insertEvent(ev('e8', 's1', null, 'compact', 'null'));
    await f.insertEvent(ev('e9', 's2', null, 'compact', '{"trigger":"auto"}'));
    expect(await f.countAutoCompactions('s1')).toBe(2);
    expect(await f.countAutoCompactions('s2')).toBe(1);
    expect(await f.countAutoCompactions('nobody')).toBe(0);
  });

  it('does not throw on a compact event whose data is not valid JSON, and does not count it', async () => {
    await f.upsertSession(session());
    const ev = (id: string, data: string) => ({ id, session_id: 's1', agent_id: null, t: 1, kind: 'compact', text: 'x', data_json: data });
    await f.insertEvent(ev('good', '{"trigger":"auto"}'));
    await f.insertEvent(ev('bad1', '{"trigger":"auto"'));
    await f.insertEvent(ev('bad2', 'not json'));
    await f.insertEvent(ev('bad3', ''));
    expect(await f.countAutoCompactions('s1')).toBe(1);
  });

  it('upserts sessions, ignores duplicate events and blowouts and deletes a session with its rows', async () => {
    await f.upsertSession(session());
    await f.upsertSession(session({ name: 'renamed' }));
    expect((await f.getSession('s1'))?.name).toBe('renamed');
    const ev = { id: 'e1', session_id: 's1', agent_id: null, t: 5, kind: 'note', text: 'x', data_json: null };
    expect(await f.insertEvent(ev)).toBe(true);
    expect(await f.insertEvent(ev)).toBe(false);
    await f.insertBlowout({ session_id: 's1', agent_id: 'a', t: 5, kind: 'auto-compact', tokens_before: 1, tokens_after: 0 });
    await f.insertBlowout({ session_id: 's1', agent_id: 'a', t: 5, kind: 'auto-compact', tokens_before: 1, tokens_after: 0 });
    expect(await f.countBlowouts('s1')).toBe(1);
    expect(await f.countBlowouts()).toBe(1);
    expect(await f.countEvents('s1')).toBe(1);
    await f.upsertAgent(agent('s1', 'a1'));
    await f.upsertAgentTexts('s1', 'a1', { prompt: 'p' });
    await f.upsertSample({ session_id: 's1', t: 1, tokens_total: 1, tokens_delta: 1, peak_context: 0, running_agents: 0, cost_usd: 1 });
    expect(await f.deleteSession('s1')).toBe(true);
    expect(await f.getSession('s1')).toBeUndefined();
    expect(await f.countEvents()).toBe(0);
    expect(await f.getAgents('s1')).toEqual([]);
    expect(await f.getAgentTexts('s1', 'a1')).toBeNull();
    expect(await f.latestSample('s1')).toBeUndefined();
    expect(await f.deleteSession('s1')).toBe(false);
  });

  it('keeps every blowout of an agent-less session, because a NULL agent is distinct in the unique key', async () => {
    await f.upsertSession(session());
    const b = { session_id: 's1', agent_id: null, t: 5, kind: 'auto-compact', tokens_before: 1, tokens_after: 0 };
    await f.insertBlowout(b);
    await f.insertBlowout(b);
    await f.insertBlowout({ ...b, t: 4 });
    expect((await f.getBlowouts('s1')).map((r) => r.t)).toEqual([4, 5, 5]);
    expect(typeof (await f.getBlowouts('s1'))[0]!.id).toBe('number');
  });

  it('reads sessions back as stored, in the live and ended orderings', async () => {
    await f.upsertSession(session({ id: 'b', started_at: 10 }));
    await f.upsertSession(session({ id: 'a', started_at: 10 }));
    await f.upsertSession(session({ id: 'c', started_at: 5, ended_at: 100, last_seen_at: 100 }));
    await f.upsertSession(session({ id: 'd', started_at: 6, ended_at: 50 }));
    await f.upsertSession(session({ id: 'e', started_at: 7, dropped_at: 60 }));
    expect((await f.liveCandidates(60)).map((s) => s.id)).toEqual(['c', 'a', 'b']);
    expect((await f.endedBetween(40, 70)).map((s) => s.id)).toEqual(['d', 'e']);
    await f.setDropped('a', 3);
    expect((await f.liveCandidates(60)).map((s) => s.id)).toEqual(['c', 'b']);
    expect((await f.getSession('a'))?.dropped_at).toBe(3);
    expect(await f.getSession('none')).toBeUndefined();
    await f.upsertSession(session({ id: 'n1', cleared_from: 'a', started_at: 1 }));
    await f.upsertSession(session({ id: 'n2', cleared_from: 'a', started_at: 2 }));
    expect(await f.clearedInto('a')).toBe('n2');
    expect(await f.clearedInto('b')).toBeNull();
    await f.upsertSession(session({ id: 'v', reporter_version: '9.9.9' }));
    expect((await f.distinctReporterVersions()).sort()).toEqual(['0.1.0', '9.9.9']);
  });

  it('keeps agents with their text sizes, keeps a text a later report leaves out, and aborts the open ones', async () => {
    await f.upsertSession(session());
    await f.upsertAgent(agent('s1', 'z', { started_at: 20 }));
    await f.upsertAgent(agent('s1', 'a', { started_at: 10, status: 'queued' }));
    await f.upsertAgent(agent('s1', 'd', { started_at: 30, status: 'done', ended_at: 40 }));
    await f.upsertAgent(agent('s1', 'a', { started_at: 10, status: 'queued', description: 'again' }));
    await f.upsertAgentTexts('s1', 'a', { prompt: 'héllo' });
    await f.upsertAgentTexts('s1', 'a', { answer: 'ok' });
    const agents = await f.getAgents('s1');
    expect(agents.map((a) => a.id)).toEqual(['a', 'z', 'd']);
    expect(agents[0]!.description).toBe('again');
    expect(agents[0]).toMatchObject({ prompt_chars: 5, answer_chars: 2 });
    expect(agents[1]).toMatchObject({ prompt_chars: null, answer_chars: null });
    expect(await f.getAgentTexts('s1', 'a')).toEqual({ prompt: 'héllo', answer: 'ok' });
    expect(await f.getAgentTexts('s1', 'z')).toBeNull();
    await f.abortOpenAgents('s1', 99);
    const after = await f.getAgents('s1');
    expect(after.map((a) => [a.status, a.ended_at])).toEqual([['aborted', 99], ['aborted', 99], ['done', 40]]);
  });

  it('lists events newest first with a stable tie order, a cut-off and a limit', async () => {
    await f.upsertSession(session());
    await f.upsertSession(session({ id: 's2' }));
    const ev = (id: string, sid: string, t: number) => ({ id, session_id: sid, agent_id: null, t, kind: 'note', text: id, data_json: null });
    for (const e of [ev('a', 's1', 1), ev('b', 's1', 2), ev('c', 's1', 2), ev('d', 's2', 3)]) await f.insertEvent(e);
    expect((await f.listEvents({ limit: 10 })).map((e) => e.id)).toEqual(['d', 'c', 'b', 'a']);
    expect((await f.listEvents({ sessionId: 's1', limit: 10 })).map((e) => e.id)).toEqual(['c', 'b', 'a']);
    expect((await f.listEvents({ before: 3, limit: 2 })).map((e) => e.id)).toEqual(['c', 'b']);
    expect(await f.countEvents()).toBe(4);
  });

  it('writes samples one per second, keeps the usage a "=" sample refers to, and answers undefined when there is none', async () => {
    const base = { tokens_total: 1, tokens_delta: 1, peak_context: 0.5, running_agents: 1, cost_usd: 1 };
    expect(await f.latestSample('s1')).toBeUndefined();
    expect(await f.sampleBefore('s1', 10)).toBeUndefined();
    await f.upsertSample({ session_id: 's1', t: 10, ...base, usage_json: '[1]' });
    await f.upsertSample({ session_id: 's1', t: 10, ...base, tokens_total: 2, usage_json: SAME_USAGE });
    expect(await f.latestSample('s1')).toMatchObject({ t: 10, tokens_total: 2, usage_json: '[1]' });
    await f.upsertSample({ session_id: 's1', t: 10, ...base, usage_json: '[2]' });
    expect((await f.latestSample('s1'))!.usage_json).toBe('[2]');
    await f.upsertSample({ session_id: 's1', t: 10, ...base });
    expect((await f.latestSample('s1'))!.usage_json).toBeNull();
    await f.insertSampleIfAbsent({ session_id: 's1', t: 10, ...base, tokens_total: 99 });
    await f.insertSampleIfAbsent({ session_id: 's1', t: 20, ...base });
    expect((await f.samplesSince('s1', 10)).map((s) => [s.t, s.tokens_total])).toEqual([[10, 1], [20, 1]]);
    expect((await f.samplesSince('s1', 11)).map((s) => s.t)).toEqual([20]);
    expect((await f.sampleBefore('s1', 20))!.t).toBe(10);
    expect((await f.latestSample('s1'))!.t).toBe(20);
  });

  it('sums tokens per second across sessions, as numbers', async () => {
    const s = (id: string, t: number, d: number) => f.upsertSample({ session_id: id, t, tokens_total: d, tokens_delta: d, peak_context: 0, running_agents: 0, cost_usd: null });
    await s('a', 5, 3);
    await s('b', 5, 4);
    await s('a', 6, 10);
    await s('a', 1, 100);
    expect(await f.fleetTokensPerSecond(2)).toEqual([{ t: 5, v: 7 }, { t: 6, v: 10 }]);
  });

  it('adds the positive cost increase per minute, restarting at a new session and where the cost source changes', async () => {
    const s = (id: string, t: number, cost: number | null, usage?: string | null) =>
      f.upsertSample({ session_id: id, t, tokens_total: 0, tokens_delta: 0, peak_context: 0, running_agents: 0, cost_usd: cost, usage_json: usage });
    await s('a', 10, 1);
    await s('a', 20, 3);
    await s('a', 70, 2);
    await s('a', 80, 2.5);
    await s('b', 15, 5);
    await s('b', 25, 6);
    expect(await f.fleetCostPerMinute(0)).toEqual([{ m: 0, v: 3 }, { m: 1, v: 0.5 }]);
    const byUsage = (r: { usage_json: string | null; cost_usd: number | null }) => (r.usage_json === null ? (r.cost_usd ?? 0) : 10);
    await s('c', 130, 1, '[1]');
    await s('c', 140, 1, SAME_USAGE);
    await s('c', 150, 2, '[2]');
    expect((await f.fleetCostPerMinute(125, byUsage)).map((x) => x.m)).toEqual([2]);
  });

  describe('spend since a moment (#139)', () => {
    const MIDNIGHT = 1_000_000; // ms
    const sample = (id: string, tSec: number, cost: number, usage?: string) =>
      f.upsertSample({ session_id: id, t: tSec, tokens_total: 0, tokens_delta: 0, peak_context: 0, running_agents: 0, cost_usd: cost, usage_json: usage });

    it('counts only what a session started before the moment spent after it', async () => {
      await f.upsertSession(session({ id: 'long', started_at: MIDNIGHT - 3_600_000, cost_usd: 14 }));
      await sample('long', MIDNIGHT / 1000 - 5, 10);
      await sample('long', MIDNIGHT / 1000 + 500, 14);
      await f.upsertSession(session({ id: 'new', started_at: MIDNIGHT + 1000, cost_usd: 2 }));
      await f.upsertSession(session({ id: 'done', started_at: MIDNIGHT - 7_200_000, ended_at: MIDNIGHT - 60_000, cost_usd: 5 }));
      await sample('done', MIDNIGHT / 1000 - 70, 5);
      expect(await f.costSince(MIDNIGHT)).toBeCloseTo(6, 9);
    });

    it('follows repricing in proportion, and the owner split adds up to the total', async () => {
      await f.upsertSession(session({ id: 'long', owner: 'Dana K.', started_at: MIDNIGHT - 3_600_000, cost_usd: 10 }));
      await sample('long', MIDNIGHT / 1000 - 5, 5);
      await sample('long', MIDNIGHT / 1000 + 500, 10);
      await f.upsertSession(session({ id: 'new', owner: null, started_at: MIDNIGHT + 1000, cost_usd: 1 }));
      const doubled = (r: { cost_usd: number | null }) => (r.cost_usd ?? 0) * 2;
      expect(await f.costSince(MIDNIGHT, doubled)).toBeCloseTo(12, 9);
      const by = await f.costByOwnerSince(MIDNIGHT, doubled);
      expect(by.reduce((n, r) => n + r.costUsd, 0)).toBeCloseTo(12, 9);
      expect(by.find((r) => r.owner === 'Dana K.')?.costUsd).toBeCloseTo(10, 9);
      const both = await f.spendTotals(MIDNIGHT, doubled);
      expect(both.total).toBeCloseTo(await f.costSince(MIDNIGHT, doubled), 9);
      expect(both.byOwner).toEqual(by);
    });

    it('splits a session with no ledger figure by the priced usage on the sample before, following "=" back to a full one', async () => {
      await f.upsertSession(session({ id: 'local', started_at: MIDNIGHT - 3_600_000, cost_usd: null, usage_json: '[2]' }));
      await sample('local', MIDNIGHT / 1000 - 20, 0, '[1]');
      await sample('local', MIDNIGHT / 1000 - 10, 0, SAME_USAGE);
      const byUsage = (r: { usage_json: string | null }) => (r.usage_json === '[1]' ? 3 : r.usage_json === '[2]' ? 10 : null);
      expect(await f.costSince(MIDNIGHT, byUsage)).toBeCloseTo(7, 9);
      // No sample before the moment: the first one stands in for it. No usage at all: nothing is taken away.
      await f.upsertSession(session({ id: 'late', started_at: MIDNIGHT - 100, cost_usd: null, usage_json: '[2]' }));
      await sample('late', MIDNIGHT / 1000 + 5, 0, '[1]');
      await f.upsertSession(session({ id: 'bare', started_at: MIDNIGHT - 100, cost_usd: null, usage_json: '[2]' }));
      const rows = await f.sessionSpendSince(MIDNIGHT, byUsage);
      expect(rows.find((r) => r.id === 'late')!.usd).toBeCloseTo(7, 9);
      expect(rows.find((r) => r.id === 'bare')!.usd).toBeCloseTo(10, 9);
      expect(rows.find((r) => r.id === 'bare')!.priced).toBe(true);
    });

    it('prices agents per session, skipping unpriced ones', async () => {
      await f.upsertSession(session({ id: 'x', started_at: MIDNIGHT + 1 }));
      await f.upsertSession(session({ id: 'old', started_at: 1, ended_at: 2 }));
      await f.upsertAgent(agent('x', 'a', { cost_usd_est: 1.5 }));
      await f.upsertAgent(agent('x', 'b', { cost_usd_est: 2 }));
      await f.upsertAgent(agent('old', 'c', { cost_usd_est: 9 }));
      expect(await f.agentCostsSince(MIDNIGHT, (r) => r.cost_usd)).toEqual(new Map([['x', 3.5]]));
    });
  });

  it('splits today\'s cost by owner with each owner\'s group, and finds an owner\'s group', async () => {
    const backend = await people.createGroup('Backend');
    await people.createPerson('Priya N.', backend.id);
    await people.createPerson('Dana K.');
    await f.upsertSession(session({ id: 'a', owner: 'Priya N.', cost_usd: 2, started_at: 5000 }));
    await f.upsertSession(session({ id: 'b', owner: 'Priya N.', cost_usd: 3, started_at: 6000 }));
    await f.upsertSession(session({ id: 'c', owner: 'Dana K.', cost_usd: 1, started_at: 6000 }));
    await f.upsertSession(session({ id: 'd', owner: 'Admin', cost_usd: 0.5, started_at: 6000 }));
    await f.upsertSession(session({ id: 'e', owner: null, cost_usd: 0.25, started_at: 6000 }));
    await f.upsertSession(session({ id: 'old', owner: 'Dana K.', cost_usd: 9, started_at: 10, ended_at: 20 }));
    await f.upsertSession(session({ id: 'unpriced', owner: 'Dana K.', cost_usd: null, started_at: 6000 }));
    expect(await f.costByOwnerSince(1000)).toEqual([
      { owner: 'Priya N.', group: 'Backend', costUsd: 5 },
      { owner: 'Dana K.', group: null, costUsd: 1 },
      { owner: 'Admin', group: null, costUsd: 0.5 },
      { owner: null, group: null, costUsd: 0.25 },
    ]);
    expect((await f.costByOwnerSince(1000)).reduce((n, r) => n + r.costUsd, 0)).toBe(await f.costSince(1000));
    expect(await f.groupOfOwner('Priya N.')).toBe('Backend');
    expect(await f.groupOfOwner('Dana K.')).toBeNull();
    expect(await f.groupOfOwner('Admin')).toBeNull();
    expect(await f.groupOfOwner(null)).toBeNull();
  });

  describe('retention', () => {
    const DAY = 24 * 3600_000;
    const policy = { samplesMs: DAY, eventsMs: 30 * DAY, sessionsMs: 30 * DAY, adminLogMs: 90 * DAY };
    const NOW = 1_000 * DAY;

    it('removes old samples, events and ended or dropped sessions with their rows, and keeps the rest', async () => {
      const ev = (id: string, sid: string, t: number) => ({ id, session_id: sid, agent_id: null, t, kind: 'note', text: id, data_json: null });
      const smp = (sid: string, t: number) => ({ session_id: sid, t, tokens_total: 0, tokens_delta: 0, peak_context: 0, running_agents: 0, cost_usd: null });
      await f.upsertSession(session({ id: 'gone', ended_at: NOW - 31 * DAY }));
      await f.upsertSession(session({ id: 'dropped', dropped_at: NOW - 31 * DAY }));
      await f.upsertSession(session({ id: 'live' }));
      await f.upsertSession(session({ id: 'recent', ended_at: NOW - DAY }));
      await f.upsertAgent(agent('gone', 'a'));
      await f.upsertAgentTexts('gone', 'a', { prompt: 'p' });
      await f.insertEvent(ev('e-old', 'live', NOW - 31 * DAY));
      await f.insertEvent(ev('e-new', 'live', NOW - DAY));
      await f.insertEvent(ev('e-gone', 'gone', NOW - DAY));
      await f.upsertSample(smp('live', Math.floor((NOW - 2 * DAY) / 1000)));
      await f.upsertSample(smp('live', Math.floor((NOW - 1000) / 1000)));
      await f.insertBlowout({ session_id: 'gone', agent_id: null, t: 1, kind: 'k', tokens_before: 1, tokens_after: 1 });
      expect(await f.retain(NOW, policy)).toEqual({ samples: 1, events: 1, sessions: 2, adminLog: 0 });
      expect(await db.all('SELECT id FROM sessions ORDER BY id')).toEqual([{ id: 'live' }, { id: 'recent' }]);
      expect(await f.countEvents()).toBe(1);
      expect(await f.countBlowouts()).toBe(0);
      expect(await db.get('SELECT COUNT(*) AS n FROM agent_texts')).toEqual({ n: 0 });
      expect((await f.samplesSince('live', 0)).length).toBe(1);
    });

    it('removes admin log rows older than the period and keeps newer ones', async () => {
      for (let i = 0; i < 30; i++) await people.log('old', `old${i}`, '1.2.3.4', NOW - 91 * DAY - i);
      await people.log('new', 'edge', '1.2.3.4', NOW - 89 * DAY);
      for (let i = 0; i < 110; i++) await people.log('new', `new${i}`, '1.2.3.4', NOW - i);
      expect((await f.retain(NOW, policy)).adminLog).toBe(30);
      expect((await people.listLog({ page: 1, pageSize: 10 })).total).toBe(111);
      expect(await db.get("SELECT COUNT(*) AS n FROM admin_log WHERE kind = 'old'")).toEqual({ n: 0 });
      expect(await db.get("SELECT COUNT(*) AS n FROM admin_log WHERE detail = 'edge'")).toEqual({ n: 1 });
    });

    it('always keeps the newest 100 rows, however old, so a quiet server keeps some history', async () => {
      for (let i = 0; i < 120; i++) await people.log('old', `n${i}`, '1.2.3.4', NOW - 365 * DAY + i);
      expect((await f.retain(NOW, policy)).adminLog).toBe(20);
      expect((await people.listLog({ page: 1, pageSize: 10 })).total).toBe(100);
      expect((await people.listLog({ page: 1, pageSize: 10 })).rows[0]!.detail).toBe('n119');
      expect(await db.get('SELECT MIN(id) AS m FROM admin_log')).toEqual({ m: 21 });
    });
  });
});
