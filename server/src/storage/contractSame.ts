// The comparison the contract cases share (#890, #1008): one scenario is run, call for call, over every registered adapter, and every
// value it records must come back equal on all of them. No adapter is the reference: the traces are compared pairwise, and a mismatch
// names both adapters and the step. A case that also states what a value must be in itself (the expected values written out in the
// case) catches the day every adapter is wrong the same way. The scenario records what the app would see (results, thrown messages,
// list order), so a column type, a collation or a tie order that differs between two databases fails the case that names it.
import { expect, it } from 'vitest';
import type { ContractAdapter } from './contractAdapter.js';
import type { Storage } from './types.js';

/** Records one value of a scenario's trace. Resolves with it, so a scenario can use the value it records. */
export type Rec = <T>(label: string, value: T | Promise<T>) => Promise<T>;

/** What a scenario is: calls on a storage, each result handed to `rec`. */
export type Scenario = (s: Storage, rec: Rec) => Promise<void>;

/** The adapters a case runs over: every registered kind whose server is configured. */
export interface Openers {
  adapters: ContractAdapter[];
}

/** A generated id (`prq_` or `dlv_` and 24 hex digits): random by design, so it differs between two storages and is not compared. */
const GENERATED = /^(prq|dlv)_[0-9a-f]{24}$/;

/**
 * The one list of differences between databases that are not defects (#1008): a field a database reports about its own storage is a
 * number in every database and a different one in each, so only its type is compared. A new entry needs a reason here, and is never
 * a way to make one adapter pass.
 */
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

async function trace(open: ContractAdapter['open'], scenario: Scenario): Promise<[string, unknown][]> {
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
 * Runs `scenario` over every adapter and fails on the first recorded value that differs between any two, naming both adapters and the
 * step. Resolves with the common trace (the first adapter's, equal to every other), so a case can also state what a value must be in itself.
 */
export async function sameOnAll(o: Openers, scenario: Scenario): Promise<Map<string, unknown>> {
  const traces: { name: string; trace: [string, unknown][] }[] = [];
  for (const a of o.adapters) traces.push({ name: a.name, trace: await trace(() => a.open(), scenario) });
  const [first, ...rest] = traces;
  if (!first) throw new Error('no storage adapter is registered, so there is nothing to run the contract against');
  for (const other of rest) {
    const pair = `${first.name} and ${other.name}`;
    expect(other.trace.map(([label]) => label), `the recorded steps on ${pair}`).toEqual(first.trace.map(([label]) => label));
    for (let i = 0; i < first.trace.length; i++) expect(other.trace[i]![1], `${first.trace[i]![0]} differs between ${pair}`).toEqual(first.trace[i]![1]);
  }
  return new Map(first.trace);
}

/** Registers `body` as one test per adapter, titled with the adapter's name, for a case about an adapter's own behavior in one storage. */
export function onEachAdapter(o: Openers, title: string, body: (s: Storage, adapter: string) => Promise<void>, timeout?: number): void {
  for (const a of o.adapters) {
    it(`${title} [${a.name}]`, async () => {
      const s = await a.open();
      try {
        await body(s, a.name);
      } finally {
        await s.close();
      }
    }, timeout);
  }
}
