import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { pgModelPrices } from './modelPrices.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';
import { BUILTIN_PRICES, type ModelUsage } from '../../fleet/pricing.js';
import type { ModelPricesApi } from '../types.js';

const M = 1_000_000;
const S = { input: 3, output: 12, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 };
const usage = (model: string, input: number, tier: ModelUsage['tier'] = 'std'): ModelUsage => ({
  model,
  tier,
  tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
});

describe.skipIf(!TEST_PG)('postgres model prices', () => {
  let td: TestDatabase;
  let db: PgDb;
  let store: ModelPricesApi;
  beforeAll(async () => {
    td = await createTestDatabase();
    db = new PgDb({ connectionString: td.url, schema: MAIN_SCHEMA, max: 4, name: 'test' });
    await migrate(db, MAIN_SCHEMA, MAIN_STEPS);
  });
  afterAll(async () => {
    await db.close();
    await td.drop();
  });
  beforeEach(async () => {
    await db.run('DELETE FROM settings');
    store = pgModelPrices(db);
  });

  it('starts with the built-in prices and nothing overridden', async () => {
    expect(await store.overrides()).toEqual({});
    expect((await store.pricing()).costOf([usage('claude-sonnet-5-5', M)])).toBeCloseTo(2, 9);
  });

  it('a saved price applies at once and survives a restart', async () => {
    expect(await store.set('sonnet-5-5', { std: S })).toBeNull();
    expect((await store.pricing()).costOf([usage('claude-sonnet-5-5', M)])).toBeCloseTo(3, 9);
    expect((await pgModelPrices(db).pricing()).costOf([usage('claude-sonnet-5-5', M)])).toBeCloseTo(3, 9);
  });

  it('saving the built-in values again stores no override', async () => {
    expect(await store.set('sonnet-5-5', { std: BUILTIN_PRICES['sonnet-5-5']!.std })).toBeNull();
    expect(await store.overrides()).toEqual({});
    expect(await db.get('SELECT COUNT(*) AS n FROM settings')).toEqual({ n: 0 });
  });

  it('reset brings the built-in price back, and resetting a row that is not overridden changes nothing', async () => {
    await store.reset('sonnet-5-5');
    expect(await db.get('SELECT COUNT(*) AS n FROM settings')).toEqual({ n: 0 });
    await store.set('sonnet-5-5', { std: S });
    await store.reset('sonnet-5-5');
    expect(await store.overrides()).toEqual({});
    expect((await store.pricing()).costOf([usage('claude-sonnet-5-5', M)])).toBeCloseTo(2, 9);
  });

  it('a model the Admin adds is priced', async () => {
    expect((await store.pricing()).costOf([usage('my-local-model', M)])).toBeNull();
    expect(await store.set('My-Local-Model', { std: S })).toBeNull();
    expect((await store.pricing()).costOf([usage('my-local-model', M)])).toBeCloseTo(3, 9);
  });

  it('the long tier can be set on a model that has one', async () => {
    expect(await store.set('haiku-5-5', { std: BUILTIN_PRICES['haiku-5-5']!.std, long: { ...S, input: 2 } })).toBeNull();
    expect((await store.pricing()).costOf([usage('claude-haiku-5-5', M, 'long')])).toBeCloseTo(2, 9);
    expect((await store.pricing()).costOf([usage('claude-haiku-5-5', M, 'std')])).toBeCloseTo(0.1, 9);
  });

  it.each([
    ['a negative price', 'sonnet-5-5', { std: { ...S, input: -1 } }],
    ['a non-number', 'sonnet-5-5', { std: { ...S, output: '1' } }],
    ['Infinity', 'sonnet-5-5', { std: { ...S, cacheRead: Infinity } }],
    ['a price over the bound', 'sonnet-5-5', { std: { ...S, output: 5000 } }],
    ['a missing std', 'sonnet-5-5', {}],
    ['an empty model id', '  ', { std: S }],
    ['a model id over 120 characters', 'x'.repeat(121), { std: S }],
    ['a control character', 'a\u0001b', { std: S }],
    ['a long tier on a model with none', 'sonnet-5-5', { std: S, long: S }],
    ['an invalid long tier', 'haiku-5-5', { std: S, long: { ...S, input: -1 } }],
  ])('rejects %s with a message and stores nothing', async (_n, key, body) => {
    expect(await store.set(key, body as never)).toMatch(/\w/);
    expect(await store.overrides()).toEqual({});
  });

  it('limits how many models the Admin can add', async () => {
    for (let i = 0; i < 100; i++) expect(await store.set(`custom-${i}`, { std: S })).toBeNull();
    expect(await store.set('custom-100', { std: S })).toMatch(/at most 100/);
  });

  it('treats inherited object names as ordinary model ids, and refuses __proto__', async () => {
    expect(await store.set('constructor', { std: S })).toBeNull();
    expect((await store.pricing()).costOf([usage('constructor', M)])).toBeCloseTo(3, 9);
    expect(await store.set('__proto__', { std: S })).toMatch(/\w/);
    expect(await store.set('prototype', { std: S })).toBeNull();
    expect(Object.getPrototypeOf(await store.overrides())).toBe(Object.prototype);
    expect(Object.keys(await store.overrides())).toEqual(['constructor', 'prototype']);
    await store.reset('constructor');
    expect(Object.keys(await store.overrides())).toEqual(['prototype']);
    await store.reset('toString');
    expect(Object.keys(await store.overrides())).toEqual(['prototype']);
  });

  it('ignores a corrupt or non-object stored value instead of failing', async () => {
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['model_prices', '{not json']);
    expect(await pgModelPrices(db).overrides()).toEqual({});
    await db.run('UPDATE settings SET value = ? WHERE key = ?', ['[1]', 'model_prices']);
    expect(await pgModelPrices(db).overrides()).toEqual({});
  });

  it('the view lists every built-in row with its effective price, and the Admin-added ones in order', async () => {
    await store.set('sonnet-5-5', { std: S });
    for (const k of ['zeta-model', 'ångström-model', 'beta-model']) await store.set(k, { std: S });
    const v = await store.view();
    const sonnet = v.models.find((m) => m.key === 'sonnet-5-5')!;
    expect(sonnet).toMatchObject({ builtin: true, overridden: true, std: S, builtinStd: BUILTIN_PRICES['sonnet-5-5']!.std });
    expect(sonnet.long).toBeUndefined();
    const haiku = v.models.find((m) => m.key === 'haiku-5-5')!;
    expect(haiku).toMatchObject({ builtin: true, overridden: false, long: BUILTIN_PRICES['haiku-5-5']!.long });
    expect(v.models.filter((m) => m.builtin).map((m) => m.key)).toEqual(Object.keys(BUILTIN_PRICES));
    expect(v.models.filter((m) => !m.builtin).map((m) => m.key)).toEqual(['ångström-model', 'beta-model', 'zeta-model']);
  });
});
