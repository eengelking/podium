// The built console: its files, and index.html for any other path, so a link to a page of the console opens it. It lives here and not in
// index.ts so a test can reach it; index.ts only runs as the server (#392).
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Express, type Request, type Response } from 'express';
import { asyncHandler } from './fleet/asyncHandler.js';
import { COMPRESS_MIN_BYTES } from './compress.js';
import { pageLimiter } from './failureLimiter.js';

const gzipAsync = promisify(gzip);

/** The build names each file under assets/ by its content hash, so a file at one URL never changes: a year, and never ask again. */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
/** The page and the other files keep their names between builds, so the browser asks each visit and gets a 304 when nothing changed. */
export const REVALIDATE_CACHE = 'no-cache';

const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.txt', '.map']);

const isCompressible = (file: string): boolean => COMPRESSIBLE.has(path.extname(file).toLowerCase());
const cacheControlFor = (relative: string): string => (relative.split(path.sep)[0] === 'assets' ? IMMUTABLE_CACHE : REVALIDATE_CACHE);

interface Packed {
  mtimeMs: number;
  size: number;
  body: Buffer;
}

/**
 * Gzips a built file once and keeps the bytes until the file changes, so the cost is one compression per file per process and not one
 * per visit. The files are the console's own build, a few hundred KB in all, so the cache is bounded by the build.
 */
function gzipCache(): (file: string, size: number, mtimeMs: number) => Promise<Buffer> {
  const packed = new Map<string, Promise<Packed>>();
  return async (file, size, mtimeMs) => {
    const have = packed.get(file);
    if (have) {
      const hit = await have.catch(() => undefined);
      if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.body;
    }
    const next = fs.promises.readFile(file).then((text) => gzipAsync(text, { level: 9 }).then((body) => ({ mtimeMs, size, body })));
    packed.set(file, next);
    try {
      return (await next).body;
    } catch (err) {
      packed.delete(file);
      throw err;
    }
  };
}

/**
 * Sends one built file gzipped when `enabled`, the client accepts gzip, the type compresses and the file is big enough. Returns false when
 * it sent nothing, and the caller serves the file as it is. A file that is not inside `dist` is never read. Compression runs on the thread
 * pool, not the event loop. `PODIUM_COMPRESSION=off` turns it off, as for /api/fleet/state (#745). The event stream is never routed here.
 */
function compressedSender(dist: string, enabled: boolean): (req: Request, res: Response, urlPath: string) => Promise<boolean> {
  const root = path.resolve(dist);
  const pack = gzipCache();
  return async (req, res, urlPath) => {
    if (!enabled || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    let relative: string;
    try {
      relative = decodeURIComponent(urlPath).replace(/^\/+/, '') || 'index.html';
    } catch {
      return false;
    }
    if (relative.includes('\0')) return false;
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || !isCompressible(file)) return false;
    // express.static ignores dotfiles and dot-folders by default; the gzip path must not serve what the plain path would not.
    if (path.relative(root, file).split(path.sep).some((part) => part.startsWith('.'))) return false;
    // The browser asks for gzip on every request, so the answer varies by it whether or not this one is packed.
    res.vary('Accept-Encoding');
    if (!req.acceptsEncodings('gzip')) return false;
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile() || stat.size < COMPRESS_MIN_BYTES) return false;
    const body = await pack(file, stat.size, stat.mtimeMs);
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Cache-Control', cacheControlFor(path.relative(root, file)));
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.type(path.extname(file));
    res.send(body);
    return true;
  };
}

// The fallback pages are rate limited here, where the limiter is applied, so a code scan can see it (#392).
export function serveSpa(app: Express, dist: string, limit: { max?: number; windowMs?: number } = {}, compression = true): void {
  const send = compressedSender(dist, compression);
  const root = path.resolve(dist);
  app.use(
    asyncHandler(async (req, res, next) => {
      if (!(await send(req, res, req.path))) next();
    }),
  );
  app.use(
    express.static(dist, {
      setHeaders: (res, file) => {
        res.setHeader('Cache-Control', cacheControlFor(path.relative(root, file)));
        if (compression && isCompressible(file)) res.vary('Accept-Encoding');
      },
    }),
  );
  // Named relative to its folder, not as an absolute path: Express 5's res.sendFile answers 404 for an absolute path with a dot-directory
  // in it (a checkout under ~/.local, say), where Express 4 served it.
  app.get(
    '/{*splat}',
    pageLimiter(limit),
    asyncHandler(async (req, res) => {
      // Any other path opens the page, which is never cached without asking: a deep link must not hold an old build.
      if (await send(req, res, '/index.html')) return;
      res.setHeader('Cache-Control', REVALIDATE_CACHE);
      res.sendFile('index.html', { root: dist });
    }),
  );
}
