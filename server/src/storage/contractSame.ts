// The comparison the contract cases for the stores without a synchronous reference share (#890): one scenario is run, call for
// call, over the adapter under test and over a second, reference storage, and every value it records must come back equal. The
// scenario records what the app would see (results, thrown messages, list order), so a column type, a collation or a tie order that
// differs between two databases fails the case that names it, and not a screen.
import { expect } from 'vitest';
import type { Storage } from './types.js';

/** Records one value of a scenario's trace. Resolves with it, so a scenario can use the value it records. */
export type Rec = <T>(label: string, value: T | Promise<T>) => Promise<T>;

/** What a scenario is: calls on a storage, each result handed to `rec`. */
export type Scenario = (s: Storage, rec: Rec) => Promise<void>;

/** The opening functions a case compares: the adapter under test, and the reference storage that gives the reference answers. */
export interface Openers {
  open: () => Storage | Promise<Storage>;
  referenceStorage: () => Storage | Promise<Storage>;
}

/** A generated id (`prq_` or `dlv_` and 24 hex digits): random by design, so it differs between two storages and is not compared. */
const GENERATED = /^(prq|dlv)_[0-9a-f]{24}$/;

/** What a database reports about its own file (`fileBytes`, `freed`): a number in every database and a different one in each, so only its type is compared. */
const PHYSICAL = new Set(['fileBytes', 'freed']);

/** Replaces generated ids with `<id>`, wherever they sit in a recorded value. Everything else is compared as it is. */
function scrub(v: unknown): unknown {
  if (typeof v === 'string') return GENERATED.test(v) ? '<id>' : v;
  if (Array.isArray(v)) return v.map(scrub);
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, scrub(x)]));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, PHYSICAL.has(k) ? typeof x : scrub(x)]));
  return v;
}

/** A thrown error is part of the trace as its message, so an adapter that throws something else, or nothing, fails the case. */
async function settle<T>(value: T | Promise<T>): Promise<T | { threw: string }> {
  try {
    return await value;
  } catch (e) {
    return { threw: e instanceof Error ? e.message : String(e) };
  }
}

async function trace(open: () => Storage | Promise<Storage>, scenario: Scenario): Promise<[string, unknown][]> {
  const s = await open();
  const out: [string, unknown][] = [];
  try {
    await scenario(s, async (label, value) => {
      const v = await settle(value);
      out.push([label, scrub(v)]);
      return v as never;
    });
  } finally {
    await s.close();
  }
  return out;
}

/**
 * Runs `scenario` over both storages and fails on the first recorded value that differs, naming it. Resolves with the adapter's trace
 * so a case can also state what a value must be in itself, which a pair of equal wrong answers would not catch.
 */
export async function sameOnBoth(o: Openers, scenario: Scenario): Promise<Map<string, unknown>> {
  const got = await trace(o.open, scenario);
  const want = await trace(o.referenceStorage, scenario);
  expect(got.map(([label]) => label), 'the recorded steps').toEqual(want.map(([label]) => label));
  for (let i = 0; i < got.length; i++) expect(got[i]![1], `${got[i]![0]}`).toEqual(want[i]![1]);
  return new Map(got);
}
