// The Admin's model prices on PostgreSQL (#822): only what differs from the built-in table, in the `settings` row `model_prices`.
import type { ModelPriceRow, ModelPricesView } from '../../fleet/protocol.js';
import { BUILTIN_LABELS, BUILTIN_PRICES, PRICES_AS_OF, Pricing, validatePriceSet, type ModelPrice, type PriceOverrides, type PriceSet } from '../../fleet/pricing.js';
import type { ModelPricesApi } from '../types.js';
import type { PgDb } from './conn.js';

const KEY = 'model_prices';
/** How many models the Admin can add beyond the built-in rows. */
const MAX_CUSTOM_MODELS = 100;
const MAX_KEY = 120;

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'] as const;
const same = (a: PriceSet, b: PriceSet): boolean => FIELDS.every((f) => a[f] === b[f]);

export const pgModelPrices = (db: PgDb): ModelPricesApi => {
  /** Read once and kept until a save: this store is the only writer of the setting. */
  let cached: { overrides: PriceOverrides; pricing: Pricing } | null = null;

  const load = async (): Promise<{ overrides: PriceOverrides; pricing: Pricing }> => {
    if (cached) return cached;
    const r = await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [KEY]);
    let overrides: PriceOverrides = {};
    try {
      const parsed = r ? (JSON.parse(r.value) as unknown) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) overrides = parsed as PriceOverrides;
    } catch {
      overrides = {};
    }
    cached = { overrides, pricing: new Pricing(overrides) };
    return cached;
  };

  const save = async (next: PriceOverrides): Promise<void> => {
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [KEY, JSON.stringify(next)]);
    cached = null;
  };

  return {
    overrides: async () => (await load()).overrides,
    pricing: async () => (await load()).pricing,
    async set(rawKey, body) {
      const key = rawKey.trim().toLowerCase();
      if (!key) return 'a model id is required';
      if (key.length > MAX_KEY) return `a model id must be at most ${MAX_KEY} characters`;
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(key)) return 'a model id must not contain control characters';
      if (key === '__proto__') return 'that is not a valid model id';
      const base = Object.hasOwn(BUILTIN_PRICES, key) ? BUILTIN_PRICES[key] : undefined;
      const stdErr = validatePriceSet(body?.std);
      if (stdErr) return `std: ${stdErr}`;
      if (body.long !== undefined) {
        if (!base?.long) return 'this model has no price for prompts over 100,000 tokens';
        const longErr = validatePriceSet(body.long);
        if (longErr) return `long: ${longErr}`;
      }
      return db.tx(async () => {
        const current = (await load()).overrides;
        if (!base && !Object.hasOwn(current, key) && Object.keys(current).filter((k) => !Object.hasOwn(BUILTIN_PRICES, k)).length >= MAX_CUSTOM_MODELS) {
          return `the Admin can add at most ${MAX_CUSTOM_MODELS} models`;
        }
        const row: Partial<ModelPrice> = {};
        if (!base || !same(body.std!, base.std)) row.std = body.std!;
        if (body.long && (!base?.long || !same(body.long, base.long))) row.long = body.long;
        // A Map holds the model id, so no id can reach an inherited property (CodeQL js/remote-property-injection).
        const rows = new Map(Object.entries(current));
        if (row.std || row.long) rows.set(key, row);
        else rows.delete(key);
        const next: PriceOverrides = Object.fromEntries(rows);
        if (JSON.stringify(next) !== JSON.stringify(current)) await save(next);
        return null;
      });
    },
    reset: (rawKey) =>
      db.tx(async () => {
        const key = rawKey.trim().toLowerCase();
        const current = (await load()).overrides;
        if (!Object.hasOwn(current, key)) return;
        const rows = new Map(Object.entries(current));
        rows.delete(key);
        await save(Object.fromEntries(rows));
      }),
    async view(): Promise<ModelPricesView> {
      const { overrides: o, pricing } = await load();
      const models: ModelPriceRow[] = Object.keys(BUILTIN_PRICES).map((key) => {
        const base = BUILTIN_PRICES[key]!;
        const eff = pricing.rowOf(key)!;
        return {
          key,
          label: BUILTIN_LABELS[key] ?? key,
          builtin: true,
          overridden: Object.hasOwn(o, key),
          std: eff.std,
          ...(eff.long ? { long: eff.long } : {}),
          builtinStd: base.std,
          ...(base.long ? { builtinLong: base.long } : {}),
        };
      });
      for (const key of Object.keys(o).filter((k) => !Object.hasOwn(BUILTIN_PRICES, k)).sort((a, b) => a.localeCompare(b))) {
        const eff = pricing.rowOf(key);
        if (eff) models.push({ key, label: key, builtin: false, overridden: true, std: eff.std });
      }
      return { asOf: PRICES_AS_OF, models };
    },
  };
};
