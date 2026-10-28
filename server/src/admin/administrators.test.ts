// The built-in Administrators group (issue #172): a person in it can open Admin with their own token.
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openSqliteStorage } from '../storage/sqlite/index.js';
import { LiveFeatureFlags, LiveModelPrices, LiveWallSettings } from '../fleet/liveSettings.js';
import { createAdminRouter } from './adminRouter.js';

const SECRET = 'the-admin-secret-0123456789';
const H = { 'X-Podium-Admin': '1' };

async function setup() {
  const storage = openSqliteStorage(':memory:', 0);
  const people = storage.people;
  const wall = new LiveWallSettings(storage.wallSettings);
  const prices = new LiveModelPrices(storage.modelPrices, storage.tx);
  const features = new LiveFeatureFlags(storage.featureFlags);
  await Promise.all([wall.load(), prices.load(), features.load()]);
  const clock = { t: 1_000_000 };
  const app = express();
  app.use(
    '/api/admin',
    createAdminRouter({
      secret: SECRET,
      storage,
      people,
      wall,
      prices,
      features,
      reporters: storage.reporters,
      now: () => clock.t,
      log: () => undefined,
    }),
  );
  const admins = (await people.allGroups()).find((g) => g.name === 'Administrators');
  return { app, people, clock, admins };
}

const unlockWith = (_app: express.Express, agent: ReturnType<typeof request.agent>, name: string, token: string) => agent.post('/api/admin/unlock').set(H).send({ name, token });

describe('the Administrators group', () => {
  it('exists on a fresh server and is marked built in', async () => {
    const { people, admins } = await setup();
    expect(admins).toBeDefined();
    expect((await people.listGroups({})).rows.find((g) => g.id === admins!.id)?.builtIn).toBe(true);
  });

  it('cannot be deleted, and says why', async () => {
    const { app, admins, people } = await setup();
    const agent = request.agent(app);
    await unlockWith(app, agent, 'Admin', SECRET);
    const res = await agent.delete(`/api/admin/groups/${admins!.id}`).set(H);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/built in/i);
    expect(await people.getGroup(admins!.id)).toBeDefined();
  });
});

describe('unlocking Admin with a person token', () => {
  it("opens Admin for a member, and the admin log names the person", async () => {
    const { app, people, admins } = await setup();
    const { person, token } = await people.createPerson('Priya', admins!.id);
    const agent = request.agent(app);
    expect((await unlockWith(app, agent, 'Priya', token)).status).toBe(200);
    expect((await agent.get('/api/admin/people').set(H)).status).toBe(200);
    expect((await agent.post('/api/admin/groups').set(H).send({ name: 'Backend' })).status).toBe(201);
    const log = (await people.listLog({ page: 1, pageSize: 50 })).rows;
    expect(log.find((r) => r.kind === 'group_created')?.actor).toBe('Priya');
    expect(log.find((r) => r.kind === 'unlock')?.actor).toBe('Priya');
    expect(person.id).toBeGreaterThan(0);
  });

  it('names the admin secret as the actor for changes it makes', async () => {
    const { app, people } = await setup();
    const agent = request.agent(app);
    await unlockWith(app, agent, 'Admin', SECRET);
    await agent.post('/api/admin/groups').set(H).send({ name: 'Backend' });
    expect((await people.listLog({ page: 1, pageSize: 50 })).rows.find((r) => r.kind === 'group_created')?.actor).toBe('Admin secret');
  });

  it('refuses a person outside the group, a revoked token and an unknown token, never saying which part was wrong', async () => {
    const { app, people, admins } = await setup();
    const outsider = await people.createPerson('Dana', null);
    const revoked = await people.createPerson('Lee', admins!.id);
    await people.revoke(revoked.person.id);
    const unknown = (await people.createPerson('Tmp', admins!.id)).token.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    const tries: [string, string][] = [['Dana', outsider.token], ['Lee', revoked.token], ['Tmp', unknown]];
    for (const [name, t] of tries) {
      const res = await unlockWith(app, request.agent(app), name, t);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('wrong name or token');
    }
  });

  it('counts refused tokens toward the same lockout', async () => {
    const { app, people } = await setup();
    const { token } = await people.createPerson('Dana', null);
    for (let i = 0; i < 5; i++) expect((await unlockWith(app, request.agent(app), 'Dana', token)).status).toBe(401);
    expect((await unlockWith(app, request.agent(app), 'Admin', SECRET)).status).toBe(429);
  });

  it('needs the person\'s own name with the token, in any letter case', async () => {
    const { app, people, admins } = await setup();
    const { token } = await people.createPerson('Priya', admins!.id);
    const wrong = await unlockWith(app, request.agent(app), 'Dana', token);
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('wrong name or token');
    expect((await unlockWith(app, request.agent(app), '  priya ', token)).status).toBe(200);
  });

  it('takes the admin secret only with the name Admin', async () => {
    const { app } = await setup();
    expect((await unlockWith(app, request.agent(app), 'Priya', SECRET)).status).toBe(401);
    expect((await unlockWith(app, request.agent(app), 'admin', SECRET)).status).toBe(200);
  });

  it('refuses a token alone, or a name alone, with a 400', async () => {
    const { app, people, admins } = await setup();
    const { token } = await people.createPerson('Priya', admins!.id);
    expect((await request(app).post('/api/admin/unlock').set(H).send({ secret: SECRET })).status).toBe(400);
    expect((await request(app).post('/api/admin/unlock').set(H).send({ token })).status).toBe(400);
    expect((await request(app).post('/api/admin/unlock').set(H).send({ name: 'Priya' })).status).toBe(400);
  });

  it('does not let an ordinary person reach any Admin route after a refused sign-in', async () => {
    const { app, people } = await setup();
    const { token } = await people.createPerson('Dana', null);
    const agent = request.agent(app);
    expect((await unlockWith(app, agent, 'Dana', token)).status).toBe(401);
    for (const path of ['/api/admin/people', '/api/admin/groups', '/api/admin/settings']) expect((await agent.get(path).set(H)).status).toBe(401);
  });

  it('ends the open session when the person leaves the group', async () => {
    const { app, people, admins } = await setup();
    const { person, token } = await people.createPerson('Priya', admins!.id);
    const agent = request.agent(app);
    await unlockWith(app, agent, 'Priya', token);
    expect((await agent.get('/api/admin/groups').set(H)).status).toBe(200);
    await people.setGroup(person.id, null);
    expect((await agent.get('/api/admin/groups').set(H)).status).toBe(401);
  });

  it('ends the open session when the token is revoked', async () => {
    const { app, people, admins } = await setup();
    const { person, token } = await people.createPerson('Priya', admins!.id);
    const agent = request.agent(app);
    await unlockWith(app, agent, 'Priya', token);
    await people.revoke(person.id);
    expect((await agent.get('/api/admin/groups').set(H)).status).toBe(401);
  });
});

describe('who is recorded', () => {
  it('still names an administrator whose own change ends their session', async () => {
    const { app, people, admins } = await setup();
    const { person, token } = await people.createPerson('Priya', admins!.id);
    const agent = request.agent(app);
    await unlockWith(app, agent, 'Priya', token);
    expect((await agent.put(`/api/admin/people/${person.id}/group`).set(H).send({ groupId: null })).status).toBe(200);
    expect((await people.listLog({ page: 1, pageSize: 50 })).rows.find((r) => r.kind === 'group_assigned')?.actor).toBe('Priya');
    expect((await agent.get('/api/admin/groups').set(H)).status).toBe(401);
  });

  it('keeps the name "Admin secret" for the secret, so no person can take it', async () => {
    const { people } = await setup();
    await expect(people.createPerson('Admin secret')).rejects.toThrow(/reserved/);
    await expect(people.createPerson('admin SECRET')).rejects.toThrow(/reserved/);
  });
});

describe('deleting people (#243)', () => {
  const del = (agent: ReturnType<typeof request.agent>, ids: unknown) => agent.post('/api/admin/people/delete').set(H).send({ ids });

  it('deletes one or several people, answers with the count and logs who deleted whom', async () => {
    const { app, people } = await setup();
    const agent = request.agent(app);
    await unlockWith(app, agent, 'Admin', SECRET);
    const a = await people.createPerson('Ada');
    const b = await people.createPerson('Bo');
    const c = await people.createPerson('Cy');
    const res = await del(agent, [a.person.id, b.person.id]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: 2 });
    expect(await people.getPerson(a.person.id)).toBeUndefined();
    expect(await people.getPerson(b.person.id)).toBeUndefined();
    expect(await people.getPerson(c.person.id)).toBeDefined();
    const entries = (await people.listLog({ page: 1, pageSize: 50 })).rows.filter((r) => r.kind === 'person_deleted');
    expect(entries.map((r) => r.detail).sort()).toEqual(['Deleted Ada', 'Deleted Bo']);
    expect(entries.every((r) => r.actor === 'Admin secret')).toBe(true);
    expect((await del(agent, [c.person.id])).body.removed).toBe(1);
  });

  it("refuses the deleted person's token at once, and lets the name be created again", async () => {
    const { app, people } = await setup();
    const agent = request.agent(app);
    await unlockWith(app, agent, 'Admin', SECRET);
    const { person } = await people.createPerson('Ada');
    expect(await people.findByKeyId(person.keyId)).toBeDefined();
    await del(agent, [person.id]);
    expect(await people.findByKeyId(person.keyId)).toBeUndefined();
    await expect(people.createPerson('Ada')).resolves.not.toThrow();
  });

  it('locks the open Admin session of a deleted Administrator', async () => {
    const { app, people, admins } = await setup();
    const { person, token } = await people.createPerson('Priya', admins!.id);
    const other = await people.createPerson('Quinn', admins!.id);
    const mine = request.agent(app);
    await unlockWith(app, mine, 'Quinn', other.token);
    const theirs = request.agent(app);
    await unlockWith(app, theirs, 'Priya', token);
    expect((await del(mine, [person.id])).status).toBe(200);
    expect((await theirs.get('/api/admin/groups').set(H)).status).toBe(401);
  });

  it('refuses the signed-in person, deleting nobody from the request', async () => {
    const { app, people, admins } = await setup();
    const me = await people.createPerson('Priya', admins!.id);
    const ada = await people.createPerson('Ada');
    const agent = request.agent(app);
    await unlockWith(app, agent, 'Priya', me.token);
    const res = await del(agent, [ada.person.id, me.person.id]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signed in/i);
    expect(await people.getPerson(ada.person.id)).toBeDefined();
    expect(await people.getPerson(me.person.id)).toBeDefined();
  });

  it('refuses to delete the last Administrators member', async () => {
    const { app, people, admins } = await setup();
    const only = await people.createPerson('Priya', admins!.id);
    const agent = request.agent(app);
    await unlockWith(app, agent, 'Admin', SECRET);
    const res = await del(agent, [only.person.id]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/last/i);
    expect(await people.getPerson(only.person.id)).toBeDefined();
    const second = await people.createPerson('Quinn', admins!.id);
    expect((await del(agent, [only.person.id, second.person.id])).status).toBe(400);
    expect((await del(agent, [only.person.id])).status).toBe(200);
  });

  it('counts only active members: a revoked one does not save the last active Administrator', async () => {
    const { app, people, admins } = await setup();
    const active = await people.createPerson('Priya', admins!.id);
    const revoked = await people.createPerson('Quinn', admins!.id);
    await people.revoke(revoked.person.id);
    const agent = request.agent(app);
    await unlockWith(app, agent, 'Admin', SECRET);
    const res = await del(agent, [active.person.id]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/last/i);
    expect(await people.getPerson(active.person.id)).toBeDefined();
    // A revoked Administrator can go: it never counted.
    expect((await del(agent, [revoked.person.id])).status).toBe(200);
  });

  it('skips an unknown id beside a known one and counts only the people it removed', async () => {
    const { app, people } = await setup();
    const agent = request.agent(app);
    await unlockWith(app, agent, 'Admin', SECRET);
    const a = await people.createPerson('Ada');
    const res = await del(agent, [a.person.id, 9999]);
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(1);
  });

  it('rejects a bad list and an unknown person', async () => {
    const { app } = await setup();
    const agent = request.agent(app);
    await unlockWith(app, agent, 'Admin', SECRET);
    expect((await del(agent, [])).status).toBe(400);
    expect((await del(agent, 'x')).status).toBe(400);
    expect((await del(agent, [1, 'a'])).status).toBe(400);
    expect((await del(agent, Array.from({ length: 501 }, (_, i) => i + 1))).status).toBe(400);
    expect((await del(agent, [9999])).status).toBe(404);
  });

  it('needs an unlocked Admin session', async () => {
    const { app } = await setup();
    expect((await request(app).post('/api/admin/people/delete').set(H).send({ ids: [1] })).status).toBe(401);
  });
});
