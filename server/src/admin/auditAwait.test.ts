// The Admin log write is awaited on the unlock and the certificate-issue paths (#313): a failed write answers 500
// through the handler instead of becoming an unhandled rejection, and the row is there when the response arrives.
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../storage/sqlite/index.js';
import { ensureTls, serverNames } from '../tlsCa.js';
import { LiveTlsSettings } from '../tlsLive.js';
import { createAdminRouter } from './adminRouter.js';

const SECRET = 'the-admin-secret-0123456789';
const H = { 'X-Podium-Admin': '1' };
const dirs: string[] = [];
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);

beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Lets a rejection nobody handled surface to the process-level listener. */
const settle = () => new Promise((r) => setTimeout(r, 50));

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-auditawait-'));
  dirs.push(root);
  const dir = path.join(root, 'tls');
  const material = await ensureTls({ dir, names: serverNames('127.0.0.1', []) });
  const storage = openSqliteStorage(':memory:');
  const people = storage.people;
  const store = storage.personCerts;
  const tls = new LiveTlsSettings(storage.tlsSettings, storage.tx);
  await tls.load();
  const certificates = { settings: tls, renewer: () => null, people: { store, issuer: () => ({ dir, port: 8443, caCerts: () => [material.caCert] }) } };
  const app = express();
  app.use('/api/admin', createAdminRouter({ secret: SECRET, storage, people, log: () => {}, certificates }));
  const agent = request.agent(app);
  const failLog = () => {
    people.log = () => Promise.reject(new Error('log db down'));
  };
  const kinds = async () => (await people.listLog({ page: 1, pageSize: 100 })).rows.map((r) => r.kind);
  return { agent, people, failLog, kinds };
}

const unlock = (agent: ReturnType<typeof request.agent>) => agent.post('/api/admin/unlock').set(H).send({ name: 'Admin', token: SECRET });

describe('unlock', () => {
  it('fails the request and leaves no unhandled rejection when the log write rejects', async () => {
    const { agent, failLog } = await setup();
    failLog();
    const res = await unlock(agent);
    await settle();
    expect(unhandled).toEqual([]);
    // The router's error handler answers any failure that reaches it with 400, so the point is that the request fails.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.ok).toBe(false);
  });

  it('has the unlock row in the log by the time the response arrives', async () => {
    const { agent, kinds } = await setup();
    expect((await unlock(agent)).status).toBe(200);
    expect(await kinds()).toContain('unlock');
  });
});

describe('issuing a certificate', () => {
  it('answers 500 and leaves no unhandled rejection when the log write rejects', async () => {
    const { agent, people, failLog } = await setup();
    expect((await unlock(agent)).status).toBe(200);
    const dana = (await people.createPerson('Dana')).person;
    failLog();
    const res = await agent.post(`/api/admin/people/${dana.id}/certificate/reissue`).set(H);
    await settle();
    expect(unhandled).toEqual([]);
    expect(res.status).toBe(500);
  });

  it('has the certificate_issued row in the log by the time the response arrives', async () => {
    const { agent, people, kinds } = await setup();
    expect((await unlock(agent)).status).toBe(200);
    const dana = (await people.createPerson('Dana')).person;
    const res = await agent.post(`/api/admin/people/${dana.id}/certificate/reissue`).set(H);
    expect(res.status).toBe(200);
    expect(await kinds()).toContain('certificate_issued');
  });
});
