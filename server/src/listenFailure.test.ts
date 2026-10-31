// A port that is already taken stops the server (#392). Express 5's app.listen hands that error to its callback, which would log
// "listening" and leave the process running with nothing bound; the entry point listens with http.createServer(app) so the error
// stays fatal, the way it was on Express 4. This runs the real entry point on a port something else holds.
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const SERVER_DIR = path.resolve(__dirname, '..');

describe('the entry point', () => {
  it('stops with an error, and does not say it is listening, when the port is taken', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-listen-'));
    const holder = net.createServer();
    await new Promise<void>((r) => holder.listen(0, '127.0.0.1', r));
    const port = (holder.address() as net.AddressInfo).port;
    const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', PODIUM_DB: path.join(dir, 'podium.sqlite'), PODIUM_TOKEN: '' };
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER_DIR, env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    try {
      const code = await Promise.race([exited, new Promise<'still running'>((r) => setTimeout(() => r('still running'), 15_000))]);
      expect(code).not.toBe('still running');
      expect(code).not.toBe(0);
      expect(out).toContain('EADDRINUSE');
      expect(out).not.toContain('Podium server listening');
    } finally {
      child.kill('SIGKILL');
      holder.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
