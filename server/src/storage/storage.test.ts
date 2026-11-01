import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultDbFile, openStorage } from './index.js';
import { openSqliteStorage } from './sqlite/index.js';
import { runStorageContract } from './contract.js';
import { sqliteReference } from './sqlite/contractReference.js';

runStorageContract('sqlite', () => openSqliteStorage(':memory:', 0), sqliteReference);

const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
};
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('sqlite transactions', () => {
  it('runs two concurrent tx calls one after the other and commits both', async () => {
    const s = openSqliteStorage(':memory:', 0);
    const g = gate();
    const a = s.tx(async () => {
      await s.people.log('a', 'x', 's', 1);
      await g.wait;
    });
    const b = s.tx(async () => s.people.log('b', 'x', 's', 2));
    await tick();
    g.open();
    await Promise.all([a, b]);
    expect((await s.people.listLog({})).rows.map((r) => r.kind).sort()).toEqual(['a', 'b']);
    await s.close();
  });

  it('rolls a throwing tx back fully and lets the next call run', async () => {
    const s = openSqliteStorage(':memory:', 0);
    await expect(
      s.tx(async () => {
        await s.people.log('gone', 'x', 's', 1);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await s.people.listLog({})).rows).toEqual([]);
    await s.people.log('after', 'x', 's', 2);
    expect((await s.people.listLog({})).rows.map((r) => r.kind)).toEqual(['after']);
    await s.close();
  });

  it('keeps a call from another task out of an open tx', async () => {
    const s = openSqliteStorage(':memory:', 0);
    const g = gate();
    const inTx = s.tx(async () => {
      await s.people.log('inside', 'x', 's', 1);
      await g.wait;
      throw new Error('rollback');
    });
    await tick();
    let outsideDone = false;
    const outside = s.people.log('outside', 'x', 's', 2).then(() => (outsideDone = true));
    await tick();
    expect(outsideDone).toBe(false);
    g.open();
    await expect(inTx).rejects.toThrow('rollback');
    await outside;
    expect((await s.people.listLog({})).rows.map((r) => r.kind)).toEqual(['outside']);
    await s.close();
  });

  it('lets a call inside a tx callback join it without deadlocking, and commits it', async () => {
    const s = openSqliteStorage(':memory:', 0);
    const out = await s.tx(async () => {
      await s.people.log('joined', 'x', 's', 1);
      return s.tx(async () => (await s.people.listLog({})).rows.length);
    });
    expect(out).toBe(1);
    expect((await s.people.listLog({})).rows.map((r) => r.kind)).toEqual(['joined']);
    await s.close();
  });

  it('close waits for queued work', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'podium-storage-'));
    try {
      const s = openSqliteStorage(path.join(dir, 'a', 'db.sqlite'), 0);
      const g = gate();
      const slow = s.tx(async () => {
        await g.wait;
        await s.people.log('late', 'x', 's', 1);
      });
      let closed = false;
      const closing = s.close().then(() => (closed = true));
      await tick();
      expect(closed).toBe(false);
      g.open();
      await slow;
      await closing;
      expect(closed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('openStorage', () => {
  it('opens a working in-memory SQLite storage', async () => {
    const s = await openStorage({ PODIUM_DB: ':memory:' });
    await s.people.setAdminReporting(false);
    expect(await s.people.adminReportingAllowed()).toBe(false);
    await s.close();
  });

  it('opens a temp file, with or without the sqlite:// kind', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'podium-storage-'));
    try {
      const file = path.join(dir, 'p.sqlite');
      const a = await openStorage({ PODIUM_DB: file });
      await a.people.log('k', 'd', 's', 1);
      await a.close();
      const b = await openStorage({ PODIUM_DB: `sqlite://${file}` });
      expect((await b.people.listLog({})).rows.length).toBe(1);
      await b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names an unknown kind in the error', () => {
    expect(() => openStorage({ PODIUM_DB: 'mysql://h/db' })).toThrow(/unknown storage kind "mysql".*known: sqlite, postgres/);
  });

  it('defaults to a database file under the repo data folder', () => {
    expect(defaultDbFile().split(path.sep).slice(-2)).toEqual(['data', 'podium.sqlite']);
  });
});
