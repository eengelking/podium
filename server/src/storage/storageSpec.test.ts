import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { defaultDbFile, openStorage, storageSpec } from './index.js';

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
      const s = openStorage({ PODIUM_DB: v });
      expect(await s.tx(async () => 1)).toBe(1);
      await s.close();
    }
  });
});
