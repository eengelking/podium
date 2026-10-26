import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from './logging/logger.js';
import { freePort, startTlsForTest } from './tlsTesting.js';

// The helper every TLS test starts its listener with (#670): it picks the port, retries when the port was taken between
// choosing and binding, and says why when the listener could not start.

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-tlsstart-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const logger = createLogger({ format: 'json', write: () => {} });
  return { dbPath: path.join(root, 'podium.sqlite'), app: express(), logger };
}

/** A server holding a port, so a listener that tries it gets EADDRINUSE. */
const hold = (): Promise<number> =>
  new Promise((resolve) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      cleanup.push(() => new Promise<void>((r) => s.close(() => r())));
      resolve((s.address() as { port: number }).port);
    });
  });

describe('startTlsForTest', () => {
  it('starts on a free port and reports it', async () => {
    const l = await startTlsForTest(setup());
    cleanup.push(() => new Promise<void>((r) => { l.server.closeAllConnections(); l.server.close(() => r()); }));
    expect(l.port).toBeGreaterThan(0);
    expect(l.server.listening).toBe(true);
  });

  it('retries on another port when the one it chose was taken before the bind', async () => {
    const busy = await hold();
    const free = await freePort();
    const chosen: number[] = [];
    const ports = [busy, free];
    const l = await startTlsForTest({ ...setup(), port: async () => { const p = ports.shift()!; chosen.push(p); return p; } });
    cleanup.push(() => new Promise<void>((r) => { l.server.closeAllConnections(); l.server.close(() => r()); }));
    expect(chosen).toEqual([busy, free]);
    expect(l.port).toBe(free);
  });

  it('gives up after its tries and says the port was taken', async () => {
    const busy = await hold();
    await expect(startTlsForTest({ ...setup(), port: async () => busy }, 3)).rejects.toThrow(/EADDRINUSE/);
  });

  it('fails with the reason startTls logged when the listener cannot start for another cause', async () => {
    await expect(startTlsForTest({ ...setup(), openssl: path.join(os.tmpdir(), 'podium-no-such-openssl') })).rejects.toThrow(/startTls returned null.*TLS is not started/s);
  });

  it('does not retry a failure that is not a taken port', async () => {
    let asked = 0;
    await expect(startTlsForTest({ ...setup(), openssl: path.join(os.tmpdir(), 'podium-no-such-openssl'), port: async () => { asked++; return freePort(); } })).rejects.toThrow();
    expect(asked).toBe(1);
  });
});
