// Admin > Reporting's reads (#484), the Spend breakdown (#482) and the Spend projection (#483), through the Admin API.
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAdminRouter } from '../admin/adminRouter.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import { csvCell, bucketOf, spendToday, toCsv, type ReportReply } from './reports.js';
import { addDays, costFn, writeRollups } from './rollups.js';
import { DAY_MS, NOW, TODAY, agent, at, populate, session, world, type World } from './rollupFixtures.js';
import { reportDepsOf } from './reportDeps.js';

const SECRET = 'the-admin-secret-0123456789';
const H = { 'X-Podium-Admin': '1' };

async function api(w: World, rollup = true) {
  if (rollup) await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), { sessionsMs: 30 * DAY_MS });
  const app = express();
  app.use('/api/admin', createAdminRouter({ secret: SECRET, people: w.people, reports: w.deps, now: () => NOW }));
  const agentReq = request.agent(app);
  await agentReq.post('/api/admin/unlock').set(H).send({ name: 'Admin', token: SECRET });
  const get = (path: string) => agentReq.get(`/api/admin/reports/${path}`).set(H);
  return { app, get };
}

const filled = async () => {
  const w = world();
  await populate(w);
  return w;
};

describe('access and validation', () => {
  it('is for an unlocked Administrator only, and is not mounted without its dependencies', async () => {
    const w = await filled();
    const { app } = await api(w);
    for (const p of ['usage', 'retention', 'spend/projection', 'spend/today/Priya']) expect((await request(app).get(`/api/admin/reports/${p}`).set(H)).status).toBe(401);
    const bare = express();
    bare.use('/api/admin', createAdminRouter({ secret: SECRET, people: w.people }));
    const a = request.agent(bare);
    await a.post('/api/admin/unlock').set(H).send({ name: 'Admin', token: SECRET });
    expect((await a.get('/api/admin/reports/usage').set(H)).status).toBe(404);
  });

  it('answers 400 to a bad period, bucket, filter, breakdown, format or kind, and 404 to an unknown report', async () => {
    const { get } = await api(await filled());
    const bad = [
      'usage?from=2026-13-01', 'usage?from=nope', 'usage?to=2026-10-21', 'usage?from=2026-10-20&to=2026-10-19', 'usage?from=2025-01-01&to=2026-10-20',
      'usage?by=year', 'usage?by=day&by=week', `usage?person=${'x'.repeat(201)}`, 'spend?breakdown=planet', 'sessions?breakdown=person', 'failures?breakdown=outcome',
      'usage?format=xml', 'activity?kind=has space', 'spend/projection?horizon=year', 'spend/projection?window=10', 'spend/projection?by=model', 'spend/projection?format=xml',
    ];
    for (const q of bad) expect([q, (await get(q)).status]).toEqual([q, 400]);
    expect((await get('nothing')).status).toBe(404);
    expect((await get(`spend/today/${'x'.repeat(201)}`)).status).toBe(400);
    expect((await get('spend/today/Priya?group=yes')).status).toBe(400);
    expect((await get(`usage?from=${addDays(TODAY, -400)}&to=${TODAY}`)).status).toBe(200);
  });
});

describe('the reply', () => {
  it('has the envelope, the zone, the oldest rollup day and says what it is based on', async () => {
    const { get } = await api(await filled());
    const r = (await get('usage')).body as ReportReply;
    expect(r).toMatchObject({ report: 'usage', from: addDays(TODAY, -29), to: TODAY, by: 'day', basedOn: 'rollups and live', oldestDay: addDays(TODAY, -3), partial: true });
    expect(r.tz.length).toBeGreaterThan(0);
    expect(r.columns.map((c) => c.key)).toEqual(['period', 'people', 'reporters', 'sessions', 'peakLive']);
    const earlier = (await get(`usage?to=${addDays(TODAY, -1)}`)).body as ReportReply;
    expect(earlier.basedOn).toBe('rollups');
  });

  it('says partial and returns no rows for a period before the first rollup day, without zeros', async () => {
    const { get } = await api(await filled());
    const r = (await get(`usage?from=${addDays(TODAY, -60)}&to=${addDays(TODAY, -40)}`)).body as ReportReply;
    expect(r).toMatchObject({ rows: [], partial: true });
    const whole = (await get(`usage?from=${addDays(TODAY, -3)}&to=${TODAY}`)).body as ReportReply;
    expect(whole.partial).toBe(false);
  });

  it('reads today live and every earlier day from the rollups', async () => {
    const w = await filled();
    const { get } = await api(w);
    // Neither today's new session nor a changed old one is in the rollups until the next run, except today, which is live.
    await w.fdb.upsertSession(session({ id: 'late', owner: 'Dana', started_at: at(0, 12), last_seen_at: at(0, 13), ended_at: at(0, 13), cost_usd: 10 }));
    const r = (await get('spend?breakdown=person')).body as ReportReply;
    const today = r.rows.filter((x) => x.period === TODAY);
    expect(today.find((x) => x.key === 'Dana')).toMatchObject({ sessions: 1, costUsd: 10 });
    expect(r.rows.filter((x) => x.period !== TODAY && x.key === 'Dana')).toHaveLength(1);
  });
});

describe('usage', () => {
  it('counts people, reporters, sessions and the peak per period, and once over the whole period in total', async () => {
    const { get } = await api(await filled());
    const r = (await get('usage')).body as ReportReply;
    const today = r.rows.find((x) => x.period === TODAY)!;
    expect(today).toMatchObject({ people: 2, sessions: 2 });
    expect(r.total).toMatchObject({ people: 3, reporters: 1 });
    expect(Number(r.total.sessions)).toBe(r.rows.reduce((n, x) => n + Number(x.sessions), 0));
    const week = (await get('usage?by=week')).body as ReportReply;
    expect(week.rows.every((x) => parseDay(String(x.period)).getDay() === 1)).toBe(true);
    const month = (await get('usage?by=month')).body as ReportReply;
    expect(month.rows.map((x) => x.period)).toEqual(['2026-10']);
    const filtered = (await get('usage?person=Priya')).body as ReportReply;
    expect(filtered.total).toMatchObject({ people: 1, sessions: 4 });
    expect(((await get('usage?group=Backend')).body as ReportReply).total).toMatchObject({ people: 1 });
    expect(((await get('usage?model=-')).body as ReportReply).total).toMatchObject({ sessions: 1 });
  });
});

const parseDay = (d: string): Date => new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));

describe('spend', () => {
  it('breaks cost down by person, group, model and project, null where nothing was priced', async () => {
    const { get } = await api(await filled());
    const none = (await get('spend')).body as ReportReply;
    expect(none.columns.map((c) => c.key)).toEqual(['period', 'sessions', 'tokIn', 'tokOut', 'costUsd', 'unpricedSessions']);
    expect(none.rows.every((x) => !('key' in x))).toBe(true);
    expect(none.total).toMatchObject({ sessions: 7, unpricedSessions: 1 });
    const person = (await get('spend?breakdown=person')).body as ReportReply;
    expect(person.columns.map((c) => c.key)).toContain('key');
    const llama = person.rows.find((x) => x.period === addDays(TODAY, -2) && x.key === 'Priya')!;
    expect(llama).toMatchObject({ costUsd: null, unpricedSessions: 1 });
    const group = (await get('spend?breakdown=group')).body as ReportReply;
    expect(group.rows.map((x) => x.key)).toEqual(expect.arrayContaining(['Backend', '-']));
    const model = (await get('spend?breakdown=model&by=month')).body as ReportReply;
    expect(model.rows.map((x) => x.key)).toEqual(expect.arrayContaining(['claude-opus-5-5', 'llama-local', '-']));
    const project = (await get('spend?breakdown=project&person=Priya')).body as ReportReply;
    expect([...new Set(project.rows.map((x) => x.key))].sort()).toEqual(['api', 'demo']);
  });
});

describe('people', () => {
  it('lists everyone, active, quiet or never, with the versions in use', async () => {
    const { get } = await api(await filled());
    const r = (await get('people')).body as ReportReply & { summary: Record<string, unknown> };
    const state = Object.fromEntries(r.rows.map((x) => [x.person, x.state]));
    expect(state).toEqual({ Admin: 'active', Dana: 'active', Priya: 'active', Quiet: 'never' });
    const narrow = (await get(`people?from=${TODAY}`)).body as ReportReply;
    expect(Object.fromEntries(narrow.rows.map((x) => [x.person, x.state]))).toMatchObject({ Dana: 'quiet', Quiet: 'never', Priya: 'active' });
    expect(r.summary).toMatchObject({ people: 3, groups: 2, reporters: 1, reporterVersions: { '1.2.2': 1 }, engineVersions: { '2.1.301': 1 } });
    expect(((await get('people?person=Dana')).body as ReportReply).rows).toHaveLength(1);
    expect(((await get('people?group=Backend')).body as ReportReply).rows.map((x) => x.person)).toEqual(['Priya']);
  });
});

describe('sessions', () => {
  it('counts by outcome, model, effort and plan with durations, agents, blowouts and context', async () => {
    const { get } = await api(await filled());
    const r = (await get('sessions')).body as ReportReply;
    expect(r.columns.map((c) => c.key)).toEqual(['period', 'key', 'sessions', 'avgDurationS', 'maxDurationS', 'agentsPerSession', 'blowouts', 'maxContextPct']);
    expect(r.rows.map((x) => x.key)).toEqual(expect.arrayContaining(['completed', 'error', 'running']));
    expect(r.total).toMatchObject({ sessions: 7, blowouts: 1, maxContextPct: 91, maxDurationS: 10_800 });
    for (const by of ['model', 'effort', 'plan']) expect(((await get(`sessions?breakdown=${by}`)).body as ReportReply).total).toMatchObject({ sessions: 7 });
    expect(((await get('sessions?breakdown=plan')).body as ReportReply).rows.map((x) => x.key)).toContain('TodoWrite');
    expect(((await get('sessions?model=claude-sonnet-5-5')).body as ReportReply).total).toMatchObject({ sessions: 1 });
    const none = (await get(`sessions?from=${addDays(TODAY, -60)}&to=${addDays(TODAY, -50)}`)).body as ReportReply;
    expect(none.total).toMatchObject({ sessions: 0, avgDurationS: null, agentsPerSession: null });
  });
});

describe('failures', () => {
  it('counts by class, tool and person, with the sessions to look at while they are stored', async () => {
    const { get } = await api(await filled());
    const r = (await get('failures')).body as ReportReply;
    expect(r.total).toMatchObject({ count: 3, people: 1 });
    const perm = r.rows.filter((x) => x.key === 'permission');
    expect(perm.map((x) => [x.period, x.count, x.sessionIds])).toEqual([[addDays(TODAY, -3), 1, ['p1']], [addDays(TODAY, -1), 1, ['p3']]]);
    expect(((await get('failures?breakdown=tool')).body as ReportReply).rows.map((x) => x.key)).toEqual(expect.arrayContaining(['Bash', 'WebFetch']));
    const person = (await get('failures?breakdown=person&group=Backend')).body as ReportReply;
    expect(person.rows.every((x) => x.key === 'Priya')).toBe(true);
    expect(((await get('failures?person=Dana')).body as ReportReply).rows).toEqual([]);
  });

  it('gives no more than ten session ids and none once the sessions are gone', async () => {
    const w = world();
    for (let i = 0; i < 12; i++) {
      await w.fdb.upsertSession(session({ id: `f${i}`, owner: 'Dana', last_seen_at: at(1, 10), started_at: at(1, 9), ended_at: at(1, 10) }));
      await w.fdb.upsertAgent(agent(`f${i}`, 'a', { failure_json: JSON.stringify({ class: 'oom', tool: null }) }));
    }
    const { get } = await api(w);
    const r = (await get('failures')).body as ReportReply;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ key: 'oom', count: 12 });
    expect((r.rows[0]!.sessionIds as string[]).length).toBe(10);
    w.storage.sqliteHandle.prepare('DELETE FROM sessions').run();
    const gone = (await get('failures')).body as ReportReply;
    expect(gone.rows[0]).toMatchObject({ count: 12 });
    expect('sessionIds' in gone.rows[0]!).toBe(false);
  });
});

describe('activity and Data kept', () => {
  it('reads the Admin log by period and kind, newest first', async () => {
    const w = await filled();
    w.people.log('person_created', 'Created Dana', '10.0.0.1', at(1, 9));
    w.people.log('unlock', '=HYPERLINK("x")', '10.0.0.2', at(0, 9));
    w.people.log('person_created', 'Created Quiet', '10.0.0.1', at(5, 9));
    const { get } = await api(w);
    const r = (await get(`activity?from=${addDays(TODAY, -2)}`)).body as ReportReply;
    expect(r.by).toBeNull();
    expect(r.partial).toBe(false);
    expect(r.rows.map((x) => x.detail)).toEqual(['Admin unlocked', '=HYPERLINK("x")', 'Created Dana']);
    expect(r.total).toEqual({ count: 3 });
    expect(((await get('activity?kind=person_created')).body as ReportReply).rows).toHaveLength(2);
    expect(((await get('activity?kind=person_created&from=' + addDays(TODAY, -2))).body as ReportReply).rows).toHaveLength(1);
  });

  it('says when the log is longer than the 1,000 rows it returns (#529)', async () => {
    const w = await filled();
    for (let i = 0; i < 1001; i++) w.people.log('unlock', `entry ${i}`, '10.0.0.1', at(0, 9) + i);
    const { get } = await api(w);
    const r = (await get(`activity?from=${addDays(TODAY, -1)}`)).body as ReportReply;
    expect(r.rows).toHaveLength(1000);
    expect(r.truncated).toBe(true);
    expect(r.total).toEqual({ count: 1000 });
    expect(r.rows.some((x) => x.detail === 'entry 0')).toBe(false);
    expect(r.rows.some((x) => x.detail === 'entry 1000')).toBe(true);
    const some = (await get('activity?kind=person_created')).body as ReportReply;
    expect(some.truncated).toBe(false);
  });

  it('lists the rollup tables and how long everything is kept', async () => {
    const { get } = await api(await filled());
    const r = (await get('retention')).body as { tables: { name: string; rows: number; oldestDay: string | null; keptDays: number }[]; detail: { name: string; keptDays: number }[]; tz: string };
    expect(r.tables.map((t) => t.name)).toEqual(['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily']);
    expect(r.tables[0]).toMatchObject({ oldestDay: addDays(TODAY, -3), keptDays: 395 });
    expect(r.tables[0]!.rows).toBeGreaterThan(0);
    expect(r.detail).toEqual([{ name: 'samples', keptDays: 1 }, { name: 'events', keptDays: 30 }, { name: 'sessions', keptDays: 30 }, { name: 'admin_log', keptDays: 90 }]);
    const empty = (await (await api(world(), false)).get('retention')).body as typeof r;
    expect(empty.tables.every((t) => t.rows === 0 && t.oldestDay === null)).toBe(true);
  });
});

describe('CSV', () => {
  it('returns the same columns and rows as RFC 4180 text, as an attachment, with spreadsheet formulas neutralized', async () => {
    const w = await filled();
    w.people.createPerson('=cmd|calc', null, NOW);
    await w.fdb.upsertSession(session({ id: 'evil', owner: '=cmd|calc', model: '+1,"quoted"', last_seen_at: at(1, 10), started_at: at(1, 9), ended_at: at(1, 10) }));
    const { get } = await api(w);
    const res = await get('spend?breakdown=person&format=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="podium-spend-${addDays(TODAY, -29)}-${TODAY}.csv"`);
    const lines = res.text.split('\r\n');
    expect(lines[0]).toBe('Period,Person,Sessions,Tokens in,Tokens out,Cost (USD),Sessions without a price');
    expect(res.text.endsWith('\r\n')).toBe(true);
    expect(lines.some((l) => l.includes("'=cmd|calc"))).toBe(true);
    expect(lines.some((l) => l.startsWith(`${addDays(TODAY, -2)},Priya,1,100,50,,1`))).toBe(true);
    const json = (await get('spend?breakdown=person')).body as ReportReply;
    expect(lines.length).toBe(json.rows.length + 2);
    const model = await get('spend?breakdown=model&format=csv');
    expect(model.text).toContain(`"'+1,""quoted"""`);
    const projection = await get('spend/projection?format=csv');
    expect(projection.headers['content-disposition']).toContain('podium-spend-projection');
    expect((await get('usage?format=json')).status).toBe(200);
  });

  it('quotes what needs it and leaves numbers, nulls and a plain minus sign alone', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('-')).toBe('-');
    expect(csvCell('-1x')).toBe("'-1x");
    expect(csvCell('say "hi"\nnow')).toBe('"say ""hi""\nnow"');
    for (const s of ['=1', '+1', '-1', '@x', '\tx']) expect(csvCell(s)).toBe(`'${s}`);
    expect(csvCell(['a', 'b'])).toBe('a b');
    expect(toCsv([{ key: 'k', label: 'K, the key', unit: 'text' }], [{ k: 'v' }, {}])).toBe('"K, the key"\r\nv\r\n\r\n');
  });

  it('starts a week on Monday and a month on its first', () => {
    expect(bucketOf('2026-10-20', 'week')).toBe('2026-10-19');
    expect(bucketOf('2026-10-18', 'week')).toBe('2026-10-12');
    expect(bucketOf('2026-10-20', 'month')).toBe('2026-10');
    expect(bucketOf('2026-10-20', 'day')).toBe('2026-10-20');
  });
});

/** Fourteen complete days of history: Priya and Dana work most days, Rare on two, a model nobody priced on a few. */
async function history(w: World): Promise<void> {
  const priya = w.people.createPerson('Priya', w.people.createGroup('Backend', NOW).id, NOW).person;
  w.people.createPerson('Dana', null, NOW);
  w.people.createPerson('Rare', null, NOW);
  void priya;
  for (let d = 1; d <= 14; d++) {
    await w.fdb.upsertSession(session({ id: `P${d}`, owner: 'Priya', started_at: at(d, 9), last_seen_at: at(d, 10), ended_at: at(d, 10), cost_usd: 2 }));
    if (d % 2 === 0) await w.fdb.upsertSession(session({ id: `D${d}`, owner: 'Dana', started_at: at(d, 9), last_seen_at: at(d, 10), ended_at: at(d, 10), cost_usd: 1 }));
    if (d <= 2) await w.fdb.upsertSession(session({ id: `R${d}`, owner: 'Rare', started_at: at(d, 9), last_seen_at: at(d, 10), ended_at: at(d, 10), cost_usd: 7 }));
    if (d === 3) await w.fdb.upsertSession(session({ id: 'U3', owner: 'Dana', model: 'llama-local', cost_usd: null, started_at: at(d, 9), last_seen_at: at(d, 10), ended_at: at(d, 10) }));
  }
  await w.fdb.upsertSession(session({ id: 'T', owner: 'Priya', started_at: at(0, 9), last_seen_at: at(0, 10), ended_at: at(0, 10), cost_usd: 5 }));
}

describe('projection (#483)', () => {
  it('projects the rest of the month from the run rate of the trailing window, today kept out of the rate', async () => {
    const w = world();
    await history(w);
    const { get } = await api(w);
    const r = (await get('spend/projection')).body as ReportReply;
    expect(r).toMatchObject({ report: 'spend/projection', horizon: 'month', window: { from: addDays(TODAY, -14), to: addDays(TODAY, -1), days: 14 }, historyDays: 14, unpricedSessions: 1 });
    expect(r.columns.map((c) => c.key)).toEqual(['key', 'runRatePerDay', 'spentThisMonth', 'projected']);
    const priya = r.rows.find((x) => x.key === 'Priya')!;
    // 14 days at 2 a day, 28 over the window; the month so far is those 14 days plus today, with 11 days left.
    expect(priya.runRatePerDay).toBe(2);
    expect(priya.spentThisMonth).toBe(2 * 14 + 5);
    expect(priya.projected).toBe(33 + 2 * 11);
    const dana = r.rows.find((x) => x.key === 'Dana')!;
    expect(dana.runRatePerDay).toBe(0.5);
    // Rare was active on two days only: too little to say anything.
    expect(r.rows.find((x) => x.key === 'Rare')).toMatchObject({ runRatePerDay: null, projected: null, reason: 'history' });
    expect(r.total).toMatchObject({ key: 'Total', runRatePerDay: (28 + 7 + 14) / 14 });
    expect(r.rows[0]!.key).toBe('Priya');
  });

  it('projects thirty times the run rate for the next 30 days and follows the window and grouping asked for', async () => {
    const w = world();
    await history(w);
    const { get } = await api(w);
    const r = (await get('spend/projection?horizon=30d&window=7&by=group')).body as ReportReply;
    expect(r.window).toMatchObject({ days: 7, from: addDays(TODAY, -7) });
    expect(r.by).toBe('group');
    const backend = r.rows.find((x) => x.key === 'Backend')!;
    expect(backend.projected).toBe(60);
    expect(r.rows.map((x) => x.key)).toContain('-');
  });

  it('says there is not enough history instead of guessing when the server has fewer than 7 complete days', async () => {
    const w = world();
    for (let d = 1; d <= 5; d++) await w.fdb.upsertSession(session({ id: `P${d}`, owner: 'Priya', started_at: at(d, 9), last_seen_at: at(d, 10), ended_at: at(d, 10), cost_usd: 2 }));
    const { get } = await api(w);
    const r = (await get('spend/projection')).body as ReportReply;
    expect(r.historyDays).toBe(5);
    expect(r.rows.every((x) => x.projected === null && x.reason === 'history')).toBe(true);
    expect(r.total).toMatchObject({ projected: null, reason: 'history' });
    expect((await (await api(world(), false)).get('spend/projection')).body.historyDays).toBe(0);
  });
});

describe('Spend breakdown (#482)', () => {
  it('cuts a person\'s spend since midnight by session, model and source, adding up to the table row', async () => {
    const w = await filled();
    // Priya's p4 spent 4 today, half of it on agents (their estimates add up to half the session's cost, 2 of 4).
    const { get } = await api(w);
    const fleet = new Fleet(w.storage, { ...DEFAULT_CONFIG, home: '/h', dbPath: ':memory:' }, () => NOW);
    await fleet.init();
    const row = (await fleet.kpis([])).costTodayByOwner.find((o) => o.owner === 'Priya')!;
    const r = (await get('spend/today/Priya')).body;
    expect(r.owner).toBe('Priya');
    expect(r.total).toBe(row.costUsd);
    expect(r.bySession).toHaveLength(1);
    expect(r.bySession[0]).toMatchObject({ id: 'p4', share: 1 });
    expect(r.bySource.agents).toBeCloseTo(2, 6);
    expect(r.bySource.orchestrator + r.bySource.agents).toBeCloseTo(r.total, 9);
    expect(r.byModel).toEqual([{ model: 'claude-opus-5-5', costUsd: 4, share: 1 }]);
    expect(r.unpriced).toBe(0);
    expect(r.byPerson).toBeUndefined();
  });

  it('cuts a group by person first, counts sessions on models without a price, and takes - for no owner', async () => {
    const w = await filled();
    await w.fdb.upsertSession(session({ id: 'free', owner: 'Priya', model: 'llama-local', cost_usd: null, started_at: at(0, 9), last_seen_at: at(0, 10), ended_at: null, status: 'running', end_reason: null }));
    await w.fdb.upsertSession(session({ id: 'mix', owner: 'Priya', cost_usd: 6, started_at: at(0, 9), last_seen_at: at(0, 10), ended_at: null, status: 'running', end_reason: null, usage_json: JSON.stringify([
      { model: 'claude-opus-5-5', tier: 'std', tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } },
      { model: 'llama-local', tier: 'std', tokens: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } },
    ]) }));
    const { get } = await api(w);
    const g = (await get('spend/today/Backend?group=1')).body;
    expect(g.byPerson).toEqual([expect.objectContaining({ owner: 'Priya', share: 1 })]);
    expect(g.unpriced).toBe(1);
    expect(g.byModel.find((m: { model: string }) => m.model === 'llama-local')).toEqual({ model: 'llama-local', costUsd: null, share: null });
    const sum = g.bySession.reduce((n: number, s: { costUsd: number }) => n + s.costUsd, 0);
    expect(sum).toBeCloseTo(g.total, 9);
    const none = (await get('spend/today/-')).body;
    expect(none).toMatchObject({ owner: '-', total: 0.25 });
    expect(none.bySession[0]).toMatchObject({ id: 'n1', model: null });
    expect(none.byModel).toEqual([{ model: '-', costUsd: 0.25, share: 1 }]);
    const noGroup = (await get('spend/today/-?group=1')).body;
    expect(noGroup.byPerson.map((p: { owner: string }) => p.owner).sort()).toEqual(['-', 'Admin']);
    expect((await get('spend/today/Nobody')).body).toMatchObject({ total: 0, bySession: [], byModel: [], unpriced: 0 });
  });

  it('wires a running Fleet into the report routes', async () => {
    const w = await filled();
    const fleet = new Fleet(w.storage, { ...DEFAULT_CONFIG, home: '/h', dbPath: ':memory:' }, () => NOW);
    await fleet.init();
    const deps = reportDepsOf(fleet);
    expect(deps.now()).toBe(NOW);
    expect(deps.retention).toBe(fleet.cfg.retention);
    expect(deps.pricing()).toBeDefined();
  });
});

describe('spendToday reads each session once (#529)', () => {
  it('asks for no session or agent cost one by one, and counts the sessions on a model without a price', async () => {
    const w = world();
    await populate(w);
    const sessionOf = vi.spyOn(w.fdb, 'getSession');
    const agentsOf = vi.spyOn(w.fdb, 'agentCostsSince');
    const reply = await spendToday(w.deps, 'Priya', false);
    expect(reply.total).toBeGreaterThan(0);
    expect(reply.bySource.agents).toBeGreaterThan(0);
    expect(sessionOf).not.toHaveBeenCalled();
    expect(agentsOf).toHaveBeenCalledTimes(1);
    expect(reply.unpriced).toBe(0);
    await w.fdb.upsertSession(session({ id: 'free', owner: 'Priya', started_at: at(0, 11), last_seen_at: at(0, 12), ended_at: at(0, 12), cost_usd: null, model: 'llama-local' }));
    expect((await spendToday(w.deps, 'Priya', false)).unpriced).toBe(1);
  });
});
