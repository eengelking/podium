// Admin > Reporting > Sessions and Usage (#722): how long sessions ran and waited, which agents they launched, who ran sessions on a day, and the
// busiest hours, for every harness, through the Admin API.
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAdminRouter } from '../admin/adminRouter.js';
import { toCsv, type ReportReply } from './reports.js';
import { addDays, costFn, writeRollups } from './rollups.js';
import { DAY_MS, NOW, TODAY, agent, at, session, world, type World } from '../storage/sqlite/rollupFixtures.js';
import type { SessionWaitRow } from '../storage/rows.js';

const SECRET = 'the-admin-secret-0123456789';
const H = { 'X-Podium-Admin': '1' };

async function api(w: World) {
  await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), { sessionsMs: 30 * DAY_MS });
  const app = express();
  app.use('/api/admin', createAdminRouter({ secret: SECRET, storage: w.storage, people: w.people, reports: w.deps, now: () => NOW }));
  const agentReq = request.agent(app);
  await agentReq.post('/api/admin/unlock').set(H).send({ name: 'Admin', token: SECRET });
  return { get: (path: string) => agentReq.get(`/api/admin/reports/${path}`).set(H) };
}

const wait = (id: string, over: Partial<SessionWaitRow> = {}): SessionWaitRow => ({
  session_id: id, permission_ms: 0, permission_n: 0, question_ms: 0, question_n: 0, plan_ms: 0, plan_n: 0, tracked_since: at(3, 9), open_kind: null, open_since: null, ...over,
});
const sample = (id: string, t: number) => ({ session_id: id, t: Math.floor(t / 1000), tokens_total: 0, tokens_delta: 0, peak_context: 0, running_agents: 0, cost_usd: null });
const D3 = addDays(TODAY, -3);
const D5 = addDays(TODAY, -5);

/**
 * Three days ago: Maya ran two Claude Code sessions (an hour each, one waited on permissions and a question) and Jonas one OpenCode session of half an hour
 * with a question. Five days ago a Claude Code session with no wait record (stored before waits were kept). Today one Claude Code session, read live.
 */
async function filled(): Promise<World> {
  const w = world();
  const g = await w.people.createGroup('Platform', NOW);
  await w.people.createPerson('Maya', g.id, NOW - 60 * DAY_MS);
  await w.people.createPerson('Jonas', null, NOW - 60 * DAY_MS);
  const add = (id: string, owner: string, daysAgo: number, harness: string, minutes: number) =>
    w.fdb.upsertSession(session({ id, owner, harness, started_at: at(daysAgo, 9), last_seen_at: at(daysAgo, 9) + minutes * 60_000, ended_at: at(daysAgo, 9) + minutes * 60_000 }));
  await add('c1', 'Maya', 3, 'claude-code', 60);
  await add('c2', 'Maya', 3, 'claude-code', 60);
  await add('o1', 'Jonas', 3, 'opencode', 30);
  await add('c0', 'Maya', 5, 'claude-code', 40);
  await add('c3', 'Maya', 0, 'claude-code', 20);
  await w.fdb.putSessionWait(wait('c1', { permission_ms: 120_000, permission_n: 2, question_ms: 180_000, question_n: 1 }));
  await w.fdb.putSessionWait(wait('c2', { plan_ms: 60_000, plan_n: 1 }));
  await w.fdb.putSessionWait(wait('o1', { question_ms: 60_000, question_n: 2 }));
  await w.fdb.upsertAgent(agent('c1', 'a1', { type: 'Explore' }));
  await w.fdb.upsertAgent(agent('c1', 'a2', { type: 'Explore', parent_id: 'a1' }));
  await w.fdb.upsertAgent(agent('c2', 'a3', { type: 'Plan' }));
  await w.fdb.upsertAgent(agent('o1', 'b1', { type: 'general' }));
  await w.fdb.upsertAgent(agent('o1', 'b2', { type: 'general', parent_id: 'b1' }));
  await w.fdb.upsertAgent(agent('o1', 'b3', { type: 'general', parent_id: 'b2' }));
  await w.fdb.upsertAgent(agent('o1', 'b4', { type: 'general', parent_id: 'b3' }));
  // live sessions overlap from 10:00 to 10:30 three days ago: two Claude Code and one OpenCode in the hour of ten
  for (const [id, from, to] of [['c1', at(3, 9) + 30 * 60_000, at(3, 10) + 30 * 60_000], ['c2', at(3, 10), at(3, 10) + 30 * 60_000], ['o1', at(3, 10), at(3, 10) + 20 * 60_000]] as const) {
    await w.fdb.upsertSample(sample(id, from));
    await w.fdb.upsertSample(sample(id, to));
  }
  return w;
}

const rowsOf = (r: ReportReply): string[] => r.rows.map((x) => Object.values(x).join('|'));

describe('sessiontime: length and waiting', () => {
  it('has a row for each period and harness, with a dash for waiting where no session recorded it', async () => {
    const { get } = await api(await filled());
    const r = (await get(`sessiontime?from=${D5}&to=${TODAY}&by=day`)).body as ReportReply;
    expect(r.report).toBe('sessiontime');
    expect(r.columns.map((c) => c.key)).toEqual(['period', 'harness', 'sessions', 'avgDurationS', 'maxDurationS', 'waitS', 'waitSharePct']);
    expect(rowsOf(r)).toEqual([
      // c0 has no wait record, so its waiting is null (never zero)
      `${D5}|claude-code|1|2400|2400||`,
      // 360 s over the 7200 s the two tracked sessions ran
      `${D3}|claude-code|2|3600|3600|360|5`,
      `${D3}|opencode|1|1800|1800|60|3.3`,
      `${TODAY}|claude-code|1|1200|1200||`,
    ]);
    expect(r.waitSince).toBe(D3);
    expect(r.harnesses).toEqual(['claude-code', 'opencode']);
    expect(r.basedOn).toBe('rollups and live');
  });

  it('gives the periods and each harness over the whole period, with the share taken only over sessions that can say', async () => {
    const { get } = await api(await filled());
    const r = (await get(`sessiontime?from=${D5}&to=${TODAY}&by=week`)).body as ReportReply;
    const whole = r.total as Record<string, number>;
    expect(whole).toMatchObject({ sessions: 5, maxDurationS: 3600 });
    // 420 s of waiting over the 9000 s that the three tracked sessions ran
    expect(whole.waitS).toBe(420);
    expect(whole.waitSharePct).toBe(4.7);
    expect((r.byHarness as Record<string, unknown>[]).map((x) => `${x.harness}=${x.sessions}`)).toEqual(['claude-code=4', 'opencode=1']);
    expect((r.periods as Record<string, unknown>[]).every((x) => x.harness === undefined)).toBe(true);
  });

  it('narrows to one harness', async () => {
    const { get } = await api(await filled());
    const r = (await get(`sessiontime?from=${D5}&to=${TODAY}&by=day&harness=opencode`)).body as ReportReply;
    expect(rowsOf(r)).toEqual([`${D3}|opencode|1|1800|1800|60|3.3`]);
  });

  it('refuses a person, group or model filter, which the figures are not kept by, instead of ignoring it', async () => {
    const { get } = await api(await filled());
    for (const f of ['person=Maya', 'group=Platform', 'model=opus']) {
      const res = await get(`sessiontime?from=${D5}&to=${TODAY}&${f}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/cannot be filtered by person, group or model/);
    }
  });

  it('refuses a breakdown it does not have and a harness that is not an id', async () => {
    const { get } = await api(await filled());
    expect((await get(`sessiontime?breakdown=nope`)).status).toBe(400);
    expect((await get(`sessiontime?harness=Bad%20Id`)).status).toBe(400);
  });

  it('says there is no history before the first rollup, and shows a dash for waiting when nothing recorded it', async () => {
    const w = world();
    await w.fdb.upsertSession(session({ id: 'old', started_at: at(2, 9), last_seen_at: at(2, 10), ended_at: at(2, 10) }));
    const { get } = await api(w);
    const r = (await get(`sessiontime?from=${addDays(TODAY, -20)}&to=${TODAY}&by=day`)).body as ReportReply;
    expect(r.partial).toBe(true);
    expect(r.waitSince).toBeNull();
    expect(r.rows.every((x) => x.waitS === null)).toBe(true);
  });
});

describe('sessiontime: what sessions waited for', () => {
  it('splits the waiting by kind and harness, and the kinds add up to the total', async () => {
    const { get } = await api(await filled());
    const r = (await get(`sessiontime?from=${D5}&to=${TODAY}&breakdown=reason`)).body as ReportReply;
    expect(r.columns.map((c) => c.key)).toEqual(['reason', 'harness', 'waits', 'waitS', 'avgWaitS', 'sharePct']);
    expect(rowsOf(r)).toEqual(['permission|claude-code|2|120|60|28.6', 'question|claude-code|1|180|180|42.9', 'question|opencode|2|60|30|14.3', 'plan|claude-code|1|60|60|14.3']);
    expect(r.total).toEqual({ waits: 6, waitS: 420, avgWaitS: 70 });
    const kinds = r.byReason as { reason: string; waitS: number; sharePct: number }[];
    expect(kinds.map((k) => `${k.reason}=${k.waitS}`)).toEqual(['permission=120', 'question=240', 'plan=60']);
    expect(kinds.reduce((n, k) => n + k.waitS, 0)).toBe(420);
  });
});

describe('sessiontime: agents', () => {
  it('counts agents by type with a row for each harness, largest type first', async () => {
    const { get } = await api(await filled());
    const r = (await get(`sessiontime?from=${D5}&to=${TODAY}&breakdown=agents`)).body as ReportReply;
    expect(rowsOf(r)).toEqual(['general|opencode|4|57.1', 'Explore|claude-code|2|28.6', 'Plan|claude-code|1|14.3']);
    expect(r.total).toMatchObject({ agents: 7, sessions: 5 });
  });

  it('groups chains of three or more levels in one row and says how deep the longest went', async () => {
    const { get } = await api(await filled());
    const r = (await get(`sessiontime?from=${D5}&to=${TODAY}&breakdown=depth`)).body as ReportReply;
    expect(rowsOf(r)).toEqual(['1|claude-code|2|28.6', '1|opencode|1|14.3', '2|claude-code|1|14.3', '2|opencode|1|14.3', '3|opencode|2|28.6']);
    expect(r.total).toEqual({ agents: 7, deepest: 4 });
  });
});

describe('workload: sessions per person per day', () => {
  it('gives each person\'s active days, sessions, sessions per active day and busiest day', async () => {
    const { get } = await api(await filled());
    const r = (await get(`workload?from=${D5}&to=${TODAY}`)).body as ReportReply;
    expect(r.columns.map((c) => c.key)).toEqual(['person', 'group', 'activeDays', 'sessions', 'perActiveDay', 'busiestDay', 'busiestDaySessions']);
    expect(rowsOf(r)).toEqual([`Maya|Platform|3|4|1.3|${D3}|2`, `Jonas|-|1|1|1|${D3}|1`]);
    expect(r.total).toEqual({ people: 2, activeDays: 4, sessions: 5, perActiveDay: 1.3, busiestDay: D3, busiestDaySessions: 3 });
  });

  it('filters by group and by harness, and refuses a person filter', async () => {
    const { get } = await api(await filled());
    expect(rowsOf((await get(`workload?from=${D5}&to=${TODAY}&group=Platform`)).body as ReportReply)).toEqual([`Maya|Platform|3|4|1.3|${D3}|2`]);
    expect(rowsOf((await get(`workload?from=${D5}&to=${TODAY}&harness=opencode`)).body as ReportReply)).toEqual([`Jonas|-|1|1|1|${D3}|1`]);
    expect((await get(`workload?from=${D5}&to=${TODAY}&person=Maya`)).status).toBe(400);
  });
});

describe('workload: busiest hours', () => {
  it('has all 24 hours, with the most sessions live at once in each', async () => {
    const { get } = await api(await filled());
    const r = (await get(`workload?from=${D5}&to=${TODAY}&breakdown=hour`)).body as ReportReply;
    expect(r.rows).toHaveLength(24);
    expect(r.rows[0]).toEqual({ hour: '00:00', harness: 'all', peak: 0 });
    const ten = r.rows[10] as Record<string, unknown>;
    expect(ten).toEqual({ hour: '10:00', harness: 'all', peak: 3 });
    expect((r.rows[9] as Record<string, unknown>).peak).toBe(1);
    expect(r.total).toEqual({ peak: 3, busiestHour: '10:00' });
  });

  it('narrows to a harness, whose peak is not the sum of the parts', async () => {
    const { get } = await api(await filled());
    const r = (await get(`workload?from=${D5}&to=${TODAY}&breakdown=hour&harness=claude-code`)).body as ReportReply;
    expect((r.rows[10] as Record<string, unknown>).peak).toBe(2);
    expect(r.rows[10]).toMatchObject({ harness: 'claude-code' });
  });

  it('refuses a group filter, because the peak counts every session', async () => {
    const { get } = await api(await filled());
    expect((await get(`workload?from=${D5}&to=${TODAY}&breakdown=hour&group=Platform`)).status).toBe(400);
  });
});

describe('exports', () => {
  it('download the table with the harness in every row, and never a note or a path', async () => {
    const { get } = await api(await filled());
    for (const q of ['sessiontime?breakdown=time&by=day', 'sessiontime?breakdown=reason', 'sessiontime?breakdown=agents', 'sessiontime?breakdown=depth']) {
      const csv = (await get(`${q}&from=${D5}&to=${TODAY}&format=csv`)).text;
      expect(csv.split('\n')[0]).toContain('Harness');
      expect(csv).not.toMatch(/\/Users|secret/);
    }
    const r = (await get(`sessiontime?from=${D5}&to=${TODAY}&breakdown=agents`)).body as ReportReply;
    expect(toCsv(r.columns, r.rows).split('\r\n')[1]).toBe('general,opencode,4,57.1');
  });
});
