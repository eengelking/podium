// What the async storage must not break around people and reporters (#313): the report path (identify, ignore check, ingest, touch,
// note the reporter), the console's sign-in to respond, the reporter bookkeeping and the forget sweep. The storage calls here each
// take a few milliseconds, as a networked database's would, so a straight `await` port of the synchronous code would let two
// requests interleave where the synchronous code could not.
//
// Run with PODIUM_NAIVE_TX=1 to see the sweep test catch a port with no transaction (the router tests below do not use one).
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openSqliteStorage, type SqliteStorage } from '../storage/sqlite/index.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import { createFleetRouter } from './routes.js';
import { forgetReporters } from './sweeper.js';
import { newPersonToken } from './tokens.js';
import type { ReporterSeen } from './reporters.js';
import { fixtureReport } from './testing.js';

const SECRET = 'admin-secret';
const NAIVE = process.env.PODIUM_NAIVE_TX === '1';
const CALL_MS = 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RH = { 'X-Podium-Respond': '1' };

/** The same store with every method taking CALL_MS before it runs. */
function slow<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, key) {
      const v = (t as Record<string | symbol, unknown>)[key];
      if (typeof v !== 'function') return v;
      return async (...args: unknown[]) => {
        await sleep(CALL_MS);
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function setup() {
  const storage: SqliteStorage = openSqliteStorage(':memory:', 0);
  const fleet = new Fleet(storage, { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' });
  await fleet.init();
  closers.push(async () => {
    fleet.close();
    await storage.close();
  });
  await fleet.features.setFeature('respond', true);
  const people = slow(storage.people);
  const reporters = slow(storage.reporters);
  const app = express();
  app.use('/api/fleet', createFleetRouter(fleet, { token: SECRET, people, reporters, log: () => undefined }));
  return { storage, fleet, app };
}

const seen = (machineId: string, over: Partial<ReporterSeen> = {}): ReporterSeen => ({
  kind: 'mod',
  machineId,
  machineName: machineId,
  source: '10.0.0.1',
  owner: 'Ed',
  credential: 'pdm_x',
  version: '1.3.1',
  engineVersion: '2.1.0',
  sessionId: `s-${machineId}`,
  ...over,
});

function report(userName: string, id: string) {
  const r = fixtureReport();
  r.userName = userName;
  r.session = { ...r.session, id };
  r.events = r.events.map((e) => ({ ...e, id: `${id}:${e.id}` }));
  return r;
}

describe('the report path', () => {
  it('counts a stored report for the person and notes the reporter, and counts neither for one that was refused', async () => {
    const { storage, app } = await setup();
    const ed = await storage.people.createPerson('Ed');
    const alex = await storage.people.createPerson('Alex');
    // Alex's session is taken by Ed first; Alex then reports the same id and is refused as someone else's.
    expect((await request(app).post('/api/fleet/report').set('X-Podium-Token', ed.token).send(report('Ed', 'shared'))).status).toBe(200);
    const refused = await request(app).post('/api/fleet/report').set('X-Podium-Token', alex.token).send(report('Alex', 'shared'));
    expect(refused.status).toBe(409);
    expect((await storage.people.getPerson(ed.person.id))!.lastReportAt).not.toBeNull();
    expect((await storage.people.getPerson(alex.person.id))!.lastReportAt).toBeNull();
    const list = await storage.reporters.list({}, Date.now());
    expect(list.rows.map((r) => r.credential)).toEqual([`pdm_${ed.person.keyId}`]);
  });

  it('refuses a token that is unknown, revoked or wrong, and a report from an ignored reporter, and records why', async () => {
    const { storage, app } = await setup();
    const ed = await storage.people.createPerson('Ed');
    const post = (token: string, r = report('Ed', 'x1')) => request(app).post('/api/fleet/report').set('X-Podium-Token', token).send(r);
    expect((await post(newPersonToken().token)).status).toBe(401);
    expect((await post(`${ed.token}x`)).status).toBe(401);
    await storage.people.revoke(ed.person.id);
    expect((await post(ed.token)).status).toBe(401);
    // The admin secret reports as Admin while the Admin allows it, and is refused once the Admin turns that off.
    expect((await post(SECRET, report('Admin', 'x2'))).status).toBe(200);
    await storage.people.setAdminReporting(false);
    expect((await post(SECRET, report('Admin', 'x3'))).status).toBe(401);
    await storage.people.setAdminReporting(true);
    await storage.reporters.addIgnore('version', fixtureReport().reporter.version, 1);
    const ignored = await post(SECRET, report('Admin', 'x4'));
    expect(ignored.status).toBe(403);
    expect(ignored.body.error).toBe('this reporter is ignored by the Admin');
  });
});

describe('the console sign-in to respond', () => {
  it('refuses every wrong sign-in past the limit, though they were all sent before the first was answered', async () => {
    const { app } = await setup();
    const wrong = () => request(app).post('/api/fleet/respond/sign-in').set(RH).send({ name: 'Ed', token: newPersonToken().token });
    const codes = (await Promise.all(Array.from({ length: 9 }, wrong))).map((r) => r.status);
    expect(codes.filter((c) => c === 401)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(4);
  });

  it('ends a sign-in that a sign-out reaches while the person is being read, and does not bring it back', async () => {
    const { storage, app } = await setup();
    const ed = await storage.people.createPerson('Ed');
    const agent = request.agent(app);
    await agent.post('/api/fleet/respond/sign-in').set(RH).send({ name: 'Ed', token: ed.token }).expect(200);
    const me = agent.get('/api/fleet/respond/me').then((r) => r);
    await sleep(CALL_MS / 2);
    const out = agent.post('/api/fleet/respond/sign-out').set(RH).then((r) => r);
    expect((await Promise.all([me, out]))[0].body.signedIn).toBe(false);
    expect((await agent.get('/api/fleet/respond/me')).body.signedIn).toBe(false);
  });

  it('keeps a sign-in whose person is read by two requests at once', async () => {
    const { storage, app } = await setup();
    const ed = await storage.people.createPerson('Ed');
    const agent = request.agent(app);
    await agent.post('/api/fleet/respond/sign-in').set(RH).send({ name: 'Ed', token: ed.token }).expect(200);
    const both = await Promise.all([agent.get('/api/fleet/respond/me'), agent.get('/api/fleet/respond/me')]);
    expect(both.map((r) => r.body.signedIn)).toEqual([true, true]);
    expect((await agent.get('/api/fleet/respond/me')).body.name).toBe('Ed');
  });
});

describe('reporter bookkeeping', () => {
  it('files two reports of one machine made at once under one reporter with both sessions', async () => {
    const storage = openSqliteStorage(':memory:', 0);
    closers.push(() => storage.close());
    const keys = await Promise.all([storage.reporters.record(seen('m1', { sessionId: 'a' }), 5), storage.reporters.record(seen('m1', { sessionId: 'b' }), 6)]);
    expect(keys).toEqual(['m1', 'm1']);
    const list = await storage.reporters.list({}, 10);
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({ key: 'm1', sessions: 2, firstSeenAt: 5, lastSeenAt: 6 });
  });

  it('files two reports from one address that reach it as two sessions under the row that already holds the session', async () => {
    const storage = openSqliteStorage(':memory:', 0);
    closers.push(() => storage.close());
    const hooks = (source: string, sessionId: string) => seen('', { kind: 'hooks', machineId: null, machineName: null, source, sessionId });
    await storage.reporters.record(hooks('10.0.0.1', 'a'), 5);
    // The same session now arrives from a new address and a different session from the first one at once.
    await Promise.all([storage.reporters.record(hooks('10.0.0.2', 'a'), 6), storage.reporters.record(hooks('10.0.0.1', 'c'), 6)]);
    const list = await storage.reporters.list({}, 10);
    expect(list.rows.map((r) => r.key).sort()).toEqual(['hooks:10.0.0.1']);
    expect(list.rows[0]!.sessions).toBe(2);
  });
});

describe('forgetting reporters by age', () => {
  it('writes the days it used, even when the Admin changes the setting while it runs (naive: fails)', async () => {
    const storage = openSqliteStorage(':memory:', 0);
    closers.push(() => storage.close());
    const now = 200 * 86_400_000;
    await storage.reporters.record(seen('old'), 1);
    await storage.reporters.setForgetSetting({ enabled: true, days: 30 });
    const lines: string[] = [];
    const logger = { info: (_e: string, text: string) => void lines.push(text) } as never;
    const sweep = forgetReporters({ people: storage.people, reporters: storage.reporters, tx: NAIVE ? (fn) => fn() : storage.tx }, logger, now);
    const change = storage.reporters.setForgetSetting({ days: 5 });
    await Promise.all([sweep, change]);
    const entry = (await storage.people.listLog({})).rows.find((r) => r.kind === 'reporters_forgotten')!;
    expect(entry.detail).toBe('Forgot 1 reporter not heard from for 30 days');
    expect(lines).toEqual(['podium: Forgot 1 reporter not heard from for 30 days']);
  });

  it('says nothing when nothing was forgotten', async () => {
    const storage = openSqliteStorage(':memory:', 0);
    closers.push(() => storage.close());
    const lines: string[] = [];
    await forgetReporters(storage, { info: (_e: string, text: string) => void lines.push(text) } as never, 200 * 86_400_000);
    expect(lines).toEqual([]);
    expect((await storage.people.listLog({})).total).toBe(0);
  });
});
