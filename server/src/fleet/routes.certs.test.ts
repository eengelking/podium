// A person's certificate end to end (#583): the Admin issues it with the person, the reporter reports with it over real mutual
// TLS and no token, and each of Revoke certificate, Revoke token and Revoke all stops only what it should.
import express from 'express';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdminRouter } from '../admin/adminRouter.js';
import { createLogger } from '../logging/logger.js';
import { LiveTlsSettings } from '../tlsLive.js';
import { publicTlsPort, type TlsListener } from '../tlsServer.js';
import { startTlsForTest } from '../tlsTesting.js';
import { openSqliteStorage } from '../storage/sqlite/index.js';
import { DEFAULT_CONFIG, Fleet } from './fleet.js';
import { createFleetRouter } from './routes.js';
import { fixtureReport } from './testing.js';
import { ADMINISTRATORS_GROUP } from '../storage/rows.js';

const SECRET = 'the-admin-secret-0123456789';
const H = { 'X-Podium-Admin': '1' };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

async function setup(opts: { tlsOn?: boolean; openssl?: string; publicPort?: string } = {}) {
  const tlsOn = opts.tlsOn ?? true;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-certe2e-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const storage = openSqliteStorage(':memory:');
  const db = storage.sqliteHandle;
  const fleet = new Fleet(storage, { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' });
  await fleet.init();
  cleanup.push(() => fleet.close());
  const people = storage.people;
  const store = storage.personCerts;
  const tlsSettings = new LiveTlsSettings(storage.tlsSettings, storage.tx);
  await tlsSettings.load();
  const logger = createLogger({ format: 'json', write: () => {} });
  let listener: TlsListener | null = null;
  let openssl = opts.openssl;
  const app = express();
  app.use('/api/fleet', createFleetRouter(fleet, { token: SECRET, people, logger, certs: { store, trustedIssuers: () => (listener ? [listener.material.ca.fingerprintSha256] : []) } }));
  app.use(
    '/api/admin',
    createAdminRouter({
      secret: SECRET,
      storage,
      people,
      logger,
      certificates: {
        settings: tlsSettings,
        renewer: () => listener?.renewer ?? null,
        people: { store, issuer: () => (tlsOn && listener ? { dir: path.join(root, 'tls'), port: publicTlsPort(opts.publicPort, listener.port), caCerts: () => [listener!.material.caCert], openssl } : null) },
      },
    }),
  );
  listener = await startTlsForTest({ app, dataDir: root, logger });
  const port = listener.port;
  cleanup.push(() => new Promise<void>((r) => { listener!.server.closeAllConnections(); listener!.server.close(() => r()); }));
  const admin = request.agent(app);
  expect((await admin.post('/api/admin/unlock').set(H).send({ name: 'Admin', token: SECRET })).status).toBe(200);

  /** Sends a report over mutual TLS with the certificate and key from a config file, and no token. */
  const reportWith = (pemParts: { cert: string; key: string }, userName: string, extraHeaders: Record<string, string> = {}) =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const r = fixtureReport() as unknown as Record<string, unknown> & { session: { id: string } };
      r.session = { ...r.session, id: `sess-${Math.random().toString(36).slice(2)}` };
      r.userName = userName;
      const data = JSON.stringify(r);
      const req = https.request(
        { host: '127.0.0.1', port, ca: listener!.material.caCert, servername: 'localhost', method: 'POST', path: '/api/fleet/report', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...extraHeaders }, ...pemParts },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) as Record<string, unknown> }));
        },
      );
      req.on('error', reject);
      req.end(data);
    });
  return { root, db, fleet, people, store, admin, port, listener, reportWith, app, setOpenssl: (b: string | undefined) => (openssl = b) };
}

/** The certificate and key blocks of a config file, found by type and role and not by position (SPEC 5.9). */
function partsOf(content: string): { cert: string; key: string; cas: string[] } {
  const blocks = content.match(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g) ?? [];
  const key = blocks.find((b) => b.includes('PRIVATE KEY'))!;
  const certs = blocks.filter((b) => b.includes('CERTIFICATE'));
  return { key: `${key}\n`, cert: `${certs[certs.length - 1]}\n`, cas: certs.slice(0, -1).map((c) => `${c}\n`) };
}

const create = async (s: Awaited<ReturnType<typeof setup>>, name: string, groupId?: number) => {
  const res = await s.admin.post('/api/admin/people').set(H).send({ name, groupId });
  expect(res.status).toBe(201);
  return res.body as { person: { id: number }; token: string; config?: { filename: string; content: string; expires: string; fingerprint: string }; configError?: string };
};

const logRows = async (s: Awaited<ReturnType<typeof setup>>) => (await s.people.listLog({ page: 1, pageSize: 100 })).rows;

describe('creating a person with TLS on', () => {
  it('writes the public port, not the listening one, when the port is mapped (#649)', async () => {
    const s = await setup({ publicPort: '5318' });
    const body = await create(s, 'Dana Lee');
    expect(body.config!.content.split('\n')[2]).toBe('# server: https://127.0.0.1:5318');
    expect(s.port).not.toBe(5318);
  });

  it('returns the config file once, in the format SPEC 5.9 gives, and keeps the certificate but never the key', async () => {
    const s = await setup();
    const body = await create(s, 'Dana Lee');
    expect(body.token).toMatch(/^pdm_/);
    const f = body.config!;
    expect(f.filename).toMatch(/^reporter-config-Dana-Lee-\d{10}\.pem$/);
    const lines = f.content.split('\n');
    expect(lines.slice(0, 6).map((l) => l.split(':')[0])).toEqual(['# podium-reporter-config v1', '# user', '# server', '# issued-at', '# expires', '# fingerprint']);
    expect(lines[1]).toBe('# user: Dana Lee');
    expect(lines[2]).toBe(`# server: https://127.0.0.1:${s.port}`);
    const parts = partsOf(f.content);
    expect(parts.cas).toEqual([s.listener.material.caCert]);
    expect(f.fingerprint).toBe((await s.store.current(body.person.id))!.fingerprint);

    // The database holds the certificate, and nothing of the key.
    const keyBody = parts.key.split('\n')[1]!;
    expect(JSON.stringify(s.db.prepare('SELECT * FROM person_certificates').all())).not.toContain(keyBody);
    // Nothing in the Admin log carries the file.
    expect(JSON.stringify((await logRows(s)))).not.toContain('PRIVATE KEY');
    expect((await logRows(s)).map((r) => r.kind)).toEqual(expect.arrayContaining(['person_created', 'certificate_issued']));
    // And no route gives the key back: the public download has the certificate and the CA only.
    const pem = await s.admin.get(`/api/admin/people/${body.person.id}/certificate.pem`).set(H);
    expect(pem.status).toBe(200);
    expect(pem.headers['content-disposition']).toBe('attachment; filename="Dana-Lee-certificate.pem"');
    expect(pem.text).not.toContain('PRIVATE KEY');
    expect(pem.text.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(pem.text.startsWith(parts.cert)).toBe(true);
  });

  it('puts no config in the response when TLS is off, and answers 404 on the certificate routes', async () => {
    const s = await setup({ tlsOn: false });
    const body = await create(s, 'Dana');
    expect(body.config).toBeUndefined();
    expect(body.configError).toBeUndefined();
    for (const [method, p] of [['post', 'certificate/reissue'], ['post', 'certificate/revoke'], ['post', 'revoke-all'], ['get', 'certificate.pem']] as const) {
      expect((await s.admin[method](`/api/admin/people/${body.person.id}/${p}`).set(H)).status).toBe(404);
    }
  });

  it('still returns the token when the certificate cannot be made, and says so', async () => {
    const s = await setup({ openssl: 'openssl-that-is-not-installed' });
    const body = await create(s, 'Dana');
    expect(body.token).toMatch(/^pdm_/);
    expect(body.config).toBeUndefined();
    expect(body.configError).toMatch(/could not make the certificate/);
    expect(await s.people.findByName('Dana')).toBeDefined();
  });
});

describe('the People list (#587)', () => {
  const list = async (s: Awaited<ReturnType<typeof setup>>) => (await s.admin.get('/api/admin/people').set(H)).body as { tls: boolean; rows: { name: string; certificate: { notBefore: string; notAfter: string; revoked: boolean } | null }[] };

  it('says each person\'s certificate: its expiry while live, revoked after, and none for a person without one', async () => {
    const s = await setup();
    const a = await create(s, 'Alma');
    const b = await create(s, 'Bo');
    await s.admin.post(`/api/admin/people/${b.person.id}/certificate/revoke`).set(H);
    await s.people.createPerson('Cy', null, Date.now());
    const out = await list(s);
    expect(out.tls).toBe(true);
    expect(out).not.toHaveProperty('graceDays');
    const by = Object.fromEntries(out.rows.map((r) => [r.name, r.certificate]));
    expect(by.Alma).toEqual({ notBefore: new Date((await s.store.current(a.person.id))!.notBefore).toISOString(), notAfter: new Date((await s.store.current(a.person.id))!.notAfter).toISOString(), revoked: false });
    expect(by.Bo).toMatchObject({ revoked: true });
    expect(by.Cy).toBeNull();
    expect(JSON.stringify(out)).not.toContain('PRIVATE KEY');
  });

  it('says TLS is off and gives every person no certificate', async () => {
    const s = await setup({ tlsOn: false });
    await create(s, 'Dana');
    const out = await list(s);
    expect(out.tls).toBe(false);
    expect(out.rows.every((r) => r.certificate === null)).toBe(true);
  });
});

describe('a reporter with the config file', () => {
  it('reports over mutual TLS with no token and is attributed to its person', async () => {
    const s = await setup();
    const body = await create(s, 'Dana');
    const res = await s.reportWith(partsOf(body.config!.content), 'Dana');
    expect(res.status).toBe(200);
    const state = (await request(s.app).get('/api/fleet/state')).body as { sessions: { owner: string }[] };
    expect(state.sessions.map((x) => x.owner)).toEqual(['Dana']);
  });

  it('must still send its own name: the report of another name is refused', async () => {
    const s = await setup();
    const body = await create(s, 'Dana');
    await create(s, 'Eli');
    expect((await s.reportWith(partsOf(body.config!.content), 'Eli')).status).toBe(401);
    expect((await request(s.app).get('/api/fleet/state')).body.sessions).toHaveLength(0);
  });

  it('is dropped at the handshake, even with a valid token in the header, when the certificate is forged', async () => {
    const s = await setup();
    const body = await create(s, 'Dana');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-forge-'));
    cleanup.push(() => fs.rmSync(work, { recursive: true, force: true }));
    const keyId = (await s.people.getPerson(body.person.id))!.keyId;
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'k.pem', '-out', 'c.pem', '-days', '30', '-subj', `/CN=pdm_${keyId}/O=podium`], { cwd: work, stdio: 'ignore' });
    const forged = { cert: fs.readFileSync(path.join(work, 'c.pem'), 'utf8'), key: fs.readFileSync(path.join(work, 'k.pem'), 'utf8') };
    // The reporter port drops it at the handshake (#665), so the token never gets a say.
    await expect(s.reportWith(forged, 'Dana', { 'x-podium-token': body.token })).rejects.toBeDefined();
  });
});

describe('revoking', () => {
  it('Revoke certificate stops the reporter on its next request and leaves the token and the console sign-in', async () => {
    const s = await setup();
    const admins = (await s.people.administratorsGroupId())!;
    const body = await create(s, 'Dana', admins);
    const parts = partsOf(body.config!.content);
    expect((await s.reportWith(parts, 'Dana')).status).toBe(200);
    const res = await s.admin.post(`/api/admin/people/${body.person.id}/certificate/revoke`).set(H);
    expect(res.body).toEqual({ ok: true, revoked: 1 });
    expect((await s.reportWith(parts, 'Dana')).status).toBe(401);
    // The token and the console are untouched: she can still sign in to Admin as an Administrator, even as the only one.
    const other = request.agent(s.app);
    expect((await other.post('/api/admin/unlock').set(H).send({ name: 'Dana', token: body.token })).status).toBe(200);
    expect((await request(s.app).post('/api/fleet/report').set('X-Podium-Token', body.token).send({ ...(fixtureReport() as object), userName: 'Dana' })).status).toBe(200);
    expect((await logRows(s)).map((r) => r.kind)).toContain('certificate_revoked');
    // Revoking again changes nothing and logs nothing more.
    expect((await s.admin.post(`/api/admin/people/${body.person.id}/certificate/revoke`).set(H)).body).toEqual({ ok: true, revoked: 0 });
    expect((await logRows(s)).filter((r) => r.kind === 'certificate_revoked')).toHaveLength(1);
  });

  it('Revoke token stops the token and the certificate too', async () => {
    const s = await setup();
    const body = await create(s, 'Dana');
    const parts = partsOf(body.config!.content);
    expect((await s.reportWith(parts, 'Dana')).status).toBe(200);
    expect((await s.admin.post(`/api/admin/people/${body.person.id}/revoke`).set(H)).status).toBe(200);
    expect((await request(s.app).post('/api/fleet/report').set('X-Podium-Token', body.token).send({ ...(fixtureReport() as object), userName: 'Dana' })).status).toBe(401);
    expect((await s.reportWith(parts, 'Dana')).status).toBe(401);
    expect((await s.store.current(body.person.id))).toBeUndefined();
    expect((await logRows(s)).find((r) => r.kind === 'token_revoked')!.detail).toContain('and their certificate');
  });

  it('Revoke all stops both', async () => {
    const s = await setup();
    const body = await create(s, 'Dana');
    const parts = partsOf(body.config!.content);
    const res = await s.admin.post(`/api/admin/people/${body.person.id}/revoke-all`).set(H);
    expect(res.body).toEqual({ ok: true, revoked: 1, tokenRevoked: true });
    expect((await s.reportWith(parts, 'Dana')).status).toBe(401);
    expect((await request(s.app).post('/api/fleet/report').set('X-Podium-Token', body.token).send({ ...(fixtureReport() as object), userName: 'Dana' })).status).toBe(401);
    expect((await logRows(s)).map((r) => r.kind)).toContain('revoked_all');
  });

  it('will not revoke the token of the last Administrator, by itself or with Revoke all, and changes nothing', async () => {
    const s = await setup();
    const admins = (await s.people.administratorsGroupId())!;
    const body = await create(s, 'Dana', admins);
    const parts = partsOf(body.config!.content);
    for (const p of ['revoke', 'revoke-all']) {
      const res = await s.admin.post(`/api/admin/people/${body.person.id}/${p}`).set(H);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(`last person in ${ADMINISTRATORS_GROUP}`);
    }
    expect((await s.people.getPerson(body.person.id))!.revokedAt).toBeNull();
    expect((await s.reportWith(parts, 'Dana')).status).toBe(200);
    // With a second Administrator it is allowed.
    await create(s, 'Eli', admins);
    expect((await s.admin.post(`/api/admin/people/${body.person.id}/revoke-all`).set(H)).status).toBe(200);
  });

  it('answers 404 for a person who does not exist and 400 for a bad id', async () => {
    const s = await setup();
    expect((await s.admin.post('/api/admin/people/999/certificate/revoke').set(H)).status).toBe(404);
    expect((await s.admin.post('/api/admin/people/abc/certificate/revoke').set(H)).status).toBe(400);
    expect((await s.admin.get('/api/admin/people/999/certificate.pem').set(H)).status).toBe(404);
  });

  it('answers 404 for the download of a person with no live certificate', async () => {
    const s = await setup();
    const body = await create(s, 'Dana');
    await s.admin.post(`/api/admin/people/${body.person.id}/certificate/revoke`).set(H);
    expect((await s.admin.get(`/api/admin/people/${body.person.id}/certificate.pem`).set(H)).status).toBe(404);
  });
});

describe('reissue', () => {
  it('returns a new config, revokes the earlier certificate and keeps the same token', async () => {
    const s = await setup();
    const body = await create(s, 'Dana');
    const oldParts = partsOf(body.config!.content);
    const res = await s.admin.post(`/api/admin/people/${body.person.id}/certificate/reissue`).set(H);
    expect(res.status).toBe(200);
    const next = partsOf(res.body.config.content);
    expect(next.cert).not.toBe(oldParts.cert);
    expect((await s.reportWith(oldParts, 'Dana')).status).toBe(401);
    expect((await s.reportWith(next, 'Dana')).status).toBe(200);
    expect((await s.store.listFor(body.person.id)).map((c) => c.reason)).toEqual([null, 'reissued']);
    expect((await s.people.getPerson(body.person.id))!.revokedAt).toBeNull();
  });

  it('brings a revoked person back, and the new certificate works', async () => {
    const s = await setup();
    const body = await create(s, 'Dana');
    await s.people.revoke(body.person.id, Date.now());
    const res = await s.admin.post(`/api/admin/people/${body.person.id}/certificate/reissue`).set(H);
    expect(res.status).toBe(200);
    expect((await s.people.getPerson(body.person.id))!.revokedAt).toBeNull();
    expect((await s.reportWith(partsOf(res.body.config.content), 'Dana')).status).toBe(200);
  });

  it('leaves the earlier certificate valid when the new one cannot be made', async () => {
    const s = await setup();
    const body = await create(s, 'Dana');
    const parts = partsOf(body.config!.content);
    s.setOpenssl('openssl-that-is-not-installed');
    const res = await s.admin.post(`/api/admin/people/${body.person.id}/certificate/reissue`).set(H);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/earlier one is still valid/);
    expect((await s.store.listFor(body.person.id))).toHaveLength(1);
    expect((await s.reportWith(parts, 'Dana')).status).toBe(200);
  });
});
