// #745: /api/fleet/state is gzipped for a client that accepts it; PODIUM_COMPRESSION=off turns it off.
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { COMPRESS_MIN_BYTES, parseCompression, sendJson } from './compress.js';

const big = { rows: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `session number ${i}` })) };
const small = { ok: true };

function appWith(body: unknown, enabled: boolean) {
  const app = express();
  app.get('/x', (req, res) => void sendJson(req, res, body, enabled));
  return app;
}

/** The response body as bytes, without supertest's JSON parsing. */
const raw = (res: request.Test) =>
  res.buffer(true).parse((r, done) => {
    const parts: Buffer[] = [];
    r.on('data', (c: Buffer) => parts.push(c));
    r.on('end', () => done(null, Buffer.concat(parts)));
  });

describe('sendJson', () => {
  it('gzips a large body for a client that accepts gzip', async () => {
    const res = await raw(request(appWith(big, true)).get('/x').set('Accept-Encoding', 'gzip'));
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['vary']).toMatch(/Accept-Encoding/i);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    // superagent inflates a gzip body before any parser sees it, so the body is the plain JSON and Content-Length is the gzip size.
    const plain = res.body as Buffer;
    expect(JSON.parse(plain.toString('utf8'))).toEqual(big);
    expect(Number(res.headers['content-length'])).toBeLessThan(plain.length);
  });

  it('sends plain JSON to a client that sends no Accept-Encoding gzip', async () => {
    const res = await request(appWith(big, true)).get('/x').set('Accept-Encoding', 'identity');
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['vary']).toMatch(/Accept-Encoding/i);
    expect(res.body).toEqual(big);
  });

  it('sends plain JSON when compression is off', async () => {
    const res = await request(appWith(big, false)).get('/x').set('Accept-Encoding', 'gzip');
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body).toEqual(big);
  });

  it('sends a body under the threshold plain', async () => {
    expect(JSON.stringify(small).length).toBeLessThan(COMPRESS_MIN_BYTES);
    const res = await request(appWith(small, true)).get('/x').set('Accept-Encoding', 'gzip');
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body).toEqual(small);
  });

  it('counts the threshold in bytes, not characters', async () => {
    const wide = { s: 'é'.repeat(600) }; // about 600 characters, about 1.2 KB
    expect(JSON.stringify(wide).length).toBeLessThan(COMPRESS_MIN_BYTES);
    expect(Buffer.byteLength(JSON.stringify(wide))).toBeGreaterThanOrEqual(COMPRESS_MIN_BYTES);
    const res = await request(appWith(wide, true)).get('/x').set('Accept-Encoding', 'gzip');
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('passes a failure to the error middleware instead of crashing', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const app = express();
    app.get('/x', (req, res, next) => void sendJson(req, res, circular, true).catch(next));
    const res = await request(app).get('/x').set('Accept-Encoding', 'gzip');
    expect(res.status).toBe(500);
  });
});

describe('parseCompression', () => {
  it('is on when unset or on, and off for off', () => {
    expect(parseCompression(undefined)).toBe(true);
    expect(parseCompression('')).toBe(true);
    expect(parseCompression(' ON ')).toBe(true);
    expect(parseCompression('off')).toBe(false);
  });

  it('throws on anything else, so a typo stops the server at start', () => {
    expect(() => parseCompression('maybe')).toThrow(/PODIUM_COMPRESSION/);
  });
});
