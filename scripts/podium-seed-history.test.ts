import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/src/fleet/db.ts';
import { openSqliteStorage } from '../server/src/storage/sqlite/index.ts';
import { projectionReport, runReport, type ReportDeps } from '../server/src/fleet/reports.ts';
import { DEFAULT_CONFIG } from '../server/src/fleet/fleet.ts';
import { Pricing } from '../server/src/fleet/pricing.ts';
import { main, parseArgs, protectedFolders, refusal, seedHistory } from './podium-seed-history.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'podium-seed-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TODAY = '2026-10-20';
const NOW = new Date(2026, 9, 20, 15).getTime();
const tables = ['usage_daily', 'sessions_daily', 'failures_daily', 'fleet_daily'];
const dump = (file: string): string => {
  const db = openDb(file);
  const out = JSON.stringify(tables.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3, 4, 5`).all()));
  db.close();
  return out;
};
const deps = (file: string): ReportDeps => ({ db: openSqliteStorage(file).fleet, now: () => NOW, pricing: () => new Pricing({}), retention: DEFAULT_CONFIG.retention });

describe('podium-seed-history: which database it will write', () => {
  const home = '/nowhere/home';
  it('refuses a missing --db, a memory database, a folder and the server\'s real databases', () => {
    const dir = tmp();
    expect(refusal(undefined, {}, home)).toMatch(/--db/);
    expect(refusal(':memory:', {}, home)).toMatch(/memory/);
    expect(refusal(dir, {}, home)).toMatch(/folder/);
    expect(refusal(path.join(repo, 'data', 'podium.sqlite'), {}, home)).toMatch(/real database/);
    expect(refusal(path.join(repo, 'data', 'podium.sqlite-wal'), {}, home)).toMatch(/real database/);
    expect(refusal(path.join(repo, 'data', 'other.db'), {}, home)).toMatch(/real data/);
    expect(refusal(path.join(home, '.podium', 'data', 'podium.sqlite'), {}, home)).toMatch(/real database/);
    expect(refusal(path.join(home, '.podium', 'anything.db'), {}, home)).toMatch(/real data/);
    expect(refusal(path.join(dir, 'live.db'), { PODIUM_DB: path.join(dir, 'live.db') }, home)).toMatch(/real database/);
    expect(refusal(path.join(dir, 'live.db'), { PODIUMCTL_HOME: dir }, home)).toMatch(/real data/);
  });

  it('refuses the database podiumctl\'s config names, and a link to a real one', () => {
    const dir = tmp();
    const podiumHome = path.join(dir, 'ctl');
    mkdirSync(podiumHome);
    writeFileSync(path.join(podiumHome, 'config.env'), `PODIUM_TOKEN=x\nPODIUM_DB="${path.join(dir, 'mine.db')}"\n`);
    expect(protectedFolders({ PODIUMCTL_HOME: podiumHome }, home).files).toContain(path.join(dir, 'mine.db'));
    expect(refusal(path.join(dir, 'mine.db'), { PODIUMCTL_HOME: podiumHome }, home)).toMatch(/real database/);
    expect(refusal(path.join(dir, 'ok.db'), { PODIUMCTL_HOME: podiumHome }, home)).toBeNull();
  });

  it('accepts a file of its own anywhere else', () => {
    expect(refusal(path.join(tmp(), 'throwaway.db'), {}, home)).toBeNull();
    expect(refusal(path.join(tmp(), 'missing-folder', 'x.db'), {}, home)).toBeNull();
  });
});

describe('podium-seed-history: arguments', () => {
  it('reads the options, with today by default', () => {
    expect(parseArgs(['--db', 'x.db'], NOW)).toEqual({ db: 'x.db', days: 45, seed: 1, today: TODAY });
    expect(parseArgs(['--db', 'x.db', '--days', '60', '--seed', '7', '--today', '2026-03-01'], NOW)).toEqual({ db: 'x.db', days: 60, seed: 7, today: '2026-03-01' });
    expect(parseArgs(['-h'])).toBe('help');
    expect(parseArgs(['--help'])).toBe('help');
  });

  it('rejects what it cannot use', () => {
    for (const bad of [['--bogus'], ['--db'], ['--days', '3'], ['--days', 'x'], ['--days', '400'], ['--seed', '-1'], ['--today', '2026-02-30'], ['--today', 'soon']]) expect(() => parseArgs(bad)).toThrow();
  });
});

describe('podium-seed-history: the history', () => {
  it('is the same for a seed and different for another', () => {
    const [a, b, c] = [1, 1, 2].map((seed) => {
      const f = path.join(tmp(), 'h.db');
      seedHistory(f, { days: 45, seed, today: TODAY });
      return dump(f);
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('covers 45 days ending yesterday and can be run again over itself', () => {
    const f = path.join(tmp(), 'h.db');
    const r = seedHistory(f, { days: 45, seed: 1, today: TODAY });
    expect(r).toMatchObject({ days: 45, people: 6, adminLog: 18 });
    const first = dump(f);
    seedHistory(f, { days: 45, seed: 1, today: TODAY });
    expect(dump(f)).toBe(first);
    const db = openDb(f);
    expect(db.prepare('SELECT MIN(day) AS a, MAX(day) AS b, COUNT(*) AS n FROM fleet_daily').get()).toEqual({ a: '2026-09-05', b: '2026-10-19', n: 45 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_log WHERE source = 'seed-history'").get()).toEqual({ n: 18 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM people').get()).toEqual({ n: 6 });
    db.close();
  });

  it('has the cases the Reporting pages need to show', () => {
    const f = path.join(tmp(), 'h.db');
    seedHistory(f, { days: 45, seed: 1, today: TODAY });
    const db = openDb(f);
    const n = (sql: string) => Object.values(db.prepare(sql).get() as Record<string, number>)[0];
    // One person on two days only, one who never reported, and a model with no price whose cost stays out.
    expect(n("SELECT COUNT(DISTINCT day) FROM usage_daily WHERE owner = 'Sam'")).toBe(2);
    expect(n("SELECT COUNT(*) FROM usage_daily WHERE owner = 'Lena'")).toBe(0);
    expect(n("SELECT COUNT(*) FROM usage_daily WHERE model = 'local-llama-3' AND (cost_usd != 0 OR unpriced_sessions != sessions)")).toBe(0);
    expect(n("SELECT COUNT(*) FROM usage_daily WHERE model = 'local-llama-3'")).toBeGreaterThan(0);
    // Failures across classes and tools, agent-heavy days, a spread of versions.
    expect(n('SELECT COUNT(DISTINCT class) FROM failures_daily')).toBeGreaterThanOrEqual(3);
    expect(n('SELECT COUNT(DISTINCT tool) FROM failures_daily')).toBeGreaterThanOrEqual(3);
    expect(n('SELECT COUNT(*) FROM (SELECT day FROM usage_daily GROUP BY day HAVING SUM(agents) >= 8 * SUM(sessions) * 0.7 AND SUM(agents) >= 20)')).toBeGreaterThanOrEqual(2);
    const versions = new Set((db.prepare('SELECT reporter_versions_json AS j FROM fleet_daily').all() as { j: string }[]).flatMap((r) => Object.keys(JSON.parse(r.j))));
    expect(versions.size).toBeGreaterThanOrEqual(3);
    expect(n("SELECT COUNT(DISTINCT kind) FROM admin_log WHERE source = 'seed-history'")).toBeGreaterThan(5);
    // Rollups hold no content: only counts, tokens, cost and names.
    expect(JSON.stringify(tables.map((t) => db.prepare(`SELECT * FROM ${t}`).all()))).not.toMatch(/prompt|answer|\/Users/);
    db.close();
  });

  it('keeps the people and groups that are already there', () => {
    const f = path.join(tmp(), 'h.db');
    const db = openDb(f);
    const ids = db.prepare("INSERT INTO groups (name, name_lower, created_at) VALUES ('Backend', 'backend', 1)").run();
    db.close();
    seedHistory(f, { days: 20, seed: 3, today: TODAY });
    const after = openDb(f);
    expect(after.prepare("SELECT COUNT(*) AS n FROM groups WHERE name = 'Backend'").get()).toEqual({ n: 1 });
    expect(after.prepare("SELECT group_id AS g FROM people WHERE name = 'Priya'").get()).toEqual({ g: Number(ids.lastInsertRowid) });
    after.close();
  });

  it('feeds the reports: a projection with Sam marked "not enough history", and the long-period reports', async () => {
    const f = path.join(tmp(), 'h.db');
    seedHistory(f, { days: 45, seed: 1, today: TODAY });
    const d = deps(f);
    const p = await projectionReport(d, {});
    expect(p.historyDays).toBe(14);
    expect(p.rows.find((r) => r.key === 'Sam')).toMatchObject({ projected: null, reason: 'history' });
    expect(p.rows.find((r) => r.key === 'Ed')!.projected).toBeGreaterThan(0);
    expect(p.rows.find((r) => r.key === 'Lena')).toBeUndefined();
    const usage = await runReport(d, 'usage', { from: '2026-09-05', to: TODAY, by: 'week' });
    expect(usage).toMatchObject({ partial: false, oldestDay: '2026-09-05' });
    expect(usage.rows.length).toBeGreaterThanOrEqual(6);
    const spend = await runReport(d, 'spend', { breakdown: 'model', by: 'month', from: '2026-09-05', to: TODAY });
    expect(spend.rows.find((r) => r.key === 'local-llama-3')).toMatchObject({ costUsd: null });
    expect((await runReport(d, 'people', {})).rows.find((r) => r.person === 'Lena')).toMatchObject({ state: 'never' });
    expect((await runReport(d, 'activity', { from: '2026-09-05', to: TODAY })).rows.length).toBe(18);
  });
});

describe('podium-seed-history: the command line', () => {
  const run = (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(argv, (l) => out.push(l), (l) => err.push(l));
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('prints its help, which says it refuses a real database', () => {
    const r = run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('--db PATH');
    expect(r.out).toMatch(/must not be the\s+server's real database/);
  });

  it('exits 2 with a reason for bad options and for a database it must not write', () => {
    expect(run(['--days', '1']).code).toBe(2);
    const none = run([]);
    expect(none.code).toBe(2);
    expect(none.err).toMatch(/--db/);
    const real = run(['--db', path.join(repo, 'data', 'podium.sqlite')]);
    expect(real.code).toBe(2);
    expect(real.err).toMatch(/refusing/);
  });

  it('seeds the file it was given and says where to run a server on it', () => {
    const f = path.join(tmp(), 'run.db');
    const r = run(['--db', f, '--today', TODAY]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(f);
    expect(r.out).toMatch(/PODIUM_DB=/);
    expect(dump(f)).toContain('Sam');
  });
});
