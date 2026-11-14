// The console's files and its fallback to index.html (#392), compressed and cacheable (#747). Nothing covered a direct load of a deep link before, and the fallback is
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

  // #747: the page files go out compressed and cacheable.
  describe('compression and caching', () => {
    const big = `console.log("${'x'.repeat(4000)}");`;
    beforeEach(() => {
      fs.writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), big);
      fs.writeFileSync(path.join(dist, 'assets', 'index-abc123.css'), `body{margin:0}${'/*pad*/'.repeat(500)}`);
      fs.writeFileSync(path.join(dist, 'index.html'), `<!doctype html><title>console</title>${'<!--pad-->'.repeat(300)}`);
    });
    const withCompression = (enabled: boolean) => {
      const app = express();
      serveSpa(app, dist, {}, enabled);
      return app;
    };

    it('gzips the script for a client that accepts gzip, and the body is the same script', async () => {
      const res = await request(withCompression(true)).get('/assets/index-abc123.js').set('Accept-Encoding', 'gzip');
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.headers.vary).toMatch(/Accept-Encoding/i);
      expect(res.headers['content-type']).toMatch(/javascript/);
      expect(res.text).toBe(big);
      expect(Number(res.headers['content-length'])).toBeLessThan(big.length / 4);
    });

    it('gzips the stylesheet and the page', async () => {
      const css = await request(withCompression(true)).get('/assets/index-abc123.css').set('Accept-Encoding', 'gzip');
      expect(css.headers['content-encoding']).toBe('gzip');
      expect(css.headers['content-type']).toMatch(/css/);
      const html = await request(withCompression(true)).get('/').set('Accept-Encoding', 'gzip');
      expect(html.headers['content-encoding']).toBe('gzip');
      expect(html.text).toContain('<title>console</title>');
    });

    it('sends plain bytes to a client that does not accept gzip', async () => {
      const res = await request(withCompression(true)).get('/assets/index-abc123.js').set('Accept-Encoding', 'identity');
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.headers.vary).toMatch(/Accept-Encoding/i);
      expect(res.text).toBe(big);
    });

    it('sends plain bytes when PODIUM_COMPRESSION is off', async () => {
      const res = await request(withCompression(false)).get('/assets/index-abc123.js').set('Accept-Encoding', 'gzip');
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.text).toBe(big);
    });

    it('sends a file under the size floor plain', async () => {
      const res = await request(withCompression(true)).get('/assets/app.js').set('Accept-Encoding', 'gzip');
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.text).toBe('console.log("app");');
    });

    it.each([true, false])('gives a hashed file a year and immutable (compression %s)', async (enabled) => {
      const res = await request(withCompression(enabled)).get('/assets/index-abc123.js').set('Accept-Encoding', 'gzip');
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it.each(['/', '/index.html', '/admin', '/a/b/c'])('revalidates the page at %s on every visit', async (url) => {
      const res = await request(withCompression(true)).get(url).set('Accept-Encoding', 'gzip');
      expect(res.headers['cache-control']).toBe('no-cache');
    });

    it('answers 304 to a repeat request for the gzipped script', async () => {
      const app = withCompression(true);
      const first = await request(app).get('/assets/index-abc123.js').set('Accept-Encoding', 'gzip');
      expect(first.headers.etag).toBeTruthy();
      const again = await request(app).get('/assets/index-abc123.js').set('Accept-Encoding', 'gzip').set('If-None-Match', first.headers.etag as string);
      expect(again.status).toBe(304);
    });

    it('answers 304 to a repeat request for the page', async () => {
      const app = withCompression(true);
      const first = await request(app).get('/').set('Accept-Encoding', 'gzip');
      const again = await request(app).get('/').set('Accept-Encoding', 'gzip').set('If-None-Match', first.headers.etag as string);
      expect(again.status).toBe(304);
    });

    it('serves a rebuilt file, not the old cached bytes', async () => {
      const app = withCompression(true);
      await request(app).get('/assets/index-abc123.js').set('Accept-Encoding', 'gzip');
      const next = `console.log("${'y'.repeat(4000)}");`;
      const file = path.join(dist, 'assets', 'index-abc123.js');
      fs.writeFileSync(file, next);
      const bump = new Date(Date.now() + 5000);
      fs.utimesSync(file, bump, bump);
      const res = await request(app).get('/assets/index-abc123.js').set('Accept-Encoding', 'gzip');
      expect(res.text).toBe(next);
    });

    it('does not read outside the build folder', async () => {
      const res = await request(withCompression(true)).get('/assets/..%2f..%2fetc%2fpasswd').set('Accept-Encoding', 'gzip');
      expect(res.text).not.toContain('root:');
      expect(res.text).toContain('<title>console</title>'); // the page, as for any unknown path
    });

    it('does not gzip a dotfile the plain path would not serve', async () => {
      fs.mkdirSync(path.join(dist, '.hidden'), { recursive: true });
      fs.writeFileSync(path.join(dist, '.hidden', 'secret.json'), `{"k":"${'s'.repeat(2000)}"}`);
      const res = await request(withCompression(true)).get('/.hidden/secret.json').set('Accept-Encoding', 'gzip');
      expect(res.text).not.toContain('sssss');
      expect(res.text).toContain('<title>console</title>');
    });

    it('answers HEAD with the encoding and no body', async () => {
      const res = await request(withCompression(true)).head('/assets/index-abc123.js').set('Accept-Encoding', 'gzip');
      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBe('gzip');
    });
  });

  it('answers 404 for a path when the build has no index.html', async () => {
    fs.rmSync(path.join(dist, 'index.html'));
    expect((await request(appWith()).get('/admin')).status).toBe(404);
  });
});
