// Reporters over HTTP (#577, T11): the HTTP listener refuses the routes a reporter calls unless the Admin allows it or the caller is on loopback.
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logging/logger.js';
import { isReporterRoute, reporterHttpGate, ReporterTransport } from './tlsHttp.js';

const logger = createLogger({ format: 'json', write: () => {} });

describe('isReporterRoute', () => {
  it('knows the routes the mod calls, and not the ones the console calls', () => {
    for (const [m, p] of [
      ['POST', '/api/fleet/report'],
      ['POST', '/api/fleet/report/'],
      ['POST', '/API/Fleet/Report'],
      ['POST', '/api/fleet/hook'],
      ['GET', '/api/fleet/sessions/s1/peers'],
      ['POST', '/api/fleet/sessions/s1/peers/messages'],
      ['POST', '/api/fleet/sessions/s1/peers/access'],
      ['POST', '/api/fleet/sessions/s1/peers/requests/r1'],
      ['POST', '/api/fleet/sessions/s1/peers/deliveries/d1/result'],
      ['PUT', '/api/fleet/sessions/s1/diffs/r1'],
      ['PUT', '/api/fleet/sessions/s1/asks/a1'],
      ['GET', '/api/fleet/sessions/s1/asks/a1/answer'],
      ['POST', '/api/fleet/sessions/s1/asks/a1/close'],
      ['POST', '/api/fleet/sessions/s1/deliveries/d1/result'],
      ['POST', '/api/fleet/sessions/s1/recording'],
    ]) {
      expect(isReporterRoute(m, p), `${m} ${p}`).toBe(true);
    }
    for (const [m, p] of [
      ['GET', '/api/fleet/state'],
      ['GET', '/api/fleet/stream'],
      ['GET', '/api/fleet/sessions/s1'],
      ['DELETE', '/api/fleet/sessions/s1'],
      ['GET', '/api/fleet/peers/traffic'],
      ['POST', '/api/admin/unlock'],
      ['GET', '/'],
    ]) {
      expect(isReporterRoute(m, p), `${m} ${p}`).toBe(false);
    }
  });
});

function appWith(o: { allow: boolean; on?: boolean }) {
  const app = express();
  app.set('trust proxy', true);
  const refused: Array<[string | null, string]> = [];
  app.use(reporterHttpGate({ active: () => o.on ?? true, allowed: () => o.allow, logger, rejected: (s, r) => refused.push([s, r]) }));
  app.all('*', (_req, res) => void res.json({ ok: true }));
  return { app, refused };
}

describe('reporterHttpGate', () => {
  it('lets a reporter route through while HTTP is allowed', async () => {
    const { app } = appWith({ allow: true });
    expect((await request(app).post('/api/fleet/report').set('X-Forwarded-For', '10.0.0.5')).status).toBe(200);
  });

  it('refuses a reporter route off loopback when HTTP is not allowed, and says why', async () => {
    const { app, refused } = appWith({ allow: false });
    const res = await request(app).post('/api/fleet/report').set('X-Forwarded-For', '10.0.0.5');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/reporter config/);
    expect(refused[0]).toEqual(['10.0.0.5', expect.stringContaining('over HTTPS')]);
    expect((await request(app).post('/api/fleet/hook').set('X-Forwarded-For', '10.0.0.5')).status).toBe(403);
  });

  it('keeps a reporter on loopback working, and the console off loopback', async () => {
    const { app } = appWith({ allow: false });
    expect((await request(app).post('/api/fleet/report')).status).toBe(200);
    expect((await request(app).get('/api/fleet/state').set('X-Forwarded-For', '10.0.0.5')).status).toBe(200);
  });

  it('does nothing while TLS is not running', async () => {
    const { app } = appWith({ allow: false, on: false });
    expect((await request(app).post('/api/fleet/report').set('X-Forwarded-For', '10.0.0.5')).status).toBe(200);
  });

  it('never refuses a request that came in over TLS', () => {
    const gate = reporterHttpGate({ active: () => true, allowed: () => false, logger });
    let called = false;
    const req = { method: 'POST', path: '/api/fleet/report', ip: '10.0.0.5', socket: { encrypted: true } };
    gate(req as never, {} as never, () => (called = true));
    expect(called).toBe(true);
  });
});

describe('ReporterTransport', () => {
  it('counts the reporters heard from over HTTP in the last two minutes, and all of them', () => {
    const t = new ReporterTransport();
    t.note('a', false, 1_000_000);
    t.note('b', false, 1_000_000);
    t.note('c', true, 1_000_000);
    t.note('d', false, 1_000_000 - 3 * 60_000);
    expect(t.count(1_000_000)).toEqual({ overHttp: 2, total: 3 });
  });

  it('counts a reporter once, by its latest transport', () => {
    const t = new ReporterTransport();
    t.note('a', false, 1_000);
    t.note('a', true, 2_000);
    expect(t.count(3_000)).toEqual({ overHttp: 0, total: 1 });
  });
});
