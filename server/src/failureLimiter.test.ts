// A brake on failed requests from one address (CodeQL js/missing-rate-limiting on the routes that check a token or a certificate).
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { FAILURE_LIMIT, failureLimiter, parseFailureLimit } from './failureLimiter.js';
import { createLogger } from './logging/logger.js';

function appWith(o: { max: number; windowMs?: number; logs?: unknown[] }) {
  const logger = createLogger({ format: 'json', write: (line: string) => void o.logs?.push(JSON.parse(line)) });
  const app = express();
  app.set('trust proxy', 1);
  app.use(failureLimiter({ max: o.max, windowMs: o.windowMs, logger }));
  app.get('/ok', (_req, res) => void res.json({ ok: true }));
  app.get('/no', (_req, res) => void res.status(401).json({ ok: false }));
  return app;
}

describe('failureLimiter', () => {
  it('lets successful requests through however many there are', async () => {
    const app = appWith({ max: 3 });
    for (let i = 0; i < 10; i++) await request(app).get('/ok').expect(200);
  });

  it('answers 429 with Retry-After once an address has had too many failures', async () => {
    const app = appWith({ max: 3 });
    for (let i = 0; i < 3; i++) await request(app).get('/no').expect(401);
    const res = await request(app).get('/ok').expect(429);
    expect(res.body).toMatchObject({ ok: false });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('counts each address on its own', async () => {
    const app = appWith({ max: 2 });
    for (let i = 0; i < 2; i++) await request(app).get('/no').set('X-Forwarded-For', '192.0.2.1').expect(401);
    await request(app).get('/ok').set('X-Forwarded-For', '192.0.2.1').expect(429);
    await request(app).get('/ok').set('X-Forwarded-For', '192.0.2.2').expect(200);
  });

  it('logs the first refusal once, with the address and no credential', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const app = appWith({ max: 1, logs });
    await request(app).get('/no').set('X-Podium-Token', 'secret-value').expect(401);
    await request(app).get('/ok').set('X-Podium-Token', 'secret-value').expect(429);
    const throttled = logs.filter((l) => l.event === 'auth.throttled');
    expect(throttled).toHaveLength(1);
    expect(JSON.stringify(throttled)).not.toContain('secret-value');
  });

  it('starts a new count when the window ends, and logs the next window again', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const app = appWith({ max: 1, windowMs: 1000, logs });
    await request(app).get('/no').expect(401);
    await request(app).get('/ok').expect(429);
    await new Promise((r) => setTimeout(r, 1100));
    await request(app).get('/ok').expect(200);
    await request(app).get('/no').expect(401);
    await request(app).get('/ok').expect(429);
    expect(logs.filter((l) => l.event === 'auth.throttled')).toHaveLength(2);
  });

  it('logs once for a burst of concurrent failures', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const app = appWith({ max: 2, logs });
    await Promise.all(Array.from({ length: 12 }, () => request(app).get('/no')));
    await request(app).get('/ok').expect(429);
    expect(logs.filter((l) => l.event === 'auth.throttled')).toHaveLength(1);
  });
});

describe('parseFailureLimit', () => {
  it('is the default when unset or blank, and a whole number when set', () => {
    expect(parseFailureLimit(undefined)).toBe(FAILURE_LIMIT);
    expect(parseFailureLimit('  ')).toBe(FAILURE_LIMIT);
    expect(parseFailureLimit(' 1200 ')).toBe(1200);
  });

  it('refuses anything else, so a typo stops the server at start', () => {
    for (const bad of ['0', '-5', '1.5', 'many', '12abc', '1234567890']) expect(() => parseFailureLimit(bad), bad).toThrow(/PODIUM_FAILURE_LIMIT/);
  });
});
