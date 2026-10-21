import express from 'express';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from './fleet/db.js';
import { createLogger } from './logging/logger.js';
import { ensureTls, serverNames } from './tlsCa.js';
import { namesOf, ServingRenewer, SERVING_DEFAULTS, servingFieldError, TlsSettingsStore, type ServingSettings } from './tlsRenew.js';
import { startTls } from './tlsServer.js';

const DAY = 86_400_000;
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
const scratch = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-tlsrenew-'));
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const names = serverNames('127.0.0.1', ['podium.lan']);

describe('TlsSettingsStore', () => {
  it('reads the defaults, saves a change and reads it back', () => {
    const s = new TlsSettingsStore(openDb(':memory:'));
    expect(s.get()).toEqual({ lifetimeDays: 365, renewBeforeDays: 30 });
    expect(SERVING_DEFAULTS).toEqual(s.get());
    const out = s.set({ 'tls.serving.lifetimeDays': 30, 'tls.serving.renewBeforeDays': 90 });
    expect(out).toEqual({ ok: true, settings: { lifetimeDays: 30, renewBeforeDays: 90 }, changed: ['tls.serving.lifetimeDays', 'tls.serving.renewBeforeDays'] });
    expect(s.get()).toEqual({ lifetimeDays: 30, renewBeforeDays: 90 });
  });

  it.each([
    ['tls.serving.lifetimeDays', 29, 'from 30 to 825'],
    ['tls.serving.lifetimeDays', 826, 'from 30 to 825'],
    ['tls.serving.renewBeforeDays', 6, 'from 7 to 90'],
    ['tls.serving.renewBeforeDays', 91, 'from 7 to 90'],
    ['tls.serving.renewBeforeDays', 7.5, 'from 7 to 90'],
    ['tls.serving.renewBeforeDays', '30', 'from 7 to 90'],
  ])('refuses %s = %j with a message that names the range', (key, value, range) => {
    const s = new TlsSettingsStore(openDb(':memory:'));
    const out = s.set({ [key]: value });
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining(range) });
    expect(s.get()).toEqual(SERVING_DEFAULTS);
  });

  it('accepts both ends of each range', () => {
    const s = new TlsSettingsStore(openDb(':memory:'));
    for (const [k, v] of [['tls.serving.lifetimeDays', 30], ['tls.serving.lifetimeDays', 825], ['tls.serving.renewBeforeDays', 7], ['tls.serving.renewBeforeDays', 90]] as const) {
      expect(servingFieldError(k, v)).toBeNull();
      expect(s.set({ [k]: v }).ok).toBe(true);
    }
  });

  it('saves nothing when one value in the patch is bad, and refuses an empty or unknown patch', () => {
    const s = new TlsSettingsStore(openDb(':memory:'));
    expect(s.set({ 'tls.serving.lifetimeDays': 100, 'tls.serving.renewBeforeDays': 1 }).ok).toBe(false);
    expect(s.get()).toEqual(SERVING_DEFAULTS);
    expect(s.set({})).toEqual({ ok: false, error: 'nothing to change' });
    expect(s.set({ 'tls.nope': 1 })).toEqual({ ok: false, error: 'unknown setting: tls.nope' });
  });

  it('reads an invalid stored row as its default', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('tls.serving.lifetimeDays', '5');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('tls.serving.renewBeforeDays', 'abc');
    expect(new TlsSettingsStore(db).get()).toEqual(SERVING_DEFAULTS);
  });

  it('reads and saves the settings for a person’s certificate, checking their ranges (#585)', () => {
    const s = new TlsSettingsStore(openDb(':memory:'));
    expect(s.getReporter()).toEqual({ lifetimeDays: 90, graceDays: 30 });
    expect(s.set({ 'tls.reporter.lifetimeDays': 365, 'tls.reporter.graceDays': 0 })).toMatchObject({ ok: true, changed: ['tls.reporter.lifetimeDays', 'tls.reporter.graceDays'] });
    expect(s.getReporter()).toEqual({ lifetimeDays: 365, graceDays: 0 });
    expect(s.set({ 'tls.reporter.graceDays': 90 })).toMatchObject({ ok: true });
    expect(s.set({ 'tls.reporter.graceDays': 91 })).toMatchObject({ ok: false, error: expect.stringContaining('0 to 90') });
    expect(s.set({ 'tls.reporter.lifetimeDays': 29 })).toMatchObject({ ok: false, error: expect.stringContaining('30 to 365') });
    expect(s.getReporter()).toEqual({ lifetimeDays: 365, graceDays: 90 });
  });

  it('reads an invalid stored row for a person’s certificate as its default', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('tls.reporter.lifetimeDays', '5');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('tls.reporter.graceDays', 'x');
    expect(new TlsSettingsStore(db).getReporter()).toEqual({ lifetimeDays: 90, graceDays: 30 });
  });
});

/** An openssl stand-in that fails while the `broken` file exists and is the real one otherwise. */
function flakyOpenssl(dir: string): { bin: string; breakIt: () => void; fixIt: () => void } {
  const broken = path.join(dir, 'broken');
  const bin = path.join(dir, 'openssl-double.sh');
  fs.writeFileSync(bin, `#!/bin/sh\nif [ -e "${broken}" ]; then echo "simulated openssl failure" >&2; exit 1; fi\nexec openssl "$@"\n`, { mode: 0o755 });
  return { bin, breakIt: () => fs.writeFileSync(broken, ''), fixIt: () => fs.rmSync(broken, { force: true }) };
}

async function renewerSetup(opts: { settings?: ServingSettings; clock?: { t: number }; openssl?: string } = {}) {
  const root = scratch();
  const dir = path.join(root, 'tls');
  const material = await ensureTls({ dir, names, servingDays: opts.settings?.lifetimeDays });
  const swaps: Array<{ cert: string; key: string }> = [];
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({ format: 'json', write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) });
  const clock = opts.clock ?? { t: Date.now() };
  const settings = { ...(opts.settings ?? SERVING_DEFAULTS) };
  const renewer = new ServingRenewer(
    { dir, names, server: { setSecureContext: (o) => swaps.push(o) }, serving: material.serving, settings: () => settings, logger, now: () => clock.t, openssl: opts.openssl },
    material.cert,
  );
  return { root, dir, material, swaps, lines, clock, settings, renewer };
}

describe('ServingRenewer.checkDue', () => {
  it('does nothing while more than renewBeforeDays remain', async () => {
    const s = await renewerSetup();
    s.clock.t += 300 * DAY; // 65 days left, window 30
    expect(await s.renewer.checkDue('schedule')).toBe(false);
    expect(s.swaps).toHaveLength(0);
    expect(s.renewer.view().previous).toEqual([]);
  });

  it('renews inside the window and swaps the new certificate in', async () => {
    const s = await renewerSetup();
    s.clock.t += 340 * DAY; // 25 days left
    expect(await s.renewer.checkDue('schedule')).toBe(true);
    expect(s.swaps).toHaveLength(1);
    expect(s.swaps[0].cert).not.toBe(s.material.cert);
    const v = s.renewer.view();
    expect(v.serving.serial).not.toBe(s.material.serving.serial);
    expect(v.previous.map((p) => p.serial)).toEqual([s.material.serving.serial]);
    expect(v.lastRenewed).toMatchObject({ trigger: 'schedule' });
    expect(v.lastFailure).toBeNull();
    expect(s.lines.find((l) => l.event === 'tls.serving_renewed')).toMatchObject({ trigger: 'schedule', replaced_fingerprint_sha256: s.material.serving.fingerprintSha256 });
  });

  it('leaves a certificate made less than a day ago alone even when renewBeforeDays exceeds its lifetime', async () => {
    const s = await renewerSetup({ settings: { lifetimeDays: 30, renewBeforeDays: 90 } });
    expect(await s.renewer.checkDue('start')).toBe(false);
    s.clock.t += 2 * DAY; // old enough now; 28 days left < 90
    expect(await s.renewer.checkDue('schedule')).toBe(true);
  });

  it('renews an expired certificate', async () => {
    const s = await renewerSetup();
    s.clock.t += 400 * DAY;
    expect(await s.renewer.checkDue('start')).toBe(true);
  });
});

describe('ServingRenewer failure and retry', () => {
  it('reports a failure, keeps the current certificate, and the next check retries and clears it', async () => {
    const root = scratch();
    const double = flakyOpenssl(root);
    const s = await renewerSetup({ openssl: double.bin, clock: { t: Date.now() + 340 * DAY } });
    double.breakIt();
    expect(await s.renewer.checkDue('schedule')).toBe(false);
    const failed = s.renewer.view();
    expect(failed.lastFailure).toMatchObject({ trigger: 'schedule', reason: expect.stringContaining('simulated openssl failure') });
    expect(failed.serving).toEqual(s.material.serving);
    expect(s.swaps).toHaveLength(0);
    expect(fs.readFileSync(path.join(s.dir, 'serving.crt'), 'utf8')).toBe(s.material.cert);
    expect(s.lines.find((l) => l.event === 'tls.renew_failed')).toMatchObject({ level: 'error', trigger: 'schedule' });

    s.clock.t += DAY; // the next daily check
    double.fixIt();
    expect(await s.renewer.checkDue('schedule')).toBe(true);
    expect(s.renewer.view().lastFailure).toBeNull();
    expect(s.swaps).toHaveLength(1);
  });

  it('retries on its own timer', async () => {
    const root = scratch();
    const double = flakyOpenssl(root);
    const s = await renewerSetup({ openssl: double.bin, clock: { t: Date.now() + 340 * DAY } });
    const timed = new ServingRenewer(
      { dir: s.dir, names, server: { setSecureContext: (o) => s.swaps.push(o) }, serving: s.material.serving, settings: () => SERVING_DEFAULTS, logger: createLogger({ format: 'json', write: () => {} }), now: () => s.clock.t, openssl: double.bin, checkEveryMs: 20 },
      s.material.cert,
    );
    double.breakIt();
    await timed.start(); // the start check fails
    expect(timed.view().lastFailure).toMatchObject({ trigger: 'start' });
    double.fixIt();
    await expect.poll(() => timed.view().lastFailure, { timeout: 5000 }).toBeNull();
    timed.stop();
    expect(s.swaps.length).toBeGreaterThanOrEqual(1); // the clock stands still, so it stays due and keeps renewing until stopped
  });

  it('renew now reports a failure to the caller', async () => {
    const root = scratch();
    const double = flakyOpenssl(root);
    const s = await renewerSetup({ openssl: double.bin });
    double.breakIt();
    const out = await s.renewer.renewNow();
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('simulated openssl failure') });
    expect(s.renewer.view().lastFailure).toMatchObject({ trigger: 'manual' });
  });

  it('runs one renewal at a time', async () => {
    const s = await renewerSetup();
    const [a, b] = await Promise.all([s.renewer.renewNow(), s.renewer.renewNow()]);
    expect(a).toEqual(b);
    expect(s.swaps).toHaveLength(1);
  });

  it('runs a manual renewal of its own after an automatic one that was already running', async () => {
    const s = await renewerSetup({ clock: { t: Date.now() + 340 * DAY } });
    const [auto, manual] = await Promise.all([s.renewer.checkDue('schedule'), s.renewer.renewNow()]);
    expect(auto).toBe(true);
    expect(manual.ok).toBe(true);
    expect(s.swaps).toHaveLength(2);
    expect(s.renewer.view().lastRenewed).toMatchObject({ trigger: 'manual' });
  });
});

describe('ServingRenewer.renewNow and view', () => {
  it('renews whatever the dates say and reports the names the certificate carries', async () => {
    const s = await renewerSetup();
    const out = await s.renewer.renewNow();
    expect(out.ok).toBe(true);
    const v = s.renewer.view();
    expect(v.lastRenewed).toMatchObject({ trigger: 'manual' });
    expect(v.certificateNames).toEqual({ dns: ['localhost', 'podium.lan'], ip: ['127.0.0.1'] });
    expect(v.names).toEqual(names);
    expect(v.settings).toEqual(SERVING_DEFAULTS);
  });

  it('namesOf reads the DNS and IP names of a certificate', async () => {
    const s = await renewerSetup();
    expect(namesOf(s.material.cert)).toEqual({ dns: ['localhost', 'podium.lan'], ip: ['127.0.0.1'] });
  });
});

describe('the swap on a running listener', () => {
  const freePort = async (): Promise<number> => {
    const http = await import('node:http');
    return new Promise((resolve) => {
      const s = http.createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address() as { port: number };
        s.close(() => resolve(port));
      });
    });
  };
  const get = (port: number, ca: string, agent: https.Agent) =>
    new Promise<{ serial: string; socket: unknown }>((resolve, reject) => {
      const req = https.get({ host: '127.0.0.1', port, ca, servername: 'localhost', headers: { host: 'localhost' }, path: '/ping', agent }, (res) => {
        const serial = (res.socket as import('node:tls').TLSSocket).getPeerCertificate().serialNumber;
        res.resume();
        res.on('end', () => resolve({ serial, socket: res.socket }));
      });
      req.on('error', reject);
    });

  it('renews at start when due, then a keep-alive connection keeps the old certificate and a new one gets the new, with no restart', async () => {
    const root = scratch();
    const lines: Array<Record<string, unknown>> = [];
    const logger = createLogger({ format: 'json', write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) });
    const app = express();
    app.get('/ping', (_q, r) => void r.json({ ok: true }));
    const dbPath = path.join(root, 'podium.sqlite');
    const port = await freePort();
    const base = { env: { PODIUM_TLS: 'on', PODIUM_TLS_PORT: String(port) }, app, dbPath, bind: '127.0.0.1', httpPort: 4317, allowedHosts: [], logger };

    // First run makes the certificate with the shortest lifetime and the longest renew-before, as the issue's check does.
    const settings: ServingSettings = { lifetimeDays: 30, renewBeforeDays: 90 };
    const first = (await startTls({ ...base, settings: () => settings }))!;
    const created = first.renewer.view().serving;
    await new Promise((r) => first.server.close(r));
    expect(lines.some((l) => l.event === 'tls.serving_renewed')).toBe(false);

    // A restart two days later finds it inside the window and renews before accepting a connection.
    const l = (await startTls({ ...base, settings: () => settings, now: () => Date.now() + 2 * DAY }))!;
    try {
      const v = l.renewer.view();
      expect(v.serving.serial).not.toBe(created.serial);
      expect(v.lastRenewed).toMatchObject({ trigger: 'start' });
      expect(v.previous.map((p) => p.serial)).toEqual([created.serial]);

      const agent = new https.Agent({ keepAlive: true });
      const a = await get(port, l.material.caCert, agent);
      expect(a.serial).toBe(v.serving.serial);
      const out = await l.renewer.renewNow();
      expect(out.ok).toBe(true);
      const b = await get(port, l.material.caCert, agent);
      expect(b.socket).toBe(a.socket); // the same connection
      expect(b.serial).toBe(a.serial); // still on the old certificate
      const c = await get(port, l.material.caCert, new https.Agent({ keepAlive: false }));
      expect(c.serial).toBe((out as { serving: { serial: string } }).serving.serial);
      expect(c.serial).not.toBe(a.serial);
      agent.destroy();
    } finally {
      await new Promise((r) => l.server.close(r));
    }
  });

  it('stops its timer when the listener closes', async () => {
    const root = scratch();
    const app = express();
    const l = (await startTls({ env: { PODIUM_TLS: 'on', PODIUM_TLS_PORT: String(await freePort()) }, app, dbPath: path.join(root, 'podium.sqlite'), bind: '127.0.0.1', httpPort: 4317, allowedHosts: [], logger: createLogger({ format: 'json', write: () => {} }) }))!;
    await new Promise((r) => l.server.close(r));
    expect((l.renewer as unknown as { timer: unknown }).timer).toBeNull();
  });
});
