// The Admin routes for the serving certificate (#577, T4): read it, change its two settings, renew it now.
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../fleet/db.js';
import { PeopleStore } from '../fleet/people.js';
import { createLogger } from '../logging/logger.js';
import { ensureTls, serverNames } from '../tlsCa.js';
import { PersonCertStore } from '../tlsClientAuth.js';
import { ServingRenewer, TlsSettingsStore } from '../tlsRenew.js';
import { issuePersonCert } from '../tlsPeople.js';
import { caCanOverlap, retireCa, rotateCa, TrustStore } from '../tlsRotation.js';
import { writeLegacyCa } from '../tlsTesting.js';
import type { CaRotation } from '../tlsServer.js';
import { ReporterTransport } from '../tlsHttp.js';
import { createAdminRouter } from './adminRouter.js';

const SECRET = 'the-admin-secret-0123456789';
const H = { 'X-Podium-Admin': '1' };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function setup(tlsOn = true, openssl?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-certroutes-'));
  dirs.push(root);
  const dir = path.join(root, 'tls');
  const names = serverNames('127.0.0.1', []);
  const material = await ensureTls({ dir, names });
  const db = openDb(':memory:');
  const people = new PeopleStore(db);
  const settings = new TlsSettingsStore(db);
  const swaps: unknown[] = [];
  const transport = new ReporterTransport();
  const logger = createLogger({ format: 'json', write: () => {} });
  const renewer = new ServingRenewer({ dir, names, server: { setSecureContext: (o) => swaps.push(o) }, serving: material.serving, settings: () => settings.get(), logger, openssl, caCert: material.caCert }, material.cert);
  const app = express();
  app.use('/api/admin', createAdminRouter({ secret: SECRET, people, log: () => {}, certificates: { settings, transport, renewer: () => (tlsOn ? renewer : null) } }));
  const agent = request.agent(app);
  expect((await agent.post('/api/admin/unlock').set(H).send({ name: 'Admin', token: SECRET })).status).toBe(200);
  return { agent, people, material, swaps, settings, transport };
}

const logKinds = (people: PeopleStore) => people.listLog({ page: 1, pageSize: 100 }).rows.map((r) => r.kind);

describe('GET /api/admin/certificates', () => {
  it('reads the serving certificate, names, settings and previous certificates, never a key', async () => {
    const { agent, material } = await setup();
    const res = await agent.get('/api/admin/certificates').set(H);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, serving: { serial: material.serving.serial }, settings: { lifetimeDays: 365, renewBeforeDays: 30, headerCountdown: true }, previous: [], lastFailure: null, lastRenewed: null });
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE KEY');
  });

  it('also returns the CA, with its dates and fingerprint and never a key (T8)', async () => {
    const { agent, material } = await setup();
    const res = await agent.get('/api/admin/certificates').set(H);
    expect(res.body.ca).toEqual(material.ca);
    expect(Object.keys(res.body.ca).sort()).toEqual(['fingerprintSha256', 'notAfter', 'notBefore', 'serial', 'subject']);
  });

  it('also returns a person\'s certificate lifetime and grace, so the page can show them (T8)', async () => {
    const { agent } = await setup();
    expect((await agent.get('/api/admin/certificates').set(H)).body.reporter).toEqual({ lifetimeDays: 90, graceDays: 30 });
    const put = await agent.put('/api/admin/certificates').set(H).send({ 'tls.reporter.graceDays': 10 });
    expect(put.body.reporter).toEqual({ lifetimeDays: 90, graceDays: 10 });
    expect((await agent.get('/api/admin/certificates').set(H)).body.reporter).toEqual({ lifetimeDays: 90, graceDays: 10 });
  });

  it('answers 404 when TLS is off, on all the routes', async () => {
    const { agent } = await setup(false);
    expect((await agent.get('/api/admin/certificates').set(H)).status).toBe(404);
    expect((await agent.put('/api/admin/certificates').set(H).send({ 'tls.serving.lifetimeDays': 90 })).status).toBe(404);
    expect((await agent.post('/api/admin/certificates/renew').set(H)).status).toBe(404);
    expect((await agent.get('/api/admin/certificates/ca.pem').set(H)).status).toBe(404);
  });

  it('needs an unlocked session', async () => {
    const { agent } = await setup();
    await agent.post('/api/admin/lock').set(H);
    expect((await agent.get('/api/admin/certificates').set(H)).status).toBe(401);
    expect((await agent.get('/api/admin/certificates/ca.pem').set(H)).status).toBe(401);
  });
});

describe('GET /api/admin/certificates/ca.pem', () => {
  it('sends the CA certificate as a download, and no key', async () => {
    const { agent, material } = await setup();
    const res = await agent.get('/api/admin/certificates/ca.pem').set(H);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="podium-ca.pem"');
    expect(res.text).toBe(material.caCert);
    expect(res.text).toContain('BEGIN CERTIFICATE');
    expect(res.text).not.toContain('PRIVATE KEY');
  });

  it('answers 404 when the renewer has no CA certificate', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-certroutes-'));
    dirs.push(root);
    const names = serverNames('127.0.0.1', []);
    const material = await ensureTls({ dir: path.join(root, 'tls'), names });
    const db = openDb(':memory:');
    const settings = new TlsSettingsStore(db);
    const renewer = new ServingRenewer({ dir: path.join(root, 'tls'), names, server: { setSecureContext: () => {} }, serving: material.serving, settings: () => settings.get(), logger: createLogger({ format: 'json', write: () => {} }) }, material.cert);
    const app = express();
    app.use('/api/admin', createAdminRouter({ secret: SECRET, people: new PeopleStore(db), log: () => {}, certificates: { settings, renewer: () => renewer } }));
    const agent = request.agent(app);
    await agent.post('/api/admin/unlock').set(H).send({ name: 'Admin', token: SECRET });
    expect((await agent.get('/api/admin/certificates/ca.pem').set(H)).status).toBe(404);
    expect((await agent.get('/api/admin/certificates').set(H)).body.ca).toBeNull();
  });
});

describe('PUT /api/admin/certificates', () => {
  it('saves the settings and writes an Admin log entry', async () => {
    const { agent, people, settings } = await setup();
    const res = await agent.put('/api/admin/certificates').set(H).send({ 'tls.serving.lifetimeDays': 30, 'tls.serving.renewBeforeDays': 90 });
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({ lifetimeDays: 30, renewBeforeDays: 90, headerCountdown: true });
    expect(settings.get()).toEqual({ lifetimeDays: 30, renewBeforeDays: 90, headerCountdown: true });
    expect(logKinds(people)).toContain('tls_settings_changed');
  });

  it('saves the reporter lifetime and grace, and the log line names them (#585)', async () => {
    const { agent, people, settings } = await setup();
    const res = await agent.put('/api/admin/certificates').set(H).send({ 'tls.reporter.lifetimeDays': 60, 'tls.reporter.graceDays': 10 });
    expect(res.status).toBe(200);
    expect(settings.getReporter()).toEqual({ lifetimeDays: 60, graceDays: 10 });
    expect(people.listLog({ page: 1, pageSize: 20 }).rows.find((r) => r.kind === 'tls_settings_changed')?.detail).toMatch(/lifetime 60 days, grace 10 days/);
    expect((await agent.put('/api/admin/certificates').set(H).send({ 'tls.reporter.graceDays': 120 })).status).toBe(400);
  });

  it('refuses a number outside its range with a message that names the range, and logs nothing', async () => {
    const { agent, people, settings } = await setup();
    const res = await agent.put('/api/admin/certificates').set(H).send({ 'tls.serving.renewBeforeDays': 120 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('from 7 to 90');
    expect(settings.get().renewBeforeDays).toBe(30);
    expect(logKinds(people)).not.toContain('tls_settings_changed');
  });

  it('saves tls.header.countdown, returns it in settings, and names it in the log (T8)', async () => {
    const { agent, people, settings } = await setup();
    expect((await agent.get('/api/admin/certificates').set(H)).body.settings.headerCountdown).toBe(true);
    const res = await agent.put('/api/admin/certificates').set(H).send({ 'tls.header.countdown': false });
    expect(res.status).toBe(200);
    expect(res.body.settings.headerCountdown).toBe(false);
    expect(settings.get().headerCountdown).toBe(false);
    const row = people.listLog({ page: 1, pageSize: 20 }).rows.find((r) => r.kind === 'tls_settings_changed');
    expect(row?.detail).toMatch(/header countdown off/);
    expect((await agent.put('/api/admin/certificates').set(H).send({ 'tls.header.countdown': true })).body.settings.headerCountdown).toBe(true);
  });

  it.each([['yes'], [1], [null]])('refuses a non-boolean tls.header.countdown (%j) and keeps the setting', async (v) => {
    const { agent, settings } = await setup();
    const res = await agent.put('/api/admin/certificates').set(H).send({ 'tls.header.countdown': v });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('on or off');
    expect(settings.get().headerCountdown).toBe(true);
  });

  it.each([[null], [[1]], ['text']])('refuses a body that is not an object: %j', async (body) => {
    const { agent } = await setup();
    const res = await agent.put('/api/admin/certificates').set(H).send(JSON.stringify(body)).set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/certificates/renew', () => {
  it('renews now, swaps it in, and logs it', async () => {
    const { agent, people, material, swaps } = await setup();
    const res = await agent.post('/api/admin/certificates/renew').set(H);
    expect(res.status).toBe(200);
    expect(res.body.serving.serial).not.toBe(material.serving.serial);
    expect(res.body.previous).toHaveLength(1);
    expect(swaps).toHaveLength(1);
    expect(logKinds(people)).toContain('tls_serving_renewed');
  });

  it('reports a failed renewal with its reason, logs it, and keeps the failure for the next read', async () => {
    const { agent, people, material } = await setup(true, 'no-such-openssl');
    const res = await agent.post('/api/admin/certificates/renew').set(H);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/not installed or not on PATH/);
    expect(res.body.serving.serial).toBe(material.serving.serial);
    expect((await agent.get('/api/admin/certificates').set(H)).body.lastFailure).toMatchObject({ trigger: 'manual' });
    expect(logKinds(people)).toContain('tls_serving_renew_failed');
  });
});

describe('a failure while answering', () => {
  it('answers 500 instead of hanging when the log write throws', async () => {
    const { agent, people } = await setup();
    people.log = () => {
      throw new Error('log db down');
    };
    const res = await agent.post('/api/admin/certificates/renew').set(H);
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });
});

describe('rotating and retiring the CA (#588)', () => {
  async function rotatable(tlsOn = true, legacy = false) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-carot-'));
    dirs.push(root);
    const dir = path.join(root, 'tls');
    const names = serverNames('127.0.0.1', []);
    if (legacy) writeLegacyCa(dir);
    const material = await ensureTls({ dir, names });
    const db = openDb(':memory:');
    const people = new PeopleStore(db);
    const settings = new TlsSettingsStore(db);
    const store = new PersonCertStore(db);
    const trust = new TrustStore(dir);
    const swaps: unknown[] = [];
    const logger = createLogger({ format: 'json', write: () => {} });
    const renewer = new ServingRenewer({ dir, names, server: { setSecureContext: (o) => swaps.push(o) }, serving: material.serving, settings: () => settings.get(), logger, trust, key: material.key }, material.cert);
    const rotation: CaRotation = {
      canOverlap: () => caCanOverlap(dir),
      rotate: (endOverlap) => renewer.exclusive(async () => {
        const out = await rotateCa({ dir, names, servingDays: 365, endOverlap });
        trust.reload();
        renewer.adopt(out);
        return { ca: out.ca, serving: out.serving, overlap: out.overlap, closed: 0 };
      }),
      retire: () => renewer.exclusive(async () => {
        if (!trust.previousCa()) return null;
        retireCa(dir);
        trust.reload();
        renewer.reapply();
        return { closed: 2 };
      }),
    };
    const app = express();
    app.use('/api/admin', createAdminRouter({ secret: SECRET, people, log: () => {}, certificates: { settings, renewer: () => (tlsOn ? renewer : null), rotation: () => (tlsOn ? rotation : null), people: { store, issuer: () => null } } }));
    const agent = request.agent(app);
    expect((await agent.post('/api/admin/unlock').set(H).send({ name: 'Admin', token: SECRET })).status).toBe(200);
    return { agent, people, store, dir, trust, swaps, material };
  }

  it('answers 404 when TLS is off', async () => {
    const { agent } = await rotatable(false);
    expect((await agent.post('/api/admin/certificates/rotate-ca').set(H).send({ endOverlap: false })).status).toBe(404);
    expect((await agent.post('/api/admin/certificates/retire-ca').set(H)).status).toBe(404);
  });

  it('says whether the CA can take a planned rotation, and what the refusal is for one that cannot', async () => {
    const fresh = await rotatable();
    expect((await fresh.agent.get('/api/admin/certificates').set(H)).body.canOverlap).toBe(true);
    const legacy = await rotatable(true, true);
    expect((await legacy.agent.get('/api/admin/certificates').set(H)).body.canOverlap).toBe(false);
    const planned = await legacy.agent.post('/api/admin/certificates/rotate-ca').set(H).send({ endOverlap: false });
    expect(planned.status).toBe(409);
    expect(planned.body.error).toMatch(/end the overlap/i);
    // The hard cutover still works, and makes a CA that can take a planned rotation next time.
    const hard = await legacy.agent.post('/api/admin/certificates/rotate-ca').set(H).send({ endOverlap: true });
    expect(hard.status).toBe(200);
    expect(hard.body.canOverlap).toBe(true);
  });

  it('wants endOverlap to be said, and refuses anything else', async () => {
    const { agent } = await rotatable();
    for (const body of [{}, { endOverlap: 'yes' }, { endOverlap: 1 }]) {
      expect((await agent.post('/api/admin/certificates/rotate-ca').set(H).send(body)).status).toBe(400);
    }
  });

  it('a planned rotation shows the overlap with the count of reporters still on the old CA, then retiring names them', async () => {
    const { agent, people, store, dir, material, swaps } = await rotatable();
    const dana = people.createPerson('Dana').person;
    const eli = people.createPerson('Eli').person;
    store.replace(dana.id, await issuePersonCert({ dir, keyId: dana.keyId }), Date.now());
    const res = await agent.post('/api/admin/certificates/rotate-ca').set(H).send({ endOverlap: false });
    expect(res.status).toBe(200);
    store.replace(eli.id, await issuePersonCert({ dir, keyId: eli.keyId }), Date.now());
    expect(res.body.ca.fingerprintSha256).not.toBe(material.ca.fingerprintSha256);
    const read = await agent.get('/api/admin/certificates').set(H);
    expect(read.body.rotation.previousCa.fingerprintSha256).toBe(material.ca.fingerprintSha256);
    expect(read.body.rotation.reporters).toEqual({ onOldCa: 1, total: 2 });
    expect(JSON.stringify(read.body)).not.toContain('PRIVATE KEY');
    expect(swaps.length).toBeGreaterThan(0);

    const out = await agent.post('/api/admin/certificates/retire-ca').set(H);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, refused: 1, connectionsClosed: 2 });
    expect((await agent.get('/api/admin/certificates').set(H)).body.rotation).toBeNull();
    const again = await agent.post('/api/admin/certificates/retire-ca').set(H);
    expect(again.status).toBe(409);
  });

  it('refuses a second planned rotation while one is open, in words, and ending the overlap works then', async () => {
    const { agent } = await rotatable();
    expect((await agent.post('/api/admin/certificates/rotate-ca').set(H).send({ endOverlap: false })).status).toBe(200);
    const again = await agent.post('/api/admin/certificates/rotate-ca').set(H).send({ endOverlap: false });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/retire the old CA/);
    const hard = await agent.post('/api/admin/certificates/rotate-ca').set(H).send({ endOverlap: true });
    expect(hard.status).toBe(200);
    expect(hard.body.rotation).toBeNull();
  });

  it('writes every rotate and retire to the Admin log', async () => {
    const { agent, people } = await rotatable();
    await agent.post('/api/admin/certificates/rotate-ca').set(H).send({ endOverlap: false });
    await agent.post('/api/admin/certificates/retire-ca').set(H);
    await agent.post('/api/admin/certificates/rotate-ca').set(H).send({ endOverlap: true });
    expect(logKinds(people)).toEqual(expect.arrayContaining(['tls_ca_rotated', 'tls_ca_retired']));
    expect(logKinds(people).filter((k) => k === 'tls_ca_rotated')).toHaveLength(2);
  });

  it('needs an unlocked session', async () => {
    const { agent } = await rotatable();
    await agent.post('/api/admin/lock').set(H);
    expect((await agent.post('/api/admin/certificates/rotate-ca').set(H).send({ endOverlap: true })).status).toBe(401);
    expect((await agent.post('/api/admin/certificates/retire-ca').set(H)).status).toBe(401);
  });
});

describe('reporters over HTTP (#589)', () => {
  it('reads the switch and how many reporters are on HTTP now', async () => {
    const { agent, transport } = await setup();
    transport.note('a', false, Date.now());
    transport.note('b', false, Date.now());
    transport.note('c', true, Date.now());
    const res = await agent.get('/api/admin/certificates').set(H);
    expect(res.body.http).toEqual({ allow: true, overHttp: 2, total: 3 });
  });

  it('turns it off, writes its own Admin log entry naming the count, and answers with the new state', async () => {
    const { agent, people, settings, transport } = await setup();
    transport.note('a', false, Date.now());
    const res = await agent.put('/api/admin/certificates').set(H).send({ 'tls.allowReportersOverHttp': false });
    expect(res.status).toBe(200);
    expect(res.body.http).toEqual({ allow: false, overHttp: 1, total: 1 });
    expect(settings.allowReportersOverHttp()).toBe(false);
    const row = people.listLog({ page: 1, pageSize: 20 }).rows.find((r) => r.kind === 'tls_http_changed');
    expect(row?.detail).toBe('Stopped allowing reporters over HTTP; 1 reporter connected over HTTP is refused');
    expect(logKinds(people)).not.toContain('tls_settings_changed');
  });

  it('turns it on again, and writes nothing when it did not change', async () => {
    const { agent, people, settings } = await setup();
    settings.set({ 'tls.allowReportersOverHttp': false });
    await agent.put('/api/admin/certificates').set(H).send({ 'tls.allowReportersOverHttp': true });
    expect(people.listLog({ page: 1, pageSize: 20 }).rows.find((r) => r.kind === 'tls_http_changed')?.detail).toBe('Allowed reporters to connect over HTTP');
    await agent.put('/api/admin/certificates').set(H).send({ 'tls.allowReportersOverHttp': true });
    expect(logKinds(people).filter((k) => k === 'tls_http_changed')).toHaveLength(1);
  });

  it('refuses a value that is not on or off, and says "reporters" for a count that is not one', async () => {
    const { agent, people, transport } = await setup();
    expect((await agent.put('/api/admin/certificates').set(H).send({ 'tls.allowReportersOverHttp': 'no' })).status).toBe(400);
    transport.note('a', false, Date.now());
    transport.note('b', false, Date.now());
    await agent.put('/api/admin/certificates').set(H).send({ 'tls.allowReportersOverHttp': false });
    expect(people.listLog({ page: 1, pageSize: 20 }).rows.find((r) => r.kind === 'tls_http_changed')?.detail).toContain('2 reporters connected over HTTP are refused');
  });

  it('writes the settings entry as well when the change carries another setting', async () => {
    const { agent, people } = await setup();
    await agent.put('/api/admin/certificates').set(H).send({ 'tls.allowReportersOverHttp': false, 'tls.header.countdown': false });
    expect(logKinds(people)).toEqual(expect.arrayContaining(['tls_http_changed', 'tls_settings_changed']));
  });
});
