// #745: gzip for /api/fleet/state. The event stream is not compressed (SPEC 7.6): each client held a compressor, which cost
// more than the 10% budget at the 100-client cap.
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { Request, Response } from 'express';

const gzipAsync = promisify(gzip);

/** A body shorter than this goes out plain: the idle state is about 1.1 KB and gzip would save little for the work. */
export const COMPRESS_MIN_BYTES = 1024;

/** Reads PODIUM_COMPRESSION: `on` (also unset or empty) or `off`. Throws on anything else, so a typo stops the server at start. */
export function parseCompression(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'on') return true;
  if (value === 'off') return false;
  throw new Error(`PODIUM_COMPRESSION: "${value}" is not on or off`);
}

/**
 * Sends `body` as JSON, gzipped when `enabled` and the client accepts gzip and the body is big enough. A client that sends no
 * Accept-Encoding (the health check, `podiumctl`, the scripts) gets plain JSON. Compression runs on the thread pool, not the event loop.
 */
export async function sendJson(req: Request, res: Response, body: unknown, enabled: boolean): Promise<void> {
  res.vary('Accept-Encoding');
  const text = JSON.stringify(body);
  if (!enabled || Buffer.byteLength(text) < COMPRESS_MIN_BYTES || !req.acceptsEncodings('gzip')) {
    res.type('application/json').send(text);
    return;
  }
  const packed = await gzipAsync(text);
  res.setHeader('Content-Encoding', 'gzip');
  res.type('application/json').send(packed);
}
