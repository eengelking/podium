// The activity database over the SQLite storage (#313 stage 5a): the read-then-write sequences that were atomic while the calls
// were synchronous must stay so with every call awaited, a chunked removal must still give other callers a turn between chunks,
// and the file's lock must not be the main database's.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openSqliteStorage, type SqliteStorage } from './index.js';
import { ActivityConnection } from './activity.js';
import { openActivityDb, entryBytesSql } from './activityDb.js';
import { ActivityHistory } from './activityHistory.js';
import { SessionRecordings } from './recordings.js';
import { ACTIVITY_HISTORY_DEFAULTS, type ActivityHistorySettings } from '../../fleet/activityHistoryTypes.js';
import { MAIN_LOOP, RECORDING_DEFAULTS, type ActivityEntry, type RecordingBatch, type RecordingEntry, type RecordingSettings, type Report } from '../../fleet/protocol.js';
import { fixtureReport } from '../../fleet/testing.js';
import { session } from '../contract.js';
import type { RecordingTrail } from '../rows.js';

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const META = { name: 'billing', project: 'acme/billing', owner: 'Ed' };

const open: SqliteStorage[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Knobs {
  chunkRows?: number;
  policy?: ActivityHistorySettings['policy'];
  file?: string;
}

/** The storage with both services built the way the fleet builds them, and the memory they read. */
function world(k: Knobs = {}) {
  const storage = openSqliteStorage(k.file ?? ':memory:');
  open.push(storage);
  const s = {
    now: T0,
    flag: true,
    live: new Set(['s1', 's2']),
    agents: ['a1'],
    history: { ...ACTIVITY_HISTORY_DEFAULTS, policy: k.policy ?? ('all' as const) } as ActivityHistorySettings,
    recording: { ...RECORDING_DEFAULTS } as RecordingSettings,
  };
  const trails: RecordingTrail[] = [];
  const act = storage.activity({
    history: {
      now: () => s.now,
      settings: () => s.history,
      isLive: (id) => s.live.has(id),
      agentsOf: async () => s.agents,
      authOn: true,
      chunkRows: k.chunkRows,
    },
    recordings: {
      now: () => s.now,
      settings: () => s.recording,
      flagOn: () => s.flag,
      authOn: true,
      isLive: (id) => s.live.has(id),
      loopsOf: async () => [{ loop: MAIN_LOOP, name: 'Orchestrator' }, ...s.agents.map((a) => ({ loop: a, name: `agent ${a}` }))],
      chunkRows: k.chunkRows,
    },
  });
  act.recordings.trail = (t) => trails.push(t);
  return { storage, ...act, s, trails, db: () => (storage as SqliteStorage).activityHandle() };
}

const tool = (at: number, text = `Read f${at}`): ActivityEntry => ({ at, kind: 'tool', text });

function report(id: string, main: ActivityEntry[]): Report {
  const r = fixtureReport();
  r.session.activityFeed = true;
  r.session.id = id;
  r.session.activity = main;
  r.agents[0]!.activity = [];
  return r;
}

const entry = (seq: number, over: Partial<RecordingEntry> = {}): RecordingEntry => ({ loop: MAIN_LOOP, seq, at: T0 + seq, kind: 'tool', text: `text ${seq}`, ...over });
const batch = (...entries: RecordingEntry[]): RecordingBatch => ({ v: 1, sentAt: T0, entries });

const count = (db: DatabaseSync, sql: string, ...p: (string | number)[]): number => (db.prepare(sql).get(...p) as { n: number }).n;

/** The aggregates of the Activity history agree with the rows they summarize, and no entry is left without its session. */
function expectConsistent(db: DatabaseSync): void {
  const rows = db.prepare(`SELECT session_id AS sid, COUNT(*) AS n, SUM(${entryBytesSql()}) AS b FROM entries GROUP BY session_id`).all() as { sid: string; n: number; b: number }[];
  const kept = new Map(rows.map((r) => [r.sid, r]));
  for (const r of rows) {
    const s = db.prepare('SELECT entries, bytes FROM stored_sessions WHERE session_id = ?').get(r.sid) as { entries: number; bytes: number } | undefined;
    expect(s, `entries of ${r.sid} have a stored session`).toBeDefined();
    expect(s).toEqual({ entries: r.n, bytes: r.b });
  }
  for (const s of db.prepare('SELECT session_id AS sid, entries FROM stored_sessions').all() as { sid: string; entries: number }[]) {
    expect(s.entries, `stored session ${s.sid} holds entries`).toBeGreaterThan(0);
    expect(kept.get(s.sid)?.n).toBe(s.entries);
  }
  for (const l of db.prepare('SELECT session_id AS sid, loop, entries FROM loops').all() as { sid: string; loop: string; entries: number }[]) {
    expect(count(db, 'SELECT COUNT(*) AS n FROM entries WHERE session_id = ? AND loop = ?', l.sid, l.loop)).toBe(l.entries);
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const later = (ms: number) => new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), ms));
const gate = () => {
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  return { open, release };
};

describe('the activity file has its own lock', () => {
  it('serves the activity calls while a transaction holds the main database', async () => {
    const w = world();
    const g = gate();
    const held = w.storage.tx(() => g.open);
    expect(await Promise.race([w.history.totals(), later(300)])).toMatchObject({ entries: 0 });
    expect(await Promise.race([w.recordings.grant('s1'), later(300)])).toMatchObject({ state: 'off' });
    g.release();
    await held;
  });

  it('serves the main database while a step holds the activity file', async () => {
    const storage = openSqliteStorage(':memory:');
    open.push(storage);
    const conn = new ActivityConnection(openActivityDb(':memory:'));
    const g = gate();
    const held = conn.lock.run(() => g.open);
    expect(await Promise.race([storage.fleet.getSession('nobody'), later(300)])).toBeUndefined();
    g.release();
    await held;
    await conn.close();
  });

  it('opens the second file beside the main one, and closes both', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'podium-activity-storage-'));
    dirs.push(dir);
    const w = world({ file: path.join(dir, 'podium.sqlite') });
    expect(existsSync(path.join(dir, 'activity.sqlite'))).toBe(true);
    expect(await w.history.ingest(report('s1', [tool(T0)]), 0, META)).toBe(1);
    await w.storage.close();
    open.pop();
    const again = openActivityDb(path.join(dir, 'activity.sqlite'));
    expect(count(again, 'SELECT COUNT(*) AS n FROM entries')).toBe(1);
    again.close();
  });
});

describe('a chunked removal still gives other callers a turn between chunks', () => {
  it('lets reads and writes run between the chunks of a purge', async () => {
    const w = world({ policy: 'after', chunkRows: 2 });
    w.s.history = { ...w.s.history, policy: 'after', n: 1, unit: 'hours' };
    await w.history.ingest(report('s1', Array.from({ length: 20 }, (_, i) => tool(T0 - 5 * HOUR + i))), 0, META);
    expect((await w.history.totals()).entries).toBe(20);
    let done = false;
    const purge = w.history.purge(T0).then((r) => ((done = true), r));
    const seen: number[] = [];
    let wroteDuring = 0;
    for (let i = 0; !done; i++) {
      await tick();
      seen.push((await w.history.totals()).entries);
      // a capture for another session lands between two chunks
      const stored = await w.history.ingest(report(`n${i}`, [tool(T0 + i)]), 0, META);
      if (!done) wroteDuring += stored;
    }
    const r = await purge;
    expect(r.entries).toBe(20);
    // the purge was not one step: reads saw it part way, and captures were stored while it ran
    expect(seen.some((n) => n > 3 && n < 23)).toBe(true);
    expect(wroteDuring).toBeGreaterThan(0);
    expectConsistent(w.db());
    expect(count(w.db(), "SELECT COUNT(*) AS n FROM entries WHERE session_id = 's1'")).toBe(0);
  });

  it('lets other calls run between the chunks of a recording delete', async () => {
    const w = world({ chunkRows: 2 });
    w.recordings.noteOption('s1', true);
    expect(await w.recordings.start('s1', [MAIN_LOOP], 'Ed', META)).toBe('ok');
    expect((await w.recordings.ingest('s1', batch(...Array.from({ length: 12 }, (_, i) => entry(i + 1))), META))).toBe(12);
    let done = false;
    const removal = w.recordings.removeMany(['s1']).then((r) => ((done = true), r));
    let between = 0;
    const left: number[] = [];
    while (!done) {
      await tick();
      await w.recordings.has('s2');
      if (!done) between++;
      left.push(count(w.db(), "SELECT COUNT(*) AS n FROM rec_entries WHERE session_id = 's1'"));
    }
    expect((await removal).entries).toBe(12);
    expect(between).toBeGreaterThan(1);
    expect(left.some((n) => n > 0 && n < 12)).toBe(true);
    expect(count(w.db(), 'SELECT COUNT(*) AS n FROM rec_entries')).toBe(0);
  });

  it('lets other calls run between the chunks of a recordings purge', async () => {
    const w = world({ chunkRows: 2 });
    w.recordings.noteOption('s1', true);
    await w.recordings.start('s1', [MAIN_LOOP], 'Ed', META);
    await w.recordings.ingest('s1', batch(...Array.from({ length: 12 }, (_, i) => entry(i + 1))), META);
    w.s.now = T0 + 7 * HOUR;
    let done = false;
    const purge = w.recordings.purge().then((r) => ((done = true), r));
    let between = 0;
    while (!done) {
      await tick();
      await w.recordings.totalBytes();
      if (!done) between++;
    }
    expect((await purge).entries).toBe(12);
    expect(between).toBeGreaterThan(1);
  });

  it('stops at the next chunk when the storage closes, and leaves the totals matching the rows', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'podium-activity-close-'));
    dirs.push(dir);
    const file = path.join(dir, 'podium.sqlite');
    const w = world({ policy: 'after', chunkRows: 2, file });
    w.s.history = { ...w.s.history, policy: 'after', n: 1, unit: 'hours' };
    await w.history.ingest(report('s1', Array.from({ length: 40 }, (_, i) => tool(T0 - 5 * HOUR + i))), 0, META);
    const purge = w.history.purge(T0);
    await tick();
    await w.storage.close();
    open.pop();
    await purge;
    const again = openActivityDb(path.join(dir, 'activity.sqlite'));
    const left = count(again, 'SELECT COUNT(*) AS n FROM entries');
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(40);
    expect(count(again, 'SELECT entries AS n FROM stored_sessions')).toBe(left);
    again.close();
  });
});

describe('a deleted session against a concurrent write', () => {
  it('leaves rows and totals that agree however the writes fall between the chunks', async () => {
    for (const chunk of [1, 2, 3, 7]) {
      const w = world({ chunkRows: chunk });
      await w.history.ingest(report('s1', Array.from({ length: 12 }, (_, i) => tool(T0 + i))), 0, META);
      const gone = w.history.deleteSession('s1');
      let more = 0;
      for (let i = 0; i < 14; i++) {
        await tick();
        // the same session keeps reporting while its rows go
        more += await w.history.ingest(report('s1', [tool(T0 + 100 + i)]), 0, META);
        await w.history.ingest(report('other', [tool(T0 + 200 + i)]), 0, META);
      }
      await gone;
      expect(more).toBeGreaterThan(0);
      expectConsistent(w.db());
      expect(count(w.db(), "SELECT COUNT(*) AS n FROM entries WHERE session_id = 'other'")).toBe(14);
      await w.storage.close();
      open.pop();
    }
  });

  it('removes a recording and refuses a new one for the session until the rows are gone', async () => {
    const w = world({ chunkRows: 2 });
    w.recordings.noteOption('s1', true);
    await w.recordings.start('s1', [MAIN_LOOP], 'Ed', META);
    await w.recordings.ingest('s1', batch(...Array.from({ length: 8 }, (_, i) => entry(i + 1))), META);
    const removal = w.recordings.removeSession('s1');
    // asked after the delete began: the rows that carry the state are already gone and the new start is turned away
    const again = w.recordings.choose('s1', [MAIN_LOOP], 'Ed', META, [MAIN_LOOP]);
    const late = w.recordings.accept('s1', batch(entry(100)), META);
    expect(await again).toBe('busy');
    expect(await late).toMatchObject({ kind: 'off' });
    await removal;
    expect(count(w.db(), 'SELECT COUNT(*) AS n FROM rec_entries')).toBe(0);
    expect(count(w.db(), 'SELECT COUNT(*) AS n FROM rec_sessions')).toBe(0);
    expect(await w.recordings.choose('s1', [MAIN_LOOP], 'Ed', META, [MAIN_LOOP])).toBe('ok');
  });
});

describe('a write that lands after any one step of a removal', () => {
  /** An Activity history whose steps are plain, with a write after the `k`th one: the interleaving the lock allows between two steps. */
  function afterStep(k: number, policy: ActivityHistorySettings['policy'] = 'all') {
    const db = openActivityDb(':memory:');
    let steps = 0;
    let write: (() => void) | null = null;
    const state = { ...ACTIVITY_HISTORY_DEFAULTS, policy, ...(policy === 'after' ? { n: 1, unit: 'hours' as const } : {}) } as ActivityHistorySettings;
    const h = new ActivityHistory(db, {
      now: () => T0,
      settings: () => state,
      isLive: () => false,
      authOn: true,
      chunkRows: 2,
      step: async (fn) => {
        const out = fn();
        if (steps++ === k) write?.();
        return out;
      },
    });
    return { h, db, onStep: (w: () => void) => (write = w) };
  }

  it('keeps the totals and the rows of a deleted session in step', async () => {
    let landed = 0;
    for (let k = 0; k < 30; k++) {
      const { h, db, onStep } = afterStep(k);
      h.ingest(report('s1', Array.from({ length: 7 }, (_, i) => tool(T0 + i))), 0, META);
      onStep(() => {
        landed += h.ingest(report('s1', [tool(T0 + 1000 + k)]), 0, META);
      });
      await h.deleteSession('s1');
      expectConsistent(db);
    }
    expect(landed).toBeGreaterThan(5);
  });

  it('keeps the totals and the rows of a purge in step', async () => {
    for (let k = 0; k < 30; k++) {
      const { h, db, onStep } = afterStep(k, 'after');
      h.ingest(report('s1', Array.from({ length: 7 }, (_, i) => tool(T0 - 5 * HOUR + i))), 0, META);
      onStep(() => void h.ingest(report('s1', [tool(T0 + 1000 + k)]), 0, META));
      await h.purge(T0);
      expectConsistent(db);
    }
  });

  it('keeps the totals and the rows of a delete by filter in step', async () => {
    for (let k = 0; k < 30; k++) {
      const { h, db, onStep } = afterStep(k);
      h.ingest(report('s1', Array.from({ length: 5 }, (_, i) => tool(T0 + i))), 0, META);
      h.ingest(report('s2', Array.from({ length: 5 }, (_, i) => tool(T0 + i))), 0, META);
      onStep(() => void h.ingest(report('s1', [tool(T0 + 1000 + k)]), 0, META));
      await h.deleteBy({ all: true });
      expectConsistent(db);
    }
  });
});

describe('a purge against a concurrent write', () => {
  it('keeps what was written while old entries went, and the totals agree', async () => {
    const w = world({ policy: 'after', chunkRows: 3 });
    w.s.history = { ...w.s.history, policy: 'after', n: 1, unit: 'hours' };
    await w.history.ingest(report('s1', Array.from({ length: 24 }, (_, i) => tool(T0 - 5 * HOUR + i))), 0, META);
    const purge = w.history.purge(T0);
    let stored = 0;
    for (let i = 0; i < 10; i++) {
      await tick();
      stored += await w.history.ingest(report('s1', [tool(T0 + i, `new ${i}`)]), 0, META);
    }
    const r = await purge;
    expect(r.entries).toBe(24);
    expect(stored).toBe(10);
    expectConsistent(w.db());
    expect(count(w.db(), 'SELECT COUNT(*) AS n FROM entries')).toBe(10);
    expect(count(w.db(), 'SELECT entries AS n FROM stored_sessions WHERE session_id = ?', 's1')).toBe(10);
  });
});

describe('the consent check and the write of a recording are one step', () => {
  async function chosen() {
    const w = world();
    w.recordings.noteOption('s1', true);
    expect(await w.recordings.start('s1', [MAIN_LOOP], 'Ed', META)).toBe('ok');
    return w;
  }

  it('stores nothing when the Admin turns recording off after the batch was asked for', async () => {
    const w = await chosen();
    const pending = w.recordings.accept('s1', batch(entry(1)), META);
    w.s.flag = false;
    expect(await pending).toEqual({ kind: 'off' });
    expect(count(w.db(), 'SELECT COUNT(*) AS n FROM rec_entries')).toBe(0);
  });

  it('is what separate calls would not be: a batch asked for after a passed check is still stored when consent goes', async () => {
    const w = await chosen();
    expect(await w.recordings.acceptsUntil('s1')).toBe(Number.POSITIVE_INFINITY);
    w.s.flag = false;
    // `ingest` alone does not look at the flag, so the check and the write must not be two calls
    expect(await w.recordings.ingest('s1', batch(entry(1)), META)).toBe(1);
  });

  it('refuses a batch for a session that ended after the batch was asked for', async () => {
    const w = await chosen();
    const pending = w.recordings.accept('s1', batch(entry(1)), META);
    w.s.live.delete('s1');
    expect(await pending).toEqual({ kind: 'ended', held: true });
    expect(count(w.db(), 'SELECT COUNT(*) AS n FROM rec_entries')).toBe(0);
    expect(await w.recordings.accept('s2', batch(entry(1)), META)).toEqual({ kind: 'off' });
    w.s.live.delete('s2');
    expect(await w.recordings.accept('s2', batch(entry(1)), META)).toEqual({ kind: 'ended', held: false });
  });

  it('takes the entries before a stop and none after it, whichever way the calls are asked for', async () => {
    const w = await chosen();
    const first = w.recordings.accept('s1', batch(entry(1), entry(2)), META);
    const stop = w.recordings.stop('s1', 'Ed');
    w.s.now = T0 + 50;
    const second = w.recordings.accept('s1', batch(entry(3, { at: T0 + 500 })), META);
    expect(await first).toMatchObject({ kind: 'stored', stored: 2, before: 'recording' });
    expect(await stop).toMatchObject({ changed: true, grant: { state: 'stopped' } });
    // the entry came after the stop's time: it is dropped, and the stop is not turned into a limit
    expect(await second).toMatchObject({ kind: 'stored', stored: 0, before: 'stopped', recording: { state: 'stopped' } });
    expect(count(w.db(), "SELECT COUNT(*) AS n FROM rec_entries WHERE kind = 'tool'")).toBe(2);
    expect(count(w.db(), "SELECT COUNT(*) AS n FROM rec_entries WHERE kind = 'stopped'")).toBe(1);
    // the last interval before a stop is still taken
    expect(await w.recordings.accept('s1', batch(entry(4, { at: T0 })), META)).toMatchObject({ kind: 'stored', stored: 1 });
  });

  it('checks the loops and starts in one step: a session that ends in between is not started', async () => {
    const w = await chosen();
    const pending = w.recordings.choose('s2', [MAIN_LOOP], 'Ed', META, [MAIN_LOOP]);
    w.s.live.delete('s2');
    expect(await pending).toBe('ended');
    expect(await w.recordings.has('s2')).toBe(false);
    expect(await w.recordings.choose('s1', ['ghost'], 'Ed', META, [MAIN_LOOP])).toBe('unknown-loop');
    expect(await w.recordings.choose('s1', [MAIN_LOOP], 'Ed', META, [MAIN_LOOP])).toBe('ok');
  });

  it('removes the recordings a delete means in the step that picks them', async () => {
    const w = await chosen();
    await w.recordings.ingest('s1', batch(entry(1)), META);
    const out = await w.recordings.removeFor({ all: true });
    expect(out.each.map((e) => e.sessionId)).toEqual(['s1']);
    expect((await w.recordings.removeFor({ ids: ['s1'] })).each).toEqual([]);
  });

  it('tells the routes what the server did on its own after the step, and the routes can call back in', async () => {
    const w = await chosen();
    let reentered: Promise<boolean> | null = null;
    w.recordings.trail = (t) => {
      w.trails.push(t);
      reentered = w.recordings.has('s1');
    };
    expect(await w.recordings.stopAll('Admin')).toEqual(['s1']);
    expect(w.trails).toEqual([{ kind: 'stopped', sessionId: 's1', by: 'Admin' }]);
    expect(await reentered).toBe(true);
    // a trail that throws does not undo the stop
    w.recordings.trail = () => {
      throw new Error('log down');
    };
    w.s.now += 1;
    await w.recordings.start('s1', [MAIN_LOOP], 'Ed', META);
    expect(await w.recordings.stopAll('Admin')).toEqual(['s1']);
  });

  it('carries a recording over to the session a /clear made, with the trail', async () => {
    const w = await chosen();
    w.s.live.add('s3');
    expect(await w.recordings.carryOver('s1', 's3', META)).toBe(true);
    expect(w.trails).toEqual([{ kind: 'carried', sessionId: 's3', from: 's1', by: 'Ed' }]);
  });
});

describe('a session that is not in the main database any more', () => {
  it('keeps the activity of one that came back between the two looks', async () => {
    const w = world();
    await w.history.ingest(report('s1', [tool(T0), tool(T0 + 1)]), 0, META);
    await w.history.ingest(report('s2', [tool(T0)]), 0, META);
    const asked: string[] = [];
    // `s1` is missing at the first look and back at the second; `s2` stays missing
    let back = false;
    const exists = async (id: string) => {
      asked.push(id);
      if (id === 's1' && asked.filter((a) => a === 's1').length > 1) back = true;
      return back && id === 's1';
    };
    expect(await w.history.dropMissingSessions(exists)).toBe(1);
    expect(count(w.db(), "SELECT COUNT(*) AS n FROM entries WHERE session_id = 's1'")).toBe(2);
    expect(count(w.db(), "SELECT COUNT(*) AS n FROM entries WHERE session_id = 's2'")).toBe(0);
    expectConsistent(w.db());
    expect(await w.history.dropMissingSessions(async () => true)).toBe(0);
  });

  it('keeps the recording of one that came back between the two looks', async () => {
    const w = world();
    w.recordings.noteOption('s1', true);
    await w.recordings.start('s1', [MAIN_LOOP], 'Ed', META);
    await w.recordings.ingest('s1', batch(entry(1)), META);
    let looks = 0;
    expect(await w.recordings.dropMissingSessions(async () => ++looks > 1)).toBe(0);
    expect(await w.recordings.has('s1')).toBe(true);
    expect(await w.recordings.dropMissingSessions(async () => false)).toBe(1);
    expect(await w.recordings.has('s1')).toBe(false);
    expect(await w.recordings.dropMissingSessions(async () => false)).toBe(0);
  });
});

describe('what the server read from the main database answers as the synchronous read did', () => {
  it('lists the orchestrator and the agents to watch', async () => {
    const w = world();
    const direct = new ActivityHistory(openActivityDb(':memory:'), { now: () => T0, settings: () => w.s.history, isLive: () => false, agentsOf: () => w.s.agents, authOn: true });
    expect(await w.history.loopsToWatch('s1')).toEqual(direct.loopsToWatch('s1'));
    w.s.agents = [];
    expect(await w.history.loopsToWatch('s1')).toEqual(direct.loopsToWatch('s1'));
    expect(await w.history.loopsToWatch('s1')).toEqual([MAIN_LOOP]);
  });

  it('gives the same consent, view, loops, pages and lists through the adapter as through the class', async () => {
    const w = world();
    const live = new Set(['s1']);
    const direct = new SessionRecordings(openActivityDb(':memory:'), {
      now: () => w.s.now,
      settings: () => w.s.recording,
      flagOn: () => w.s.flag,
      authOn: true,
      isLive: (id) => live.has(id),
      loopsOf: () => [{ loop: MAIN_LOOP, name: 'Orchestrator' }, ...w.s.agents.map((a) => ({ loop: a, name: `agent ${a}` }))],
    });
    w.s.live = live;
    for (const r of [w.recordings, direct] as const) r.noteOption('s1', true);
    const cases: ((r: typeof direct | typeof w.recordings) => unknown)[] = [
      (r) => r.grant('s1'),
      (r) => r.view('s1'),
      (r) => r.loopInfo('s1'),
      (r) => r.start('s1', [MAIN_LOOP, 'a1'], 'Ed', META),
      (r) => r.ingest('s1', batch(entry(1), entry(2, { loop: 'a1' }), entry(3)), META),
      (r) => r.grant('s1'),
      (r) => r.view('s1'),
      (r) => r.loopInfo('s1'),
      (r) => r.page('s1', null, 10, null),
      (r) => r.page('s1', null, 10, 'a1'),
      (r) => r.totals(),
      (r) => r.adminList({ page: 1, pageSize: 10 }),
      (r) => r.listStored({}, 1, 10),
      (r) => r.has('s1'),
      (r) => r.stateFor('s1'),
      (r) => r.keptUntilOf('s1'),
      (r) => r.acceptsUntil('s1'),
      (r) => r.capturing('s1'),
      (r) => r.totalBytes(),
      (r) => r.stop('s1', 'Ed'),
      (r) => r.acceptsUntil('s1'),
      (r) => r.grant('s1'),
    ];
    for (const run of cases) expect(await run(w.recordings)).toEqual(await run(direct));
  });
});

describe('a Podium entry for a session', () => {
  it('is stored, updated and taken back through the adapter as through the class', async () => {
    const w = world();
    const direct = new ActivityHistory(openActivityDb(':memory:'), { now: () => T0, settings: () => w.s.history, isLive: () => false, authOn: true });
    const e = { at: T0, text: 'rerun the tests', by: 'Ed', note: null };
    await w.history.addPodium('s1', MAIN_LOOP, 'ref1', e, META);
    direct.addPodium('s1', MAIN_LOOP, 'ref1', e, META);
    await w.history.updatePodium('s1', 'ref1', 'queued');
    direct.updatePodium('s1', 'ref1', 'queued');
    expect(await w.history.page('s1', MAIN_LOOP, null)).toEqual(direct.page('s1', MAIN_LOOP, null));
    expect(await w.history.note('s1', MAIN_LOOP)).toEqual(direct.note('s1', MAIN_LOOP));
    await w.history.removePodium('s1', 'ref1');
    direct.removePodium('s1', 'ref1');
    expect(await w.history.totals()).toEqual(direct.totals());
    expectConsistent(w.db());
    expect(await w.history.deleteSession('nobody')).toEqual({ entries: 0, sessions: 0, bytes: 0, freed: 0 });
  });
});

describe('the main database is untouched by the activity file', () => {
  it('keeps its own rows when the activity connection is busy', async () => {
    const w = world();
    await w.storage.fleet.upsertSession(session());
    await w.history.ingest(report('s1', [tool(T0)]), 0, META);
    expect((await w.storage.fleet.getSession('s1'))?.id).toBe('s1');
    expect(count(w.storage.sqliteHandle, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('entries', 'rec_sessions', 'loops')")).toBe(0);
  });
});
