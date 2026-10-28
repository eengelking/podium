import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openActivityDb } from '../server/src/storage/sqlite/activityDb.ts';
import { main, parseArgs, refusal, seedActivity, type SeedOptions } from './podium-seed-activity.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'podium-seed-activity-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = new Date(2026, 9, 20, 15).getTime();
// 2 sessions x (1 + 1) loops x 3 a minute x 1440 minutes = 17280 rows
const SMALL: SeedOptions = { sessions: 2, agents: 1, perMinute: 3, days: 1, batch: 400, seed: 7, now: NOW };

const dump = (dir: string): string => {
  const db = openActivityDb(path.join(dir, 'activity.sqlite'));
  const out = JSON.stringify([db.prepare('SELECT * FROM entries ORDER BY id').all(), db.prepare('SELECT * FROM stored_sessions ORDER BY session_id').all()]);
  db.close();
  return out;
};

describe('podium-seed-activity: which folder it will write', () => {
  const home = '/nowhere/home';
  it('refuses a missing --out, a file, and the server\'s real data folders', () => {
    const dir = tmp();
    const file = path.join(dir, 'a-file');
    writeFileSync(file, 'x');
    expect(refusal(undefined, false, {}, home)).toMatch(/--out/);
    expect(refusal(file, false, {}, home)).toMatch(/not a folder/);
    expect(refusal(path.join(repo, 'data'), false, {}, home)).toMatch(/real data/);
    expect(refusal(path.join(repo, 'data', 'sub'), false, {}, home)).toMatch(/real data/);
    expect(refusal(path.join(home, '.podium', 'data'), false, {}, home)).toMatch(/real data/);
    expect(refusal(dir, false, { PODIUM_DB: path.join(dir, 'podium.sqlite') }, home)).toMatch(/real data/);
    expect(refusal(dir, false, { PODIUMCTL_HOME: dir }, home)).toMatch(/real data/);
  });

  it('accepts a folder of its own, and refuses one that already holds rows unless --force', () => {
    const dir = tmp();
    expect(refusal(dir, false, {}, home)).toBeNull();
    expect(refusal(path.join(dir, 'new', 'deeper'), false, {}, home)).toBeNull();
    seedActivity(dir, { ...SMALL, days: 0.01 });
    expect(refusal(dir, false, {}, home)).toMatch(/already holds \d+ rows/);
    expect(refusal(dir, true, {}, home)).toBeNull();
  });

  it('accepts a folder whose activity.sqlite is empty', () => {
    const dir = tmp();
    openActivityDb(path.join(dir, 'activity.sqlite')).close();
    expect(refusal(dir, false, {}, home)).toBeNull();
  });
});

describe('podium-seed-activity: the rows', () => {
  it('writes the counted rows, with stored_sessions, in the shape of the feed', () => {
    const dir = tmp();
    const logs: string[] = [];
    const r = seedActivity(dir, SMALL, (l) => logs.push(l));
    expect(r.rows).toBe(17280);
    expect(r.bytes).toBeGreaterThan(0);
    expect(logs.length).toBeGreaterThan(0);
    const db = openActivityDb(path.join(dir, 'activity.sqlite'));
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    expect(n('SELECT COUNT(*) AS n FROM entries')).toBe(17280);
    expect(n('SELECT COUNT(*) AS n FROM stored_sessions')).toBe(2);
    expect(n('SELECT COUNT(DISTINCT loop) AS n FROM entries')).toBe(2);
    expect(n("SELECT COUNT(*) AS n FROM entries WHERE kind NOT IN ('tool', 'text', 'reasoning', 'podium')")).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM entries WHERE kind = 'tool'")).toBeGreaterThan(0);
    expect(n("SELECT COUNT(*) AS n FROM entries WHERE kind = 'podium' AND \"by\" IS NOT NULL AND ref IS NOT NULL")).toBeGreaterThan(0);
    expect(n("SELECT COUNT(*) AS n FROM entries WHERE text LIKE '%[redacted]%'")).toBeGreaterThan(0);
    expect(n('SELECT MAX(length(text)) AS n FROM entries')).toBeLessThanOrEqual(300);
    expect(n('SELECT COUNT(*) AS n FROM entries WHERE at > ' + NOW + ' OR at < ' + (NOW - 86_400_000))).toBe(0);
    expect(n('SELECT MAX(seq) AS n FROM entries')).toBe(1440 * 3);
    db.close();
  });

  it('gives the same rows for the same seed and different rows for another', () => {
    const a = tmp();
    const b = tmp();
    const c = tmp();
    seedActivity(a, SMALL);
    seedActivity(b, SMALL);
    seedActivity(c, { ...SMALL, seed: 8 });
    expect(dump(a)).toBe(dump(b));
    expect(dump(a)).not.toBe(dump(c));
  });

  it('replaces an earlier file instead of adding to it', () => {
    const dir = tmp();
    seedActivity(dir, { ...SMALL, days: 0.01 });
    const r = seedActivity(dir, { ...SMALL, days: 0.01 });
    const db = openActivityDb(path.join(dir, 'activity.sqlite'));
    expect((db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n).toBe(r.rows);
    db.close();
  });
});

describe('podium-seed-activity: the command line', () => {
  it('parses every option and the defaults', () => {
    expect(parseArgs([], NOW)).toMatchObject({ sessions: 100, agents: 4, perMinute: 20, days: 1, batch: 50_000, seed: 1, force: false });
    expect(parseArgs(['--out', 'x', '--sessions', '3', '--agents', '0', '--per-minute', '5', '--days', '0.5', '--batch', '10', '--seed', '9', '--force'], NOW)).toEqual({
      out: 'x', sessions: 3, agents: 0, perMinute: 5, days: 0.5, batch: 10, seed: 9, force: true, now: NOW,
    });
    expect(parseArgs(['-h'])).toBe('help');
    expect(parseArgs(['--help'])).toBe('help');
  });

  it('rejects a bad option, value or a missing value', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown option/);
    expect(() => parseArgs(['--sessions', '0'])).toThrow(/at least 1/);
    expect(() => parseArgs(['--seed', '1.5'])).toThrow(/whole number/);
    expect(() => parseArgs(['--days', '0'])).toThrow(/--days/);
    expect(() => parseArgs(['--days', 'abc'])).toThrow(/--days/);
    expect(() => parseArgs(['--out'])).toThrow(/needs a value/);
  });

  it('prints help, refuses a real data folder, and seeds a throwaway one', () => {
    const out: string[] = [];
    const err: string[] = [];
    const log = (l: string) => out.push(l);
    const bad = (l: string) => err.push(l);
    expect(main(['--help'], log, bad)).toBe(0);
    expect(out.join('\n')).toMatch(/Usage: npx tsx scripts\/podium-seed-activity.ts/);
    expect(main(['--bogus'], log, bad)).toBe(2);
    expect(err.at(-1)).toMatch(/unknown option/);
    expect(main(['--out', path.join(repo, 'data')], log, bad)).toBe(2);
    expect(err.at(-1)).toMatch(/refusing/);
    expect(main([], log, bad)).toBe(2);
    const dir = tmp();
    out.length = 0;
    expect(main(['--out', dir, '--sessions', '1', '--agents', '0', '--per-minute', '1', '--days', '0.01'], log, bad)).toBe(0);
    expect(out.join('\n')).toMatch(/wrote 14 rows for 1 sessions/);
  });
});
