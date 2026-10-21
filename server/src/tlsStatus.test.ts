// The console's read of the certificate countdown (#586, T8): the stage math, and GET /api/tls/status.
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { CertInfo } from './tlsCa.js';
import { createTlsStatusRouter, STATUS_CACHE_MS, stageForDays, tlsStatus } from './tlsStatus.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-21T12:00:00Z');
const cert = (daysLeft: number): CertInfo => ({ fingerprintSha256: 'AA:BB', subject: 'CN=secret-name', notBefore: new Date(NOW - 10 * DAY).toISOString(), notAfter: new Date(NOW + daysLeft * DAY).toISOString(), serial: '01' });

describe('stageForDays', () => {
  it.each([
    [400, 'ok'], [31, 'ok'], [30, 'soon'], [11, 'soon'], [10, 'serious'], [6, 'serious'], [5, 'critical'], [1, 'critical'], [0, 'critical'], [-1, 'expired'], [-40, 'expired'],
  ])('%d days left is %s', (days, stage) => {
    expect(stageForDays(days)).toBe(stage);
  });
});

const view = (ca: number, serving: number, failed = false, countdown = true) => ({
  ca: cert(ca),
  serving: cert(serving),
  lastFailure: failed ? { at: 'x', reason: 'openssl missing at /secret/path', trigger: 'schedule' as const } : null,
  settings: { lifetimeDays: 365, renewBeforeDays: 30, headerCountdown: countdown },
});

describe('tlsStatus', () => {
  it('is only { enabled: false } when TLS is off', () => {
    expect(tlsStatus(null, NOW)).toEqual({ enabled: false });
  });

  it('reports the serving certificate when it expires first', () => {
    expect(tlsStatus(view(3000, 28.5), NOW)).toEqual({ enabled: true, expiresAt: cert(28.5).notAfter, subject: 'serving', daysLeft: 28, stage: 'soon', renewalFailed: false, showCountdown: true });
  });

  it('reports the CA when it expires first', () => {
    expect(tlsStatus(view(9, 300), NOW)).toMatchObject({ subject: 'ca', daysLeft: 9, stage: 'serious', expiresAt: cert(9).notAfter });
  });

  it('floors toward the past, so an expired certificate is negative', () => {
    expect(tlsStatus(view(3000, -0.5), NOW)).toMatchObject({ daysLeft: -1, stage: 'expired' });
    expect(tlsStatus(view(3000, 0), NOW)).toMatchObject({ daysLeft: 0, stage: 'expired' });
    expect(tlsStatus(view(3000, 4.9), NOW)).toMatchObject({ daysLeft: 4, stage: 'critical' });
  });

  it('stays critical, not expired, until the moment the certificate ends (the notice window covers the last day)', () => {
    expect(tlsStatus(view(3000, 0.5), NOW)).toMatchObject({ daysLeft: 0, stage: 'critical' });
    expect(tlsStatus(view(3000, 1 / DAY), NOW)).toMatchObject({ daysLeft: 0, stage: 'critical' });
  });

  it('carries the failure flag and the setting, and nothing else', () => {
    const out = tlsStatus(view(3000, 200, true, false), NOW);
    expect(out).toMatchObject({ renewalFailed: true, showCountdown: false, stage: 'ok' });
    expect(Object.keys(out).sort()).toEqual(['daysLeft', 'enabled', 'expiresAt', 'renewalFailed', 'showCountdown', 'stage', 'subject']);
    const text = JSON.stringify(out);
    for (const leak of ['AA:BB', 'secret', 'serial']) expect(text).not.toContain(leak);
  });
});

describe('GET /api/tls/status cache', () => {
  function counted(v: ReturnType<typeof view> | null, clock: { t: number }) {
    const calls = { n: 0 };
    const a = express();
    a.use('/api/tls', createTlsStatusRouter({ view: () => { calls.n++; return v; }, now: () => clock.t }));
    return { a, calls };
  }

  it('reads the certificates once for requests inside the cache window', async () => {
    const clock = { t: NOW };
    const { a, calls } = counted(view(3000, 200), clock);
    await request(a).get('/api/tls/status');
    clock.t += STATUS_CACHE_MS - 1;
    const res = await request(a).get('/api/tls/status');
    expect(calls.n).toBe(1);
    expect(res.body).toMatchObject({ enabled: true, stage: 'ok' });
  });

  it('reads again once the window has passed', async () => {
    const clock = { t: NOW };
    const { a, calls } = counted(view(3000, 200), clock);
    await request(a).get('/api/tls/status');
    clock.t += STATUS_CACHE_MS;
    await request(a).get('/api/tls/status');
    expect(calls.n).toBe(2);
  });

  it('does not serve a cached answer past the moment a certificate expires', async () => {
    const clock = { t: NOW };
    const { a, calls } = counted(view(3000, 10 / DAY), clock); // ends 10 s from now, inside the window
    expect((await request(a).get('/api/tls/status')).body).toMatchObject({ stage: 'critical' });
    clock.t += 10_000;
    const res = await request(a).get('/api/tls/status');
    expect(calls.n).toBe(2);
    expect(res.body).toMatchObject({ stage: 'expired' });
  });

  it('caches the answer for TLS off too', async () => {
    const clock = { t: NOW };
    const { a, calls } = counted(null, clock);
    await request(a).get('/api/tls/status');
    await request(a).get('/api/tls/status');
    expect(calls.n).toBe(1);
  });
});

describe('GET /api/tls/status', () => {
  const app = (v: ReturnType<typeof view> | null) => {
    const a = express();
    a.use('/api/tls', createTlsStatusRouter({ view: () => v, now: () => NOW }));
    return a;
  };

  it('answers without any credential', async () => {
    const res = await request(app(view(3000, 4))).get('/api/tls/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, stage: 'critical', daysLeft: 4 });
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE KEY');
  });

  it('answers { enabled: false } when TLS is off', async () => {
    const res = await request(app(null)).get('/api/tls/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });
  });
});
