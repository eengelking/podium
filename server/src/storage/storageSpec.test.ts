import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { openSqliteStorage } from './sqlite/index.js';
import { dataDir, defaultDbFile, openStorage, registerStorageKind, storageSpec } from './index.js';

describe('which storage PODIUM_DB names', () => {
  it('is a SQLite file at <repo>/data/podium.sqlite when unset or empty', () => {
    expect(storageSpec({})).toEqual({ kind: 'sqlite', target: defaultDbFile() });
    expect(storageSpec({ PODIUM_DB: '' }).target).toBe(defaultDbFile());
    expect(defaultDbFile().endsWith(path.join('data', 'podium.sqlite'))).toBe(true);
  });

  it('keeps a plain path and :memory: exactly as given', () => {
    expect(storageSpec({ PODIUM_DB: '/data/podium.sqlite' })).toEqual({ kind: 'sqlite', target: '/data/podium.sqlite' });
    expect(storageSpec({ PODIUM_DB: 'rel/dir/x.db' }).target).toBe('rel/dir/x.db');
    expect(storageSpec({ PODIUM_DB: ':memory:' })).toEqual({ kind: 'sqlite', target: ':memory:' });
  });

  it('strips the scheme from sqlite://, so paths derived from it match the plain form', () => {
    expect(storageSpec({ PODIUM_DB: 'sqlite:///data/podium.sqlite' })).toEqual({ kind: 'sqlite', target: '/data/podium.sqlite' });
    expect(storageSpec({ PODIUM_DB: 'sqlite://:memory:' }).target).toBe(':memory:');
  });

  it('refuses a kind nobody registered, naming the ones that exist', () => {
    expect(() => storageSpec({ PODIUM_DB: 'bogus://x' })).toThrow('PODIUM_DB: unknown storage kind "bogus" (known: sqlite)');
    expect(() => openStorage({ PODIUM_DB: 'postgres://h/db' })).toThrow(/unknown storage kind "postgres"/);
  });

  it('opens a SQLite storage for :memory: and for sqlite://:memory:', async () => {
    for (const v of [':memory:', 'sqlite://:memory:']) {
      const s = await openStorage({ PODIUM_DB: v });
      expect(await s.tx(async () => 1)).toBe(1);
      await s.close();
    }
  });
});

describe('the data directory', () => {
  it('is the folder of the SQLite file when PODIUM_DATA_DIR is not set, as before', () => {
    expect(dataDir({ PODIUM_DB: '/data/podium.sqlite' })).toBe('/data');
    expect(dataDir({ PODIUM_DB: 'sqlite:///repo/data/podium.sqlite' })).toBe('/repo/data');
    expect(dataDir({ PODIUM_DB: 'rel/dir/x.db' })).toBe('rel/dir');
    expect(dataDir({ PODIUM_DB: ':memory:' })).toBe('.');
    expect(dataDir({ PODIUM_DB: '', PODIUM_DATA_DIR: '' })).toBe(path.dirname(defaultDbFile()));
  });

  it('is PODIUM_DATA_DIR when set, whatever the database target is', () => {
    expect(dataDir({ PODIUM_DB: '/data/podium.sqlite', PODIUM_DATA_DIR: '/srv/podium' })).toBe('/srv/podium');
    expect(dataDir({ PODIUM_DATA_DIR: '/srv/podium' })).toBe('/srv/podium');
  });

  it('is required for a kind whose target is not a file', () => {
    const off = registerStorageKind('fakedb', { fileBased: false, load: async () => () => { throw new Error('not opened'); } });
    try {
      expect(() => dataDir({ PODIUM_DB: 'fakedb://h/db' })).toThrow('PODIUM_DATA_DIR is required when PODIUM_DB is fakedb://...');
      expect(dataDir({ PODIUM_DB: 'fakedb://h/db', PODIUM_DATA_DIR: '/srv/podium' })).toBe('/srv/podium');
    } finally { off(); }
  });
});

describe('loading an adapter only when its kind is chosen', () => {
  it('does not call a registered kind\'s loader for a database that names another kind', async () => {
    let loaded = 0;
    const off = registerStorageKind('lazydb', { fileBased: false, load: async () => { loaded++; return () => openSqliteStorage(':memory:'); } });
    try {
      expect(storageSpec({ PODIUM_DB: 'lazydb://h/db' }).kind).toBe('lazydb');
      await (await openStorage({ PODIUM_DB: ':memory:' })).close();
      expect(loaded).toBe(0);
      await (await openStorage({ PODIUM_DB: 'lazydb://h/db' })).close();
      expect(loaded).toBe(1);
    } finally { off(); }
  });

  it('fails an unknown kind before any loader runs, with the same message', () => {
    let loaded = 0;
    const off = registerStorageKind('lazydb', { fileBased: false, load: async () => { loaded++; return () => openSqliteStorage(':memory:'); } });
    try {
      expect(() => openStorage({ PODIUM_DB: 'bogus://x' })).toThrow('PODIUM_DB: unknown storage kind "bogus" (known: sqlite, lazydb)');
      expect(loaded).toBe(0);
    } finally { off(); }
  });
});
