// The Node file system behind `readTail` (#897), on real files: the rules core holds, kept where links and folders are real.
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKGROUND_TAIL_BYTES, outputTimes, readTail } from '../core/background.ts';
import { nodeOutputFs } from './outputFs.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'podium-outfs-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const tasks = path.join(dir, 'tasks');
mkdirSync(tasks);
const write = (name: string, text: string | Buffer, where = tasks) => {
  const file = path.join(where, name);
  writeFileSync(file, text);
  return file;
};

describe('readTail on real files', () => {
  it('reads a small file whole and an empty one as empty', async () => {
    expect(await readTail(nodeOutputFs, write('a.output', 'hello\nworld\n'), tasks)).toMatchObject({ ok: true, text: 'hello\nworld\n', cutAtStart: false, size: 12 });
    expect(await readTail(nodeOutputFs, write('empty.output', ''), tasks)).toMatchObject({ ok: true, text: '', size: 0 });
  });

  it('reads only the tail of a large file, never starting inside a character', async () => {
    const r = await readTail(nodeOutputFs, write('big.output', Buffer.from('é'.repeat(BACKGROUND_TAIL_BYTES))), tasks);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cutAtStart).toBe(true);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(BACKGROUND_TAIL_BYTES);
    expect(r.text.startsWith('é')).toBe(true);
  });

  it('refuses a file outside the folder, a path that climbs out, a link either way, and a folder', async () => {
    const outside = write('outside.txt', 'secret', dir);
    const real = write('real.output', 'real');
    symlinkSync(outside, path.join(tasks, 'out-link.output'));
    symlinkSync(real, path.join(tasks, 'in-link.output'));
    mkdirSync(path.join(tasks, 'sub'));
    expect(await readTail(nodeOutputFs, outside, tasks)).toEqual({ ok: false, reason: 'outside' });
    expect(await readTail(nodeOutputFs, path.join(tasks, '..', 'outside.txt'), tasks)).toEqual({ ok: false, reason: 'outside' });
    for (const name of ['out-link.output', 'in-link.output', 'sub']) expect(await readTail(nodeOutputFs, path.join(tasks, name), tasks)).toEqual({ ok: false, reason: 'not-a-file' });
  });

  it('says a missing file or folder is missing, and never throws', async () => {
    expect(await readTail(nodeOutputFs, path.join(tasks, 'gone.output'), tasks)).toEqual({ ok: false, reason: 'missing' });
    expect(await readTail(nodeOutputFs, path.join(tasks, 'a.output'), path.join(dir, 'no-such-folder'))).toEqual({ ok: false, reason: 'missing' });
  });

  it('reports a time and size without reading', async () => {
    expect(await outputTimes(nodeOutputFs, path.join(tasks, 'a.output'), tasks)).toMatchObject({ ok: true, size: 12 });
  });
});
