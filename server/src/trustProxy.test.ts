import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Lockout } from './fleet/lockout.js';
import { parseTrustProxy } from './trustProxy.js';

describe('parseTrustProxy', () => {
  it('is off when unset or empty, so nothing changes without a proxy', () => {
    for (const v of [undefined, '', '  ', 'false', 'off', '0']) expect(parseTrustProxy(v), String(v)).toBe(false);
  });

  it('reads a hop count', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy(' 2 ')).toBe(2);
  });

  it('reads addresses, ranges and the named ranges, comma-separated', () => {
    expect(parseTrustProxy('10.0.0.5, 172.16.0.0/12,loopback,::1')).toEqual(['10.0.0.5', '172.16.0.0/12', 'loopback', '::1']);
  });

  it('refuses "true", which trusts every hop and lets any client choose its source', () => {
    expect(() => parseTrustProxy('true')).toThrow(/every hop/);
  });

  it('refuses a malformed entry, a negative count and a bad prefix length', () => {
    for (const v of ['-1', '1.5', 'not-an-address', '10.0.0.1,,', '10.0.0.0/33', '::1/129']) expect(() => parseTrustProxy(v), v).toThrow(/PODIUM_TRUST_PROXY/);
  });
});

// The proxy under test is the supertest peer, 127.0.0.1 (on the IPv6 stack ::ffff:127.0.0.1).
const appWith = (setting: string | undefined) => {
  const app = express();
  app.set('trust proxy', parseTrustProxy(setting));
  const lockout = new Lockout();
  app.get('/who', (req, res) => void res.json({ ip: req.ip, secure: req.secure }));
  app.post('/try', (req, res) => {
    if (lockout.lockedFor(req.ip ?? '')) return void res.status(429).end();
    lockout.fail(req.ip ?? '');
    res.status(401).end();
  });
  return app;
};

describe('behind a proxy', () => {
  it('with the setting off, ignores X-Forwarded-For and X-Forwarded-Proto', async () => {
    const res = await request(appWith(undefined)).get('/who').set('X-Forwarded-For', '203.0.113.7').set('X-Forwarded-Proto', 'https');
    expect(res.body.ip).toMatch(/127\.0\.0\.1$/);
    expect(res.body.secure).toBe(false);
  });

  it('with the peer trusted, takes the source and the scheme from the proxy', async () => {
    const res = await request(appWith('loopback')).get('/who').set('X-Forwarded-For', '203.0.113.7').set('X-Forwarded-Proto', 'https');
    expect(res.body).toEqual({ ip: '203.0.113.7', secure: true });
  });

  it('with the peer not in the trusted list, ignores the headers a client sends', async () => {
    const res = await request(appWith('10.9.9.9')).get('/who').set('X-Forwarded-For', '203.0.113.7').set('X-Forwarded-Proto', 'https');
    expect(res.body.ip).toMatch(/127\.0\.0\.1$/);
    expect(res.body.secure).toBe(false);
  });

  it('with one trusted hop, takes the address the proxy appended, whatever a client put to its left', async () => {
    const res = await request(appWith('1')).get('/who').set('X-Forwarded-For', '6.6.6.6, 203.0.113.7');
    expect(res.body.ip).toBe('203.0.113.7');
  });

  it("keeps one client's wrong tries from locking another out", async () => {
    const app = appWith('loopback');
    const from = (ip: string) => request(app).post('/try').set('X-Forwarded-For', ip);
    for (let i = 0; i < 5; i++) await from('203.0.113.1');
    expect((await from('203.0.113.1')).status).toBe(429);
    expect((await from('203.0.113.2')).status).toBe(401);
  });

  it('without the setting, shares one lockout across every client', async () => {
    const app = appWith(undefined);
    const from = (ip: string) => request(app).post('/try').set('X-Forwarded-For', ip);
    for (let i = 0; i < 5; i++) await from('203.0.113.1');
    expect((await from('203.0.113.2')).status).toBe(429);
  });
});
