// My usage (#726): a signed-in person's own figures over HTTP, and that nothing of anyone else's can get into them.
//
// Two people are seeded with values only one of them has (a name, a project, a model, session ids, a failing tool). Every report is read as each of them, with and
// without hostile parameters, and the response, the CSV and the error messages are searched for the other person's values.
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openSqliteStorage } from '../storage/sqlite/index.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import { createFleetRouter } from './routes.js';
import { Lockout } from './lockout.js';
import { createRespondBridge } from './respondBridge.js';
import { MY_BREAKDOWNS, MY_REPORT_NAMES, personScope, runMyReport, type MyReportName } from './reports.js';
import { costFn, writeRollups } from './rollups.js';
import { DAY_MS, NOW, agent, at, failure, session } from '../storage/sqlite/rollupFixtures.js';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

const SECRET = 'admin-secret';
const H = { 'X-Podium-Respond': '1' };
const USAGE = '/api/fleet/respond/usage';

async function setup(opts: { on?: boolean; secret?: string | null } = {}) {
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  const storage = openSqliteStorage(':memory:');
  const fleet = new Fleet(storage, { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' }, () => NOW, undefined, { authOn: secret !== null });
  await fleet.init();
  const people = storage.people;
  const app = express();
  app.use('/api/fleet', createFleetRouter(fleet, { token: secret, people, lockout: new Lockout(fleet.now), respondBridge: createRespondBridge(), log: () => {} }));
  closers.push(() => fleet.close());
  if (opts.on !== false) await fleet.features.setFeature('my-usage', true);
  const ed = await people.createPerson('Edwina Quill');
  const alex = await people.createPerson('Alexei Brandt');
  const boss = await people.createPerson('Bosswell');
  await people.setGroup(boss.person.id, await people.administratorsGroupId());
  return { app, fleet, storage, people, ed, alex, boss };
}
type World = Awaited<ReturnType<typeof setup>>;

// What only Ed has, and what only Alex has. A leak of either is a string match.
const ED = { name: 'Edwina Quill', project: 'quill-notebook', model: 'model-quill', session: 'sess-quill-1', tool: 'QuillTool' };
const ALEX = { name: 'Alexei Brandt', project: 'brandt-secret-repo', model: 'model-brandt', session: 'sess-brandt-1', tool: 'BrandtTool' };

/** Each person has two sessions in the last week and one failure; Ed's are on a different model, project and tool from Alex's. Also an Admin-owned session. */
async function seed(w: World): Promise<void> {
  const { fdb } = { fdb: w.fleet.db };
  const mk = async (id: string, owner: string, who: typeof ED, days: number, cost: number, calls: Record<string, number>) => {
    await fdb.upsertSession(session({ id, owner, repo_name: who.project, model: who.model, started_at: at(days, 9), last_seen_at: at(days, 11), ended_at: at(days, 11), cost_usd: cost, usage_json: null }));
    await fdb.upsertAgent(agent(id, `${id}-a`, { tool_counts_json: JSON.stringify(calls), failure_json: failure('permission', who.tool) }));
  };
  await mk(ED.session, ED.name, ED, 3, 2, { [ED.tool]: 7 });
  await mk('sess-quill-2', ED.name, ED, 0, 1, { [ED.tool]: 2 });
  await mk(ALEX.session, ALEX.name, ALEX, 3, 5, { [ALEX.tool]: 11 });
  await mk('sess-brandt-2', ALEX.name, ALEX, 0, 4, { [ALEX.tool]: 3 });
  await fdb.upsertSession(session({ id: 'sess-admin-1', owner: 'Admin', repo_name: 'admin-repo', model: 'model-admin', started_at: at(1, 9), last_seen_at: at(1, 10), ended_at: at(1, 10), cost_usd: 9 }));
  // yesterday's and older days move into the daily rollups, as the hourly retention does
  await writeRollups(w.storage, NOW, costFn(w.fleet.prices.pricing()), { sessionsMs: 30 * DAY_MS });
}

async function signIn(w: World, name: string, token: string) {
  const agentReq = request.agent(w.app);
  const res = await agentReq.post('/api/fleet/respond/sign-in').set(H).send({ name, token });
  expect(res.status).toBe(200);
  return agentReq;
}

/** Every report a person may open, in every breakdown, with the format. */
const EVERY: { path: string }[] = MY_REPORT_NAMES.flatMap((name: MyReportName) => MY_BREAKDOWNS[name].map((b) => ({ path: `${name}?breakdown=${b}&from=2026-09-01&to=2026-10-20&by=day` })));

const text = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

/** Words that would identify the other person, including their person id and every session id of theirs. */
function theirs(who: typeof ED, id: number): string[] {
  return [who.name, who.name.split(' ')[0]!, who.project, who.model, who.session, who.tool, `${who.session.slice(0, -1)}2`, `"id":${id}`];
}

describe('My usage: who may ask', () => {
  it('does not exist while the Admin setting is off, for anyone, signed in or not', async () => {
    const w = await setup({ on: false });
    await seed(w);
    expect((await request(w.app).get(`${USAGE}/spend`)).status).toBe(404);
    expect((await request(w.app).get(`${USAGE}/spend`)).body).toEqual({ ok: false, error: 'no such report' });
    expect((await request(w.app).get('/api/fleet/respond/me')).body.myUsage).toBe(false);
  });

  it('gives no figure to nobody signed in, an expired or revoked sign-in, or no token on the server', async () => {
    const w = await setup();
    await seed(w);
    const none = await request(w.app).get(`${USAGE}/spend`);
    expect(none.status).toBe(403);
    expect(Object.keys(none.body).sort()).toEqual(['error', 'ok']);
    const a = await signIn(w, 'Edwina Quill', w.ed.token);
    expect((await a.get(`${USAGE}/spend`)).status).toBe(200);
    await w.people.revoke(w.ed.person.id);
    const after = await a.get(`${USAGE}/spend`);
    expect(after.status).toBe(403);
    expect(text(after.body)).not.toContain(ED.project);
    const bare = await setup({ secret: null });
    expect((await request(bare.app).get(`${USAGE}/spend`)).status).toBe(404);
  });

  it('offers only the reports whose figures are one person\'s, and answers an unknown one as a missing one', async () => {
    const w = await setup();
    await seed(w);
    const a = await signIn(w, 'Edwina Quill', w.ed.token);
    for (const name of ['people', 'usage', 'activity', 'sessiontime', 'workload', 'costs', 'harness', 'no-such-report']) {
      const r = await a.get(`${USAGE}/${name}`);
      expect(r.status, name).toBe(404);
      expect(r.body).toEqual({ ok: false, error: 'no such report' });
    }
  });

  it('tells a signed-in person that the page is on', async () => {
    const w = await setup();
    const a = await signIn(w, 'Edwina Quill', w.ed.token);
    expect((await a.get('/api/fleet/respond/me')).body).toMatchObject({ signedIn: true, myUsage: true });
  });
});

describe('My usage: only your own', () => {
  it('shows Ed his figures and nothing of Alex, in every report, breakdown and format', async () => {
    const w = await setup();
    await seed(w);
    const a = await signIn(w, 'Edwina Quill', w.ed.token);
    let sawOwn = 0;
    for (const { path } of EVERY) {
      const json = await a.get(`${USAGE}/${path}`);
      expect(json.status, path).toBe(200);
      const body = text(json.body);
      for (const word of theirs(ALEX, w.alex.person.id)) expect(body, `${path} holds ${word}`).not.toContain(word);
      const csv = await a.get(`${USAGE}/${path}&format=csv`);
      expect(csv.status, path).toBe(200);
      for (const word of theirs(ALEX, w.alex.person.id)) expect(csv.text, `${path} csv holds ${word}`).not.toContain(word);
      if (body.includes(ED.project) || body.includes(ED.model) || body.includes(ED.tool)) sawOwn += 1;
    }
    // the reports are not just empty: Ed's own project, model and tool are in some of them
    expect(sawOwn).toBeGreaterThanOrEqual(3);
  });

  it('adds up only Ed\'s spend and sessions', async () => {
    const w = await setup();
    await seed(w);
    const a = await signIn(w, 'Edwina Quill', w.ed.token);
    const spend = (await a.get(`${USAGE}/spend?breakdown=none&from=2026-09-01&to=2026-10-20&by=month`)).body;
    expect(spend.total).toMatchObject({ sessions: 2 });
    expect(spend.mine).toBe(true);
    const sessions = (await a.get(`${USAGE}/sessions?from=2026-09-01&to=2026-10-20`)).body;
    expect(sessions.total).toMatchObject({ sessions: 2 });
    const tools = (await a.get(`${USAGE}/tools?from=2026-09-01&to=2026-10-20`)).body;
    expect(tools.total).toEqual({ calls: 9 });
    const failures = (await a.get(`${USAGE}/failures?from=2026-09-01&to=2026-10-20`)).body;
    expect(failures.total).toEqual({ count: 2 });
    expect(failures.columns.map((c: { key: string }) => c.key)).not.toContain('people');
  });

  it('shows Alex only his own, and an Administrator only their own, not the fleet\'s', async () => {
    const w = await setup();
    await seed(w);
    const alex = await signIn(w, 'Alexei Brandt', w.alex.token);
    const body = text((await alex.get(`${USAGE}/spend?breakdown=project&from=2026-09-01&to=2026-10-20`)).body);
    expect(body).toContain(ALEX.project);
    for (const word of theirs(ED, w.ed.person.id)) expect(body).not.toContain(word);
    const boss = await signIn(w, 'Bosswell', w.boss.token);
    for (const { path } of EVERY) {
      const mine = text((await boss.get(`${USAGE}/${path}`)).body);
      for (const word of [...theirs(ED, w.ed.person.id), ...theirs(ALEX, w.alex.person.id), 'admin-repo', 'model-admin']) expect(mine, `${path} holds ${word}`).not.toContain(word);
    }
    expect((await boss.get(`${USAGE}/spend?breakdown=none&from=2026-09-01&to=2026-10-20&by=month`)).body.total).toMatchObject({ sessions: 0 });
  });

  it('gives the admin secret the Admin\'s own sessions, not the fleet\'s', async () => {
    const w = await setup();
    await seed(w);
    const a = await signIn(w, 'Admin', SECRET);
    const spend = (await a.get(`${USAGE}/spend?breakdown=project&from=2026-09-01&to=2026-10-20`)).body;
    expect(text(spend)).toContain('admin-repo');
    for (const word of [...theirs(ED, w.ed.person.id), ...theirs(ALEX, w.alex.person.id)]) expect(text(spend)).not.toContain(word);
  });
});

describe('My usage: a request cannot widen or change whose figures these are', () => {
  const HOSTILE = [
    'person=Alexei%20Brandt',
    'group=Administrators',
    'owner=Alexei%20Brandt',
    'user=Alexei%20Brandt',
    'name=Alexei%20Brandt',
    'id=1',
    'sessionId=sess-brandt-1',
    'session=sess-brandt-1',
    'reporter=anything',
    'people=all',
    'everyone=1',
    'all=1',
    'as=Alexei%20Brandt',
    'person=',
    'person=a&person=b',
    'person[]=Alexei%20Brandt',
  ];

  it('returns the same answer with any person, group, id or name in the query as without', async () => {
    const w = await setup();
    await seed(w);
    const a = await signIn(w, 'Edwina Quill', w.ed.token);
    for (const { path } of EVERY) {
      const plain = await a.get(`${USAGE}/${path}`);
      for (const extra of HOSTILE) {
        const r = await a.get(`${USAGE}/${path}&${extra}`);
        expect(r.status, `${path} ${extra}`).toBe(plain.status);
        expect(r.body, `${path} ${extra}`).toEqual(plain.body);
      }
    }
  });

  it('ignores a person in a header, a cookie or the path, and never reads a body', async () => {
    const w = await setup();
    await seed(w);
    const a = await signIn(w, 'Edwina Quill', w.ed.token);
    const path = `${USAGE}/spend?breakdown=project&from=2026-09-01&to=2026-10-20`;
    const plain = (await a.get(path)).body;
    for (const [k, v] of [['X-Podium-Person', 'Alexei Brandt'], ['X-Podium-Owner', 'Alexei Brandt'], ['X-Podium-Admin', '1'], ['X-Forwarded-User', 'Alexei Brandt'], ['X-Podium-Token', w.alex.token]] as const) {
      expect((await a.get(path).set(k, v)).body, k).toEqual(plain);
    }
    expect((await a.get(path).set('Cookie', `person=Alexei%20Brandt; podium_respond=bogus`)).status).toBe(200);
    // a body on a GET is not read, and a write to the route does not exist
    expect((await a.get(path).send({ person: 'Alexei Brandt' })).body).toEqual(plain);
    expect((await a.post(`${USAGE}/spend`).set(H).send({ person: 'Alexei Brandt' })).status).toBe(404);
    expect(text((await a.get(`${USAGE}/${encodeURIComponent('spend/../../people')}`)).body)).not.toContain(ALEX.name);
    expect(text((await a.get(`${USAGE}/spend/${encodeURIComponent(ALEX.name)}`)).body)).not.toContain(ALEX.name);
  });

  it('refuses a breakdown that names people, and never puts a name in an error', async () => {
    const w = await setup();
    await seed(w);
    const a = await signIn(w, 'Edwina Quill', w.ed.token);
    for (const path of ['spend?breakdown=person', 'spend?breakdown=group', 'failures?breakdown=person', 'tools?breakdown=session', 'sessions?breakdown=nope', 'spend?from=nope', 'spend?to=2999-01-01', 'spend?by=year', 'tools?harness=%20bad', 'spend?format=xml']) {
      const r = await a.get(`${USAGE}/${path}`);
      expect(r.status, path).toBe(400);
      for (const who of [ALEX, ED]) expect(text(r.body), path).not.toContain(who.name);
    }
  });

  it('answers a missing report and a report of someone else the same way', async () => {
    const w = await setup();
    await seed(w);
    const a = await signIn(w, 'Edwina Quill', w.ed.token);
    const missing = await a.get(`${USAGE}/no-such-report?person=nobody-at-all`);
    const theirsAsked = await a.get(`${USAGE}/people?person=Alexei%20Brandt`);
    expect(theirsAsked.status).toBe(missing.status);
    expect(theirsAsked.body).toEqual(missing.body);
  });
});

describe('My usage: the query layer', () => {
  it('needs a person: a missing or blank one is an error, not a whole-fleet query', async () => {
    expect(() => personScope('')).toThrow('a person scope needs the person');
    expect(() => personScope('   ')).toThrow('a person scope needs the person');
    const w = await setup();
    await seed(w);
    const deps = { db: w.fleet.db, tx: w.storage.tx, now: w.fleet.now, pricing: () => w.fleet.prices.pricing(), retention: w.fleet.cfg.retention };
    await expect(runMyReport(deps, '  ', 'spend', {})).rejects.toThrow('a person scope needs the person');
    const mine = await runMyReport(deps, ED.name, 'spend', { person: ALEX.name, breakdown: 'project', from: '2026-09-01', to: '2026-10-20' });
    expect(JSON.stringify(mine)).not.toContain(ALEX.project);
  });
});

describe('My usage: harnesses', () => {
  it('filters tool calls by harness and keeps a harness column', async () => {
    const w = await setup();
    await seed(w);
    await w.fleet.db.upsertSession(session({ id: 'sess-quill-oc', owner: ED.name, harness: 'opencode', repo_name: ED.project, model: ED.model, started_at: at(1, 9), last_seen_at: at(1, 10), ended_at: at(1, 10) }));
    await w.fleet.db.upsertAgent(agent('sess-quill-oc', 'oc-a', { tool_counts_json: JSON.stringify({ read: 5 }) }));
    const a = await signIn(w, 'Edwina Quill', w.ed.token);
    const all = (await a.get(`${USAGE}/tools?from=2026-09-01&to=2026-10-20`)).body;
    expect(all.columns.map((c: { key: string }) => c.key)).toContain('harness');
    expect(all.harnesses).toEqual(['claude-code', 'opencode']);
    const oc = (await a.get(`${USAGE}/tools?from=2026-09-01&to=2026-10-20&harness=opencode`)).body;
    expect(oc.rows.map((r: { harness: string; tool: string }) => `${r.harness}/${r.tool}`)).toEqual(['opencode/read']);
  });
});
