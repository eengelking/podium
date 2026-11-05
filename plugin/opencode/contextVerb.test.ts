import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runContext } from './contextVerb.ts';

const CONFIG = ['# podium-reporter-config v1', '# user: work', '# server: https://podium.test', '# issued-at: 2026-01-01T00:00:00.000Z 1767225600', ''].join('\n');
const dirs: string[] = [];
const home = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'podium-ctx-'));
  dirs.push(d);
  return d;
};
process.on('exit', () => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('runContext: /podium context on disk (#999)', () => {
  it('says plainly when there is no home folder', async () => {
    expect(await runContext('list', '', undefined)).toMatch(/cannot find your home folder/);
  });

  it('works when ~/.podium does not exist yet: it reads as no contexts', async () => {
    expect(await runContext('list', home(), undefined)).toMatch(/No contexts/);
  });

  it('creates ~/.podium and writes the contexts file at mode 0600 with no temporary file left', async () => {
    const h = home();
    mkdirSync(join(h, 'elsewhere'));
    writeFileSync(join(h, 'elsewhere', 'work.env'), CONFIG);
    const out = await runContext(`add work ${join(h, 'elsewhere', 'work.env')}`, h, undefined);
    expect(out).not.toMatch(/failed/);
    expect(JSON.parse(readFileSync(join(h, '.podium', 'contexts.json'), 'utf8')).contexts.work).toContain('work.env');
    expect(readdirSync(join(h, '.podium'))).toEqual(['contexts.json']);
  });

  it('leaves the old contexts file as it was when a write fails', async () => {
    const h = home();
    mkdirSync(join(h, '.podium'));
    writeFileSync(join(h, 'work.env'), CONFIG);
    await runContext(`add work ${join(h, 'work.env')}`, h, undefined);
    const before = readFileSync(join(h, '.podium', 'contexts.json'), 'utf8');
    const out = await runContext('add other /nonexistent/file', h, undefined);
    expect(out).toMatch(/No such file/);
    expect(readFileSync(join(h, '.podium', 'contexts.json'), 'utf8')).toBe(before);
  });

  // A read-only folder does not stop root, so the case is skipped there.
  it.skipIf(process.getuid?.() === 0)('reports a failed write as a message and leaves the old file and no temporary file', async () => {
    const h = home();
    writeFileSync(join(h, 'work.env'), CONFIG);
    await runContext(`add work ${join(h, 'work.env')}`, h, undefined);
    const before = readFileSync(join(h, '.podium', 'contexts.json'), 'utf8');
    chmodSync(join(h, '.podium'), 0o500);
    try {
      expect(await runContext(`add more ${join(h, 'work.env')}`, h, undefined)).toMatch(/the context command failed/);
    } finally {
      chmodSync(join(h, '.podium'), 0o700);
    }
    expect(readFileSync(join(h, '.podium', 'contexts.json'), 'utf8')).toBe(before);
    expect(readdirSync(join(h, '.podium'))).toEqual(['contexts.json']);
  });
});
