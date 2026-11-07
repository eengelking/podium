// Admin > About (#862): what the server and its reporters are running, read from what the server already holds.
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openSqliteStorage } from '../storage/sqlite/index.js';
import { LiveFeatureFlags, LiveModelPrices, LiveWallSettings } from '../fleet/liveSettings.js';
import { createAdminRouter } from './adminRouter.js';
import { buildAbout, runtimeOf } from './about.js';
import type { ReporterSeen } from '../storage/rows.js';

const SECRET = 'the-admin-secret-0123456789';
const H = { 'X-Podium-Admin': '1' };
const NOW = 5_000_000_000_000;

const seen = (id: string, over: Partial<ReporterSeen> = {}): ReporterSeen => ({
  kind: 'mod', machineId: id, machineName: id, source: '10.0.0.1', owner: 'ed', credential: 'person', version: '1.6.0', engineVersion: null, sessionId: `s-${id}`, os: 'macOS', peers: true, ...over,
});

async function setup(secret: string | null = SECRET) {
  const storage = openSqliteStorage(':memory:', 0);
  const wall = new LiveWallSettings(storage.wallSettings);
  const prices = new LiveModelPrices(storage.modelPrices, storage.tx);
  const features = new LiveFeatureFlags(storage.featureFlags);
  await Promise.all([wall.load(), prices.load(), features.load()]);
  const app = express();
  app.use('/api/admin', createAdminRouter({ secret, storage, people: storage.people, wall, prices, features, reporters: storage.reporters, now: () => NOW, log: () => {} }));
  const agent = request.agent(app);
  if (secret !== null) expect((await agent.post('/api/admin/unlock').set(H).send({ name: 'Admin', token: secret })).status).toBe(200);
  return { app, agent, storage };
}

describe('runtimeOf', () => {
  it('says container when PODIUM_RUNTIME says so, or when the container engine left its marker file', () => {
    expect(runtimeOf({ PODIUM_RUNTIME: 'container' }, () => false)).toBe('container');
    expect(runtimeOf({}, (p) => p === '/run/.containerenv')).toBe('container');
    expect(runtimeOf({}, (p) => p === '/.dockerenv')).toBe('container');
  });
  it('says stand-alone otherwise, and for any other PODIUM_RUNTIME value', () => {
    expect(runtimeOf({}, () => false)).toBe('standalone');
    expect(runtimeOf({ PODIUM_RUNTIME: 'standalone' }, () => false)).toBe('standalone');
    expect(runtimeOf({ PODIUM_RUNTIME: 'something else' }, () => false)).toBe('standalone');
  });
});

describe('buildAbout', () => {
  it('reports the server, its libraries, the database and the reporters heard from in the last hour, counted by version', async () => {
    const { storage } = await setup();
    const r = storage.reporters;
    await r.record(seen('a'), NOW - 1_000);
    await r.record(seen('b'), NOW - 2_000);
    await r.record(seen('c', { version: '1.3.2' }), NOW - 3_000);
    await r.record(seen('d', { version: '1.5.0', reporterName: 'podium-reporter-opencode' }), NOW - 4_000);
    await r.record(seen('h', { kind: 'hooks', version: 'hooks', credential: null }), NOW - 5_000);
    await r.record(seen('stale', { version: '0.9.0' }), NOW - 2 * 3_600_000);
    const about = await buildAbout({ fleet: storage.fleet, reporters: storage.reporters, now: NOW, env: { PODIUM_RUNTIME: 'container', PODIUM_BUILD: 'abcdef1' }, uptimeMs: 90_000 });
    expect(about.server).toMatchObject({ build: 'abcdef1', runtime: 'container', startedAt: NOW - 90_000 });
    expect(about.server.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(about.server.system).toMatch(/^\S+ \S+$/);
    expect(about.stack.node).toBe(process.versions.node);
    expect(about.stack.express).toMatch(/^\d+\.\d+\.\d+/);
    expect(about.database).toMatchObject({ engine: 'SQLite', schemaVersion: expect.any(Number) });
    expect(about.database.version).toMatch(/^\d+\.\d+/);
    expect(about.reporters.map((x) => [x.reporterName, x.version, x.machines])).toEqual([
      ['podium-reporter-claudecode', '1.6.0', 2],
      ['podium-reporter-claudecode', '1.3.2', 1],
      ['podium-reporter-opencode', '1.5.0', 1],
    ]);
  });

  it('puts the newest version first within a reporter, comparing the numbers and not the text, and merges the legacy name into the Claude Code reporter', async () => {
    const { storage } = await setup();
    const r = storage.reporters;
    await r.record(seen('a', { version: '1.9.0', reporterName: 'podium-reporter' }), NOW);
    await r.record(seen('b', { version: '1.10.0' }), NOW);
    await r.record(seen('c', { version: '1.9.0' }), NOW);
    const about = await buildAbout({ fleet: storage.fleet, reporters: storage.reporters, now: NOW, env: {}, uptimeMs: 0 });
    expect(about.reporters.map((x) => [x.reporterName, x.version, x.machines])).toEqual([
      ['podium-reporter-claudecode', '1.10.0', 1],
      ['podium-reporter-claudecode', '1.9.0', 2],
    ]);
  });

  it('says whether this server reads each version, and the range it reads, and has no build when the build is not a commit', async () => {
    const { storage } = await setup();
    await storage.reporters.record(seen('a', { version: '0.1.0' }), NOW);
    await storage.reporters.record(seen('b', { version: '9.0.0', reporterName: 'podium-reporter-opencode' }), NOW);
    const about = await buildAbout({ fleet: storage.fleet, reporters: storage.reporters, now: NOW, env: { PODIUM_BUILD: 'not-a-commit' }, uptimeMs: 0 });
    expect(about.server.build).toBeNull();
    expect(about.reporters.find((x) => x.version === '0.1.0')).toMatchObject({ compat: 'outdated', support: { min: '0.2.0', max: expect.any(String) } });
    expect(about.reporters.find((x) => x.version === '9.0.0')).toMatchObject({ compat: 'newer' });
  });

  it('has an empty reporter list when none has been heard from', async () => {
    const { storage } = await setup();
    expect((await buildAbout({ fleet: storage.fleet, reporters: storage.reporters, now: NOW, env: {}, uptimeMs: 0 })).reporters).toEqual([]);
  });
});

describe('GET /api/admin/about', () => {
  it('is refused while Admin is locked and when Admin is off', async () => {
    const { app } = await setup();
    expect((await request(app).get('/api/admin/about').set(H)).status).toBe(401);
    const off = await setup(null);
    expect((await request(off.app).get('/api/admin/about').set(H)).status).toBe(403);
  });

  it('answers an unlocked Admin with the server, the stack, the database and the reporters, and never a token or an address', async () => {
    const { agent, storage } = await setup();
    await storage.reporters.record(seen('a', { version: '1.5.0', credential: 'pdm_secretkeyid', source: '203.0.113.9' }), NOW - 1_000);
    const res = await agent.get('/api/admin/about').set(H);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      server: { runtime: expect.stringMatching(/^(container|standalone)$/) },
      stack: { node: process.versions.node },
      database: { engine: 'SQLite' },
      reporters: [{ reporterName: 'podium-reporter-claudecode', version: '1.5.0', machines: 1, compat: 'ok' }],
      serverTime: NOW,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/pdm_secretkeyid|203\.0\.113\.9/);
  });
});
