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
import { ServingRenewer, TlsSettingsStore } from '../tlsRenew.js';
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
  const logger = createLogger({ format: 'json', write: () => {} });
  const renewer = new ServingRenewer({ dir, names, server: { setSecureContext: (o) => swaps.push(o) }, serving: material.serving, settings: () => settings.get(), logger, openssl, caCert: material.caCert }, material.cert);
  const app = express();
  app.use('/api/admin', createAdminRouter({ secret: SECRET, people, log: () => {}, certificates: { settings, renewer: () => (tlsOn ? renewer : null) } }));
  const agent = request.agent(app);
  expect((await agent.post('/api/admin/unlock').set(H).send({ name: 'Admin', token: SECRET })).status).toBe(200);
  return { agent, people, material, swaps, settings };
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
