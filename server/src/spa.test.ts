// The console's files and its fallback to index.html (#392). Nothing covered a direct load of a deep link before, and the fallback is
// the one route in the server that Express 5 spells differently from Express 4.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { serveSpa } from './spa.js';

let dist: string;
beforeEach(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-spa-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>console</title>');
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log("app");');
});
afterEach(() => fs.rmSync(dist, { recursive: true, force: true }));

function appWith(limit?: { max?: number }) {
  const app = express();
  serveSpa(app, dist, limit);
  return app;
}

describe('serveSpa', () => {
  it('serves the page at the root', async () => {
    const res = await request(appWith()).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<title>console</title>');
  });

  it('serves a built file as itself', async () => {
    const res = await request(appWith()).get('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.text).toBe('console.log("app");');
  });

  it.each(['/admin', '/a/b/c', '/some.thing', '/assets/missing.js', '/assets/'])('opens the page for a direct load of %s', async (url) => {
    const res = await request(appWith()).get(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<title>console</title>');
  });

  it('sends a folder to its slash form, as the static handler always has', async () => {
    const res = await request(appWith()).get('/assets');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/assets/');
  });

  it('answers a HEAD request for a deep link', async () => {
    expect((await request(appWith()).head('/admin')).status).toBe(200);
  });

  it('is for reading only: a POST to a page is not found', async () => {
    expect((await request(appWith()).post('/admin')).status).toBe(404);
  });

  it('limits the fallback pages, and not the built files', async () => {
    const app = appWith({ max: 2 });
    for (let i = 0; i < 5; i++) expect((await request(app).get('/assets/app.js')).status).toBe(200);
    expect((await request(app).get('/admin')).status).toBe(200);
    expect((await request(app).get('/a/b')).status).toBe(200);
    const res = await request(app).get('/c');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toMatch(/^\d+$/);
  });

  // Express 5's res.sendFile answers 404 for an absolute path with a dot-directory anywhere in it; Express 4 served it. A checkout under
  // ~/.local or ~/.cache is such a path, so the page must be named relative to its folder.
  it('opens the page when the build sits under a dot-directory', async () => {
    const hidden = path.join(dist, '.hidden', 'dist');
    fs.mkdirSync(hidden, { recursive: true });
    fs.writeFileSync(path.join(hidden, 'index.html'), '<!doctype html><title>console</title>');
    const app = express();
    serveSpa(app, hidden);
    for (const url of ['/', '/admin', '/a/b/c']) {
      const res = await request(app).get(url);
      expect([url, res.status]).toEqual([url, 200]);
      expect(res.text).toContain('<title>console</title>');
    }
  });

  it('answers 404 for a path when the build has no index.html', async () => {
    fs.rmSync(path.join(dist, 'index.html'));
    expect((await request(appWith()).get('/admin')).status).toBe(404);
  });
});
