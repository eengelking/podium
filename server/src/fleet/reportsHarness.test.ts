// Admin > Reporting > Harness updates (#724): what a version of a harness stopped sending, and the reporters behind the newest version, through the Admin API.
// The sessions are replayed from stored rows, so the whole path is exercised: the session's counts, the rollup, the report.
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAdminRouter } from '../admin/adminRouter.js';
import { toCsv, type ReportReply } from './reports.js';
import { addDays, costFn, writeRollups } from './rollups.js';
import { DAY_MS, NOW, TODAY, agent, at, session, world, type World } from '../storage/sqlite/rollupFixtures.js';

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

const OLD = { 'hook:tool.check': 3, 'hook:tool.call': 9, 'field:tool.call.tool_use_id': 9, 'hook:session.start': 1 };

/**
 * `n` sessions of one version of a harness on one day, spread over `reporters` reporters. Each sends `signals`; `calls` gives the tool counts they made (a name and a count).
 * A reporter whose version is older than the signals sends none, which is what a session of an older reporter looks like.
 */
async function replay(w: World, o: { harness: string; version: string; daysAgo: number; n: number; reporters: number; signals: Record<string, number> | null; calls?: Record<string, number> }): Promise<void> {
  for (let i = 0; i < o.n; i++) {
    const id = `${o.harness}-${o.version}-d${o.daysAgo}-${i}`;
    const reporter = `r-${o.harness}-${o.version}-${i % o.reporters}`;
    await w.fdb.upsertSession(session({ id, owner: 'Priya', harness: o.harness, engine_version: o.version, started_at: at(o.daysAgo, 9), last_seen_at: at(o.daysAgo, 11), ended_at: at(o.daysAgo, 11), signals_json: o.signals ? JSON.stringify(o.signals) : null }));
    if (o.calls) await w.fdb.upsertAgent(agent(id, `${id}-a`, { tool_counts_json: JSON.stringify(o.calls) }));
    w.storage.sqliteHandle.prepare("INSERT OR IGNORE INTO reporters (key, kind, machine_id, owner, reporter_version, engine_version, first_seen_at, last_seen_at) VALUES (?, 'mod', ?, 'Priya', '1.6.0', ?, 1, 2)").run(reporter, reporter, o.version);
    w.storage.sqliteHandle.prepare('INSERT INTO reporter_sessions (reporter_key, session_id) VALUES (?, ?)').run(reporter, id);
  }
}

const rowsOf = (r: ReportReply): string[] => r.rows.map((x) => Object.values(x).join('|'));
const q = (extra = '') => `harness?from=${addDays(TODAY, -8)}&to=${TODAY}&by=week${extra}`;

describe('harness updates: stopped', () => {
  it('lists a hook that a version stopped sending, against that version, with the reporters on it', async () => {
    const w = world();
    await replay(w, { harness: 'claude-code', version: '2.1.305', daysAgo: 6, n: 22, reporters: 3, signals: OLD });
    const { 'hook:tool.check': _dropped, ...newer } = OLD;
    await replay(w, { harness: 'claude-code', version: '2.1.319', daysAgo: 3, n: 22, reporters: 2, signals: newer });
    const { get } = await api(w);
    const r = (await get(q())).body as ReportReply;
    expect(r.report).toBe('harness');
    expect(rowsOf(r)).toEqual(['claude-code|2.1.319|2.1.305|hook:tool.check|hook|100|0|2|Permission prompts are not counted.']);
    expect(r.total).toEqual({ features: 1, versions: 1, reporters: 2 });
    expect(r.names).toEqual({ 'claude-code': 'Claude Code' });
  });

  it('shows nothing when a version sends everything the one before it did', async () => {
    const w = world();
    await replay(w, { harness: 'claude-code', version: '2.1.305', daysAgo: 6, n: 22, reporters: 3, signals: OLD });
    await replay(w, { harness: 'claude-code', version: '2.1.319', daysAgo: 3, n: 22, reporters: 3, signals: OLD });
    const r = ((await (await api(w)).get(q())).body) as ReportReply;
    expect(r.rows).toEqual([]);
    expect(r.total).toEqual({ features: 0, versions: 0, reporters: 0 });
  });

  it('does not count a version whose reporter sends no signals as one that stopped everything', async () => {
    const w = world();
    await replay(w, { harness: 'claude-code', version: '2.1.305', daysAgo: 6, n: 22, reporters: 3, signals: OLD });
    await replay(w, { harness: 'claude-code', version: '2.1.319', daysAgo: 3, n: 22, reporters: 3, signals: null });
    expect(((await (await api(w)).get(q())).body as ReportReply).rows).toEqual([]);
  });

  it('lists a tool name that stopped arriving, from the tool counts, for the harness that lost it only', async () => {
    const w = world();
    await replay(w, { harness: 'opencode', version: '1.3.9', daysAgo: 6, n: 22, reporters: 2, signals: null, calls: { webfetch: 2, Bash: 5 } });
    await replay(w, { harness: 'opencode', version: '1.4.2', daysAgo: 3, n: 22, reporters: 2, signals: null, calls: { Bash: 5 } });
    await replay(w, { harness: 'claude-code', version: '2.1.305', daysAgo: 6, n: 22, reporters: 2, signals: null, calls: { webfetch: 2 } });
    await replay(w, { harness: 'claude-code', version: '2.1.319', daysAgo: 3, n: 22, reporters: 2, signals: null, calls: { webfetch: 2 } });
    const r = ((await (await api(w)).get(q())).body) as ReportReply;
    expect(rowsOf(r).map((x) => x.split('|').slice(0, 5).join('|'))).toEqual(['opencode|1.4.2|1.3.9|tool:webfetch|tool']);
    expect((await (await api(w)).get(q('&harness=claude-code'))).body.rows).toEqual([]);
  });

  it('is the same data as its CSV, and refuses a person filter it cannot honor', async () => {
    const w = world();
    await replay(w, { harness: 'claude-code', version: '2.1.305', daysAgo: 6, n: 22, reporters: 3, signals: OLD });
    await replay(w, { harness: 'claude-code', version: '2.1.319', daysAgo: 3, n: 22, reporters: 2, signals: { 'hook:session.start': 1 } });
    const { get } = await api(w);
    const json = (await get(q())).body as ReportReply;
    const csv = (await get(`${q()}&format=csv`)).text;
    expect(csv).toBe(toCsv(json.columns, json.rows));
    expect(csv.startsWith('Harness,Version,Compared with,What stopped,Kind,Seen before,Seen now,Reporters on it,What it affects\r\n')).toBe(true);
    expect((await get(`${q()}&person=Priya`)).status).toBe(400);
  });
});

describe('harness updates: behind the newest version', () => {
  it('counts the reporters on an older version than the newest seen so far, per period and harness', async () => {
    const w = world();
    await replay(w, { harness: 'claude-code', version: '2.1.305', daysAgo: 12, n: 4, reporters: 4, signals: null });
    await replay(w, { harness: 'claude-code', version: '2.1.305', daysAgo: 3, n: 3, reporters: 3, signals: null });
    await replay(w, { harness: 'claude-code', version: '2.1.319', daysAgo: 3, n: 1, reporters: 1, signals: null });
    const r = ((await (await api(w)).get(`harness?breakdown=behind&from=${addDays(TODAY, -14)}&to=${TODAY}&by=week`)).body) as ReportReply;
    expect(r.columns.map((c) => c.key)).toEqual(['period', 'harness', 'newest', 'reporters', 'onNewest', 'behind']);
    const last = r.rows[r.rows.length - 1]!;
    expect(last).toMatchObject({ harness: 'claude-code', newest: '2.1.319', reporters: 4, onNewest: 1, behind: 3 });
    // the first week had only 2.1.305, which was the newest then
    expect(r.rows[0]).toMatchObject({ newest: '2.1.305', reporters: 4, behind: 0 });
  });
});

describe('harness updates: the count in the top bar', () => {
  async function counted() {
    const w = world();
    await replay(w, { harness: 'claude-code', version: '2.1.305', daysAgo: 6, n: 22, reporters: 3, signals: OLD });
    await replay(w, { harness: 'claude-code', version: '2.1.319', daysAgo: 3, n: 22, reporters: 2, signals: { 'hook:session.start': 1 } });
    await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), { sessionsMs: 30 * DAY_MS });
    const clock = { t: NOW };
    const app = express();
    app.use('/api/admin', createAdminRouter({ secret: SECRET, storage: w.storage, people: w.people, reports: w.deps, now: () => clock.t, idleMs: 600_000 }));
    return { agent: request.agent(app), clock };
  }

  it('tells nobody who is locked, and an unlocked Admin how many features stopped', async () => {
    const { agent } = await counted();
    expect((await agent.get('/api/admin/notice')).body).toEqual({ unlocked: false });
    await agent.post('/api/admin/unlock').set(H).send({ name: 'Admin', token: SECRET });
    expect((await agent.get('/api/admin/notice')).body).toEqual({ unlocked: true, stopped: 3 });
  });

  it('is not Admin activity: asking for it does not hold off the idle lock', async () => {
    const { agent, clock } = await counted();
    await agent.post('/api/admin/unlock').set(H).send({ name: 'Admin', token: SECRET });
    clock.t += 9 * 60_000;
    expect((await agent.get('/api/admin/notice')).body.unlocked).toBe(true);
    clock.t += 2 * 60_000;
    expect((await agent.get('/api/admin/notice')).body).toEqual({ unlocked: false });
    expect((await agent.get('/api/admin/session')).body.unlocked).toBe(false);
  });
});

describe('skills, projects and branches, and platforms', () => {
  async function apiWith(w: World) {
    await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), { sessionsMs: 30 * DAY_MS });
    const app = express();
    app.use('/api/admin', createAdminRouter({ secret: SECRET, storage: w.storage, people: w.people, reports: w.deps, reporters: w.storage.reporters, now: () => NOW }));
    const a = request.agent(app);
    await a.post('/api/admin/unlock').set(H).send({ name: 'Admin', token: SECRET });
    return { get: (path: string) => a.get(`/api/admin/reports/${path}`).set(H) };
  }
  const range = `from=${addDays(TODAY, -8)}&to=${TODAY}&by=week`;

  it('counts the sessions that used each skill and the people who ran them, per harness', async () => {
    const w = world();
    const add = async (id: string, owner: string, harness: string, skills: string[], daysAgo = 3) => {
      await w.fdb.upsertSession(session({ id, owner, harness, started_at: at(daysAgo, 9), last_seen_at: at(daysAgo, 11), ended_at: at(daysAgo, 11) }));
      await w.fdb.upsertAgent(agent(id, `${id}-a`, { skills_json: JSON.stringify(skills) }));
    };
    await add('a1', 'Priya', 'claude-code', ['code-review', 'simplify']);
    await add('a2', 'Priya', 'claude-code', ['code-review']);
    await add('a3', 'Ravi', 'claude-code', ['code-review']);
    await add('a4', 'Ravi', 'opencode', ['code-review']);
    await add('a5', 'Priya', 'claude-code', []);
    const r = ((await (await apiWith(w)).get(`tools?breakdown=skills&${range}`)).body) as ReportReply;
    expect(r.columns.map((c) => c.key)).toEqual(['skill', 'harness', 'sessions', 'people']);
    expect(rowsOf(r)).toEqual(['code-review|claude-code|3|2', 'code-review|opencode|1|1', 'simplify|claude-code|1|1']);
    expect(r.bySkill).toEqual([{ skill: 'code-review', sessions: 4, people: 2 }, { skill: 'simplify', sessions: 1, people: 1 }]);
    expect(((await (await apiWith(w)).get(`tools?breakdown=skills&${range}&harness=opencode`)).body as ReportReply).rows).toHaveLength(1);
  });

  it('counts each person\'s projects and branches once, and the total once overall', async () => {
    const w = world();
    const add = async (id: string, owner: string, repo: string | null, branch: string | null, daysAgo: number) =>
      w.fdb.upsertSession(session({ id, owner, repo_name: repo, git_json: branch === null ? null : JSON.stringify({ branch }), started_at: at(daysAgo, 9), last_seen_at: at(daysAgo, 11), ended_at: at(daysAgo, 11) }));
    await add('p1', 'Priya', 'acme/podium', 'main', 3);
    await add('p2', 'Priya', 'acme/podium', 'main', 2);
    await add('p3', 'Priya', 'acme/podium', 'fix-1', 2);
    await add('p4', 'Priya', 'acme/docs', 'main', 2);
    await add('p5', 'Ravi', 'acme/podium', 'main', 2);
    await add('p6', 'Ravi', null, null, 2);
    const r = ((await (await apiWith(w)).get(`workload?breakdown=places&${range}`)).body) as ReportReply;
    expect(r.columns.map((c) => c.key)).toEqual(['person', 'group', 'projects', 'branches', 'topProject']);
    expect(r.rows.map((x) => `${x.person}|${x.projects}|${x.branches}|${x.topProject}`)).toEqual(['Priya|2|3|acme/podium', 'Ravi|1|1|acme/podium']);
    expect(r.total).toEqual({ people: 2, projects: 2, branches: 3 });
  });

  it('counts reporters by the family of their system and their version, with a status, and no host or user name', async () => {
    const w = world();
    for (const [key, os, version] of [['m1', 'macOS 27.0.1', '1.5.1'], ['m2', 'macOS 26.4', '1.5.1'], ['m3', 'Ubuntu 24.04', '1.2.0'], ['m4', null, '1.5.1']] as const) {
      w.storage.sqliteHandle.prepare("INSERT INTO reporters (key, kind, machine_id, machine_name, owner, reporter_version, engine_version, first_seen_at, last_seen_at, os, reporter_name) VALUES (?, 'mod', ?, 'a-secret-host', 'Priya', ?, '2.1.319', 1, ?, ?, 'podium-reporter-claudecode')").run(key, key, version, NOW - 1000, os);
    }
    const r = ((await (await apiWith(w)).get(`harness?breakdown=platform&${range}`)).body) as ReportReply;
    expect(r.columns.map((c) => c.key)).toEqual(['harness', 'platform', 'version', 'reporters', 'status']);
    expect(rowsOf(r)).toEqual(['claude-code|Not reported|1.5.1|1|Current', 'claude-code|Ubuntu|1.2.0|1|Update available', 'claude-code|macOS|1.5.1|2|Current']);
    expect(JSON.stringify(r)).not.toContain('a-secret-host');
    expect(r.total).toEqual({ reporters: 4 });
  });
});
