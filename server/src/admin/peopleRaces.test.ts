// What the async storage must not break in the Admin router (#313): its read-then-write sequences (revoke, move to a group, add an
// ignore rule, change a setting and read it back) were atomic only because every store call was synchronous. These run two requests
// against each other over a real in-memory SQLite storage whose calls each take a few milliseconds, as a networked database's would,
// so a straight `await` port of the synchronous code would let them interleave.
//
// To see that these tests catch that port, run them with PODIUM_NAIVE_TX=1: the router's `storage.tx` then just calls its callback,
// and the tests marked "(naive: fails)" below must fail.
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openSqliteStorage, type SqliteStorage } from '../storage/sqlite/index.js';
import { createAdminRouter } from './adminRouter.js';
import { LiveTlsSettings } from '../tlsLive.js';
import { newPersonToken } from '../fleet/tokens.js';
import type { ReporterSeen } from '../storage/rows.js';

const SECRET = 'the-admin-secret-0123456789';
const H = { 'X-Podium-Admin': '1' };
const NAIVE = process.env.PODIUM_NAIVE_TX === '1';
/** How long one storage call takes in these tests. Two requests that start within a few ms of each other overlap. */
const CALL_MS = 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function setup(over: Partial<Parameters<typeof createAdminRouter>[0]> = {}) {
  const storage: SqliteStorage = openSqliteStorage(':memory:', 0);
  closers.push(() => storage.close());
  const tx = NAIVE ? <T>(fn: () => Promise<T>) => fn() : storage.tx;
  const app = express();
  const certStore = storage.personCerts;
  app.use(
    '/api/admin',
    createAdminRouter({
      secret: SECRET,
      storage: { tx },
      people: slow(storage.people),
      reporters: slow(storage.reporters),
      certificates: { settings: new LiveTlsSettings(storage.tlsSettings, storage.tx), renewer: () => null, people: { store: certStore, issuer: () => ({}) as never } },
      now: () => 1_000_000,
      log: () => undefined,
      ...over,
    }),
  );
  return { storage, app };
}

async function unlocked(app: express.Express) {
  const agent = request.agent(app);
  await agent.post('/api/admin/unlock').set(H).send({ name: 'Admin', token: SECRET }).expect(200);
  return agent;
}

/** Two Administrators, both active; the admin secret opens Admin and is not one of them. */
async function twoAdministrators(storage: SqliteStorage) {
  const admins = (await storage.people.allGroups()).find((g) => g.name === 'Administrators')!;
  const a = (await storage.people.createPerson('Ada', admins.id)).person;
  const b = (await storage.people.createPerson('Bo', admins.id)).person;
  const active = async () => Number(await storage.people.isAdministrator(a.id)) + Number(await storage.people.isAdministrator(b.id));
  return { a, b, admins, active };
}

const seen = (machineId: string, over: Partial<ReporterSeen> = {}): ReporterSeen => ({
  kind: 'mod',
  machineId,
  machineName: machineId,
  source: '10.0.0.1',
  owner: 'Ada',
  credential: 'pdm_x',
  version: '1.3.1',
  engineVersion: '2.1.0',
  sessionId: `s-${machineId}`,
  ...over,
});

describe('Admin changes that read, decide and write', () => {
  it('lets two requests with one name make exactly one person, and answers the other as taken', async () => {
    const { storage, app } = setup();
    const agent = await unlocked(app);
    const res = await Promise.all([1, 2].map(() => agent.post('/api/admin/people').set(H).send({ name: 'Dana' })));
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await storage.people.list({})).total).toBe(1);
    expect(res.find((r) => r.status === 409)!.body.error).toMatch(/already taken/);
  });

  it('refuses the second of two revokes that would leave Administrators with nobody (naive: fails)', async () => {
    const { storage, app } = setup();
    const { a, b, active } = await twoAdministrators(storage);
    const agent = await unlocked(app);
    const res = await Promise.all([agent.post(`/api/admin/people/${a.id}/revoke`).set(H), agent.post(`/api/admin/people/${b.id}/revoke`).set(H)]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(res.find((r) => r.status === 400)!.body.error).toMatch(/last person in Administrators/);
    expect(await active()).toBe(1);
  });

  it('refuses the second of two revoke-alls that would leave Administrators with nobody (naive: fails)', async () => {
    const { storage, app } = setup();
    const { a, b, active } = await twoAdministrators(storage);
    const agent = await unlocked(app);
    const res = await Promise.all([agent.post(`/api/admin/people/${a.id}/revoke-all`).set(H), agent.post(`/api/admin/people/${b.id}/revoke-all`).set(H)]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await active()).toBe(1);
  });

  it('answers a revoke of nobody as unknown, and a store that fails mid-revoke as the router answers any failure, rolled back', async () => {
    const { storage, app } = setup();
    const { a, active } = await twoAdministrators(storage);
    expect((await (await unlocked(app)).post('/api/admin/people/9999/revoke').set(H)).status).toBe(404);
    const failing = setup({ people: { ...slow(storage.people), revoke: async () => Promise.reject(new Error('disk is full')) } as never, storage: { tx: storage.tx } });
    const res = await (await unlocked(failing.app)).post(`/api/admin/people/${a.id}/revoke`).set(H);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad request');
    expect(await active()).toBe(2);
  });

  it('names the group a person was moved to even when that group is deleted right after (naive: fails)', async () => {
    const { storage, app } = setup();
    const p = (await storage.people.createPerson('Priya')).person;
    const g = await storage.people.createGroup('Backend');
    const agent = await unlocked(app);
    const move = agent.put(`/api/admin/people/${p.id}/group`).set(H).send({ groupId: g.id }).then((r) => r);
    await sleep(2);
    const drop = agent.delete(`/api/admin/groups/${g.id}`).set(H).then((r) => r);
    const [moved] = await Promise.all([move, drop]);
    expect(moved.status).toBe(200);
    const entry = (await storage.people.listLog({})).rows.find((r) => r.kind === 'group_assigned')!;
    expect(entry.detail).toBe('Priya moved to Backend');
  });

  it('counts what each of two added ignore rules took off the list, not the other rule too (naive: fails)', async () => {
    const { storage, app } = setup();
    await storage.reporters.record(seen('m1'), 1_000_000);
    await storage.reporters.record(seen('m2'), 1_000_000);
    const agent = await unlocked(app);
    const res = await Promise.all([agent.post('/api/admin/reporters/ignores').set(H).send({ kind: 'key', pattern: 'm1' }), agent.post('/api/admin/reporters/ignores').set(H).send({ kind: 'key', pattern: 'm2' })]);
    expect(res.map((r) => r.body.removed)).toEqual([1, 1]);
    expect((await storage.reporters.list({}, 1_000_000)).counts.all).toBe(0);
    expect((await storage.reporters.listIgnores()).length).toBe(2);
  });

  it('does not remove a reporter that stopped matching the filter after the keys were read (naive: fails)', async () => {
    const T = 10_000_000;
    const probe = openSqliteStorage(':memory:', 0);
    closers.push(() => probe.close());
    const base = slow(probe.reporters);
    let keysRead!: () => void;
    const read = new Promise<void>((r) => (keysRead = r));
    const reporters = { ...base, keys: async (...a: Parameters<typeof base.keys>) => { const out = await base.keys(...a); keysRead(); await sleep(CALL_MS); return out; } };
    const { app } = setup({ now: () => T, reporters, people: slow(probe.people), storage: { tx: NAIVE ? (fn) => fn() : probe.tx } });
    await probe.reporters.record(seen('m1'), T - 2 * 3_600_000);
    const agent = await unlocked(app);
    expect((await probe.reporters.list({ state: 'silent' }, T)).counts.silent).toBe(1);
    // The remove reads the silent reporters' keys, then removes them; a report from m1 lands in between and makes it reporting.
    const remove = agent.post('/api/admin/reporters/remove').set(H).send({ match: { state: 'silent' } }).then((r) => r);
    await read;
    await probe.reporters.record(seen('m1'), T);
    expect((await remove).status).toBe(200);
    // Serially the report came before the remove (nothing silent to remove) or after it (the report brings m1 back): m1 is there.
    expect((await probe.reporters.list({}, T)).counts.reporting).toBe(1);
  });

  it('answers each of two forget-setting changes with its own values (naive: fails)', async () => {
    const { app } = setup();
    const agent = await unlocked(app);
    const a = agent.put('/api/admin/settings').set(H).send({ forgetReporters: { enabled: true, days: 10 } }).then((r) => r);
    await sleep(2);
    const b = agent.put('/api/admin/settings').set(H).send({ forgetReporters: { enabled: true, days: 20 } }).then((r) => r);
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.body.forgetReporters.days, rb.body.forgetReporters.days]).toEqual([10, 20]);
  });

  it('answers a bad forget-setting without changing anything', async () => {
    const { storage, app } = setup();
    const agent = await unlocked(app);
    const res = await agent.put('/api/admin/settings').set(H).send({ forgetReporters: { enabled: true, days: 0 } });
    expect(res.status).toBe(400);
    expect((await storage.reporters.forgetSetting()).enabled).toBe(false);
  });

  it('refuses every wrong unlock past the limit, though they were all sent before the first was answered', async () => {
    const { app } = setup({ maxFails: 5 });
    const wrong = () => request(app).post('/api/admin/unlock').set(H).send({ name: 'Ada', token: newPersonToken().token });
    const res = await Promise.all(Array.from({ length: 9 }, wrong));
    const codes = res.map((r) => r.status);
    expect(codes.filter((c) => c === 401)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(4);
  });

  it('does not let a lock that arrives while a session is being checked bring the session back', async () => {
    const { storage, app } = setup();
    const { a } = await twoAdministrators(storage);
    const token = (await storage.people.rotate(a.id))!.token;
    const agent = request.agent(app);
    await agent.post('/api/admin/unlock').set(H).send({ name: 'Ada', token }).expect(200);
    const lock = agent.post('/api/admin/lock').set(H).then((r) => r);
    await sleep(CALL_MS / 2);
    const read = agent.get('/api/admin/people').set(H).then((r) => r);
    expect((await Promise.all([lock, read]))[1].status).toBe(401);
    expect((await agent.get('/api/admin/people').set(H)).status).toBe(401);
  });
});
