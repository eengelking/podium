// The differential test (#1008): the same randomly chosen and edge-case calls go through every registered adapter, and what each one does
// (the result, whether and how it threw, the order of a list) must be the same on all of them. No adapter is the reference; a mismatch names
// the adapters that disagree. The seed is printed and replays the run (`PODIUM_DIFF_SEED=<n>`); a failing program is shrunk to the fewest
// steps that still disagree and printed with its inputs.
//
// A target is one store call with a generator for its arguments. The inputs are the ones a hand-written scenario does not think of: numbers
// that are fractional, huge, negative or NaN, strings that are empty, very long, hold NUL or control characters or a lone surrogate, and
// letters whose case or sort order differs between databases. A method added to `types.ts` is not ignored: `contractMethods.ts` lists every
// method, and the guard in `adapters.test.ts` fails for one that no case or target calls.
import { describe, expect, it } from 'vitest';
import { PeopleError } from './rows.js';
import { session } from './contract.js';
import { onEachAdapter, sameOnAll, type Openers } from './contractSame.js';
import type { Storage } from './types.js';

/** A small seeded generator (mulberry32): the same seed gives the same program on every machine. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

/** Numbers a database may treat differently: fractions, the edges of 32 and 53 bits, signs, NaN and the infinities. */
export const EDGE_NUMBERS: readonly number[] = [
  0, 1, -1, 2, 1.5, -1.5, 0.1, 1e-7, 2 ** 31 - 1, 2 ** 31, -(2 ** 31) - 1, 2 ** 32, 2 ** 53 - 1, 2 ** 53, 1e15 + 0.5, 1e21, Number.MAX_VALUE, Number.MIN_VALUE, -0, Number.NaN, Infinity, -Infinity,
];

/** Strings a database may store, compare or sort differently. */
export const EDGE_STRINGS: readonly string[] = [
  '', ' ', 'a', 'A', 'a b', 'a  b', 'a\0b', '\0', 'a\tb\nc\r', '\u0001\u001f\u007f', '\ud800', 'x\udc00y', '😀', 'é', 'é', 'İ', 'i', 'I', 'ı', 'ß', 'SS', 'ǅ', 'ǆ', 'Σ', 'ς', 'σ',
  'résumé', 'Zebra', 'apple', 'Apple', '_a', '%', 'a%b', "o'brien", '"q"', '\\', 'x'.repeat(1000), 'y'.repeat(70_000), '日本語',
];

const num = (r: Rand): number => (r() < 0.5 ? pick(r, EDGE_NUMBERS) : Math.floor(r() * 2000));
const int = (r: Rand): number => (r() < 0.5 ? pick(r, [0, 1, 2, 3, 100, -1]) : Math.floor(r() * 50));
const str = (r: Rand): string => (r() < 0.6 ? pick(r, EDGE_STRINGS) : `s${Math.floor(r() * 6)}`);
const key = (r: Rand): string => `k${Math.floor(r() * 4)}`;
const ID = ['s1', 's2', 's3', 'S1'] as const;
const id = (r: Rand): string => (r() < 0.2 ? str(r) : pick(r, ID));

export interface Target {
  name: string;
  /** Arguments for one call. */
  args(r: Rand): unknown[];
  run(s: Storage, args: unknown[]): unknown;
}

/** The calls the program is made of. Every one takes only values a caller can send, so a divergence here is a divergence a screen can reach. */
export const TARGETS: readonly Target[] = [
  { name: 'people.log', args: (r) => [str(r), str(r), str(r), num(r), r() < 0.5 ? str(r) : null], run: (s, a) => s.people.log(...(a as [string, string, string, number, string | null])) },
  { name: 'people.listLog', args: (r) => [{ page: int(r), pageSize: pick(r, [0, 1, 2, 5, 1000, -1]) }], run: (s, a) => s.people.listLog(a[0] as { page: number; pageSize: number }) },
  { name: 'people.createGroup', args: (r) => [str(r), num(r)], run: (s, a) => s.people.createGroup(a[0] as string, a[1] as number) },
  { name: 'people.allGroups', args: () => [], run: (s) => s.people.allGroups() },
  { name: 'people.createPerson', args: (r) => [str(r), r() < 0.5 ? null : int(r), num(r)], run: (s, a) => s.people.createPerson(a[0] as string, a[1] as number | null, a[2] as number) },
  { name: 'people.findByName', args: (r) => [str(r)], run: (s, a) => s.people.findByName(a[0] as string) },
  { name: 'fleet.upsertSession', args: (r) => [{ id: id(r), name: str(r), cwd: str(r), model: r() < 0.3 ? null : str(r), started_at: num(r), last_seen_at: num(r), cost_usd: r() < 0.3 ? null : num(r), tok_in: int(r) }], run: (s, a) => s.fleet.upsertSession(session(a[0] as object)) },
  { name: 'fleet.getSession', args: (r) => [id(r)], run: (s, a) => s.fleet.getSession(a[0] as string) },
  { name: 'fleet.liveCandidates', args: (r) => [num(r)], run: (s, a) => s.fleet.liveCandidates(a[0] as number) },
  { name: 'fleet.endedBetween', args: (r) => [num(r), num(r)], run: (s, a) => s.fleet.endedBetween(a[0] as number, a[1] as number) },
  { name: 'fleet.setDropped', args: (r) => [id(r), num(r)], run: (s, a) => s.fleet.setDropped(a[0] as string, a[1] as number) },
  { name: 'fleet.deleteSession', args: (r) => [id(r)], run: (s, a) => s.fleet.deleteSession(a[0] as string) },
  { name: 'fleet.costSince', args: (r) => [num(r)], run: (s, a) => s.fleet.costSince(a[0] as number) },
  { name: 'fleet.spendTotals', args: (r) => [num(r)], run: (s, a) => s.fleet.spendTotals(a[0] as number) },
  { name: 'fleet.groupOfOwner', args: (r) => [r() < 0.2 ? null : str(r)], run: (s, a) => s.fleet.groupOfOwner(a[0] as string | null) },
  {
    name: 'reporters.record',
    args: (r) => [{ kind: pick(r, ['mod', 'hooks'] as const), machineId: r() < 0.3 ? null : key(r), machineName: r() < 0.3 ? null : str(r), source: str(r), owner: r() < 0.3 ? null : str(r), credential: 'person', version: str(r), engineVersion: null, sessionId: id(r) }, num(r)],
    run: (s, a) => s.reporters.record(a[0] as never, a[1] as number),
  },
  { name: 'reporters.list', args: (r) => [{}, num(r)], run: (s, a) => s.reporters.list(a[0] as never, a[1] as number) },
  { name: 'featureFlags.setFeature', args: (r) => [str(r), r() < 0.5], run: (s, a) => s.featureFlags.setFeature(a[0] as string, a[1] as boolean) },
  { name: 'featureFlags.featureOn', args: (r) => [str(r)], run: (s, a) => s.featureFlags.featureOn(a[0] as string) },
];

export interface Step { target: string; args: unknown[] }

/** `length` calls chosen from the targets by the seed. */
export function program(seed: number, length: number): Step[] {
  const r = rng(seed);
  return Array.from({ length }, () => {
    const t = pick(r, TARGETS);
    return { target: t.name, args: t.args(r) };
  });
}

/** Renders a value for a report, keeping what JSON hides: NaN, the infinities, -0, undefined and a lone surrogate. */
export function show(v: unknown): string {
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
  if (typeof v === 'string') return JSON.stringify(v.length > 60 ? `${v.slice(0, 40)}…(${v.length} chars)` : v);
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `[${v.map(show).join(', ')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${k}: ${show(x)}`).join(', ')}}`;
  return String(v);
}

/** What an error is, apart from the database's own wording: the app's own classes keep their name and code; any other is a database error. */
function errorClass(e: unknown): string {
  if (e instanceof PeopleError) return `PeopleError:${e.code}`;
  return e instanceof Error ? 'DatabaseError' : 'thrown';
}

/** Random values a database makes up (tokens, key ids, generated ids) cannot be compared. */
const RANDOM_KEYS = new Set(['token', 'tokenHash', 'keyId', 'key_id', 'token_hash']);
function norm(v: unknown): unknown {
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : Number.isNaN(v) ? 'NaN' : v;
  if (typeof v === 'string' && /^(prq|dlv)_[0-9a-f]{24}$/.test(v)) return '<id>';
  if (Array.isArray(v)) return v.map(norm);
  if (v instanceof Map) return [...v].map(([k, x]) => [norm(k), norm(x)]);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, RANDOM_KEYS.has(k) ? '<random>' : norm(x)]));
  return v;
}

export interface Outcome { ok?: unknown; threw?: string }

async function runProgram(open: () => Promise<Storage>, steps: Step[]): Promise<Outcome[]> {
  const s = await open();
  const out: Outcome[] = [];
  try {
    for (const step of steps) {
      const t = TARGETS.find((x) => x.name === step.target)!;
      try {
        out.push({ ok: norm(await t.run(s, step.args)) });
      } catch (e) {
        out.push({ threw: errorClass(e) });
      }
    }
  } finally {
    await s.close();
  }
  return out;
}

/** The first step at which two adapters differ, as `[index, adapterA, adapterB]`, or null when they all agree. */
async function firstDivergence(o: Openers, steps: Step[]): Promise<{ at: number; a: string; b: string; got: Outcome; want: Outcome } | null> {
  const runs: { name: string; out: Outcome[] }[] = [];
  for (const a of o.adapters) runs.push({ name: a.name, out: await runProgram(() => a.open(), steps) });
  const [first, ...rest] = runs;
  if (!first) return null;
  for (const other of rest) {
    for (let i = 0; i < steps.length; i++) {
      try {
        expect(other.out[i]).toEqual(first.out[i]);
      } catch {
        return { at: i, a: first.name, b: other.name, got: other.out[i]!, want: first.out[i]! };
      }
    }
  }
  return null;
}

/** Removes steps while the programs still disagree, so the report shows the fewest calls that do. */
export async function shrink(o: Openers, steps: Step[]): Promise<Step[]> {
  let cur = steps;
  for (let chunk = Math.ceil(cur.length / 2); chunk >= 1; chunk = Math.floor(chunk / 2)) {
    for (let i = 0; i < cur.length; ) {
      const trial = [...cur.slice(0, i), ...cur.slice(i + chunk)];
      if (trial.length && (await firstDivergence(o, trial))) cur = trial;
      else i += chunk;
    }
    if (chunk === 1) break;
  }
  return cur;
}

/** A value anywhere in a call's arguments. */
const anyValue = (v: unknown, test: (x: unknown) => boolean): boolean =>
  test(v) || (Array.isArray(v) && v.some((x) => anyValue(x, test))) || (!!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).some((x) => anyValue(x, test)));

/**
 * Divergences another issue owns are listed by the adapter that has them (`ContractAdapter.known`, #1007): reported as a warning, the program stops
 * there (the databases no longer hold the same rows). `PODIUM_DIFF_STRICT=1` makes them failures. A case that is listed and now passes fails,
 * so a fixed defect has to be taken off the list.
 */
const { PODIUM_DIFF_STRICT: STRICT_ENV, PODIUM_DIFF_SEED: SEED_ENV } = process.env; // destructured: podiumctl's settings test lists what the server reads, and these are for tests only
const STRICT = STRICT_ENV === '1';

export const seedOf = (): number => (SEED_ENV ? Number(SEED_ENV) >>> 0 : Math.floor(Math.random() * 2 ** 32));

/** Wraps a case about one adapter: when the case is in the adapter's `known` list it may fail (a warning) and must not pass (remove the entry). */
function trackedCase(o: Openers, id: string, body: (s: Storage, adapter: string) => Promise<void>): (s: Storage, adapter: string) => Promise<void> {
  return async (s, adapter) => {
    const known = o.adapters.find((x) => x.name === adapter)?.known ?? [];
    const tracked = STRICT ? undefined : known.find((k) => !k.input && k.id === id);
    if (!tracked) return body(s, adapter);
    try {
      await body(s, adapter);
    } catch (e) {
      console.warn(`TRACKED by ${tracked.issue} (${tracked.why}): ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      return;
    }
    throw new Error(`${adapter} now passes a case tracked by ${tracked.issue}; remove it from the adapter's known list`);
  };
}

export function differentialCases(o: Openers): void {
  describe('differential', () => {
    const seed = seedOf();
    const RUNS = 40;
    const LENGTH = 25;

    it(`gives the same answer on every adapter for random and edge-case calls (seed ${seed}; replay with PODIUM_DIFF_SEED=${seed})`, async () => {
      for (let n = 0; n < RUNS; n++) {
        const steps = program(seed + n, LENGTH);
        const d = await firstDivergence(o, steps);
        if (!d) continue;
        const small = await shrink(o, steps.slice(0, d.at + 1));
        const e = (await firstDivergence(o, small))!;
        const tracked = STRICT ? undefined : o.adapters.filter((x) => x.name === e.a || x.name === e.b).flatMap((x) => x.known).find((k) => k.input && small.slice(0, e.at + 1).some((step) => anyValue(step.args, k.input!)));
        const report = [
          `${e.a} and ${e.b} disagree (seed ${seed + n}, replay with PODIUM_DIFF_SEED=${seed + n}), after ${small.length} call(s):`,
          ...small.map((x, i) => `  ${i === e.at ? '>' : ' '} ${x.target}(${x.args.map(show).join(', ')})`),
          `  ${e.a}: ${show(e.want)}`,
          `  ${e.b}: ${show(e.got)}`,
        ].join('\n');
        if (tracked) { console.warn(`TRACKED by ${tracked.issue} (${tracked.why}):\n${report}`); continue; }
        throw new Error(report);
      }
    }, 120_000);

    it('runs two transactions at once one after the other, so neither loses the other\'s write', async () => {
      const t = await sameOnAll(o, async (s, rec) => {
        const bump = (label: string) => s.tx(async () => {
          const seen = (await s.people.listLog({ page: 0, pageSize: 100 })).total;
          await new Promise((r) => setTimeout(r, 5));
          await s.people.log('bump', `${label}:${seen}`, 'x', 1);
          return seen;
        });
        const seen = await Promise.all([bump('a'), bump('b'), bump('c')]);
        await rec('seen counts', [...seen].sort((x, y) => x - y));
        await rec('log', (await s.people.listLog({ page: 0, pageSize: 100 })).rows.map((r) => r.detail.slice(2)).sort((a, b) => a.localeCompare(b)));
      });
      expect(t.get('seen counts')).toEqual([0, 1, 2]);
      expect(t.get('log')).toEqual(['0', '1', '2']);
    });

    it('agrees on every adapter for the Admin reporting switch, whether any reporter was heard, and the peer service\'s own reporter lookup', async () => {
      const t = await sameOnAll(o, async (s, rec) => {
        await rec('admin reporting at first', s.people.adminReportingAllowed());
        await s.people.setAdminReporting(false);
        await rec('admin reporting after', s.people.adminReportingAllowed());
        await rec('any reporter', s.reporters.hasAny());
        const key = await rec('record', s.reporters.record({ kind: 'mod', machineId: 'm1', machineName: 'box', source: '127.0.0.1', owner: 'ed', credential: 'person', version: '0.1.0', engineVersion: null, sessionId: 's1' }, 50));
        await rec('any reporter after', s.reporters.hasAny());
        const p = s.peers({ now: () => 60, flagOn: () => true, startedAt: 0 });
        await rec('flag', p.flagOn());
        await rec('get', p.reporters.get(key));
        await rec('of owner', p.reporters.ofOwner('ED'));
        await rec('of owner seen', p.reporters.ofOwnerSeen('ed', 60));
      });
      expect(t.get('admin reporting at first')).toBe(true);
      expect(t.get('admin reporting after')).toBe(false);
      expect(t.get('any reporter')).toBe(false);
      expect(t.get('any reporter after')).toBe(true);
      expect(t.get('flag')).toBe(true);
    });

    onEachAdapter(o, 'answers a call from outside a transaction only after the transaction that holds the lock ends', trackedCase(o, 'outside call waits for the transaction', async (s, adapter) => {
      const order: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const inside = s.tx(async () => {
        await s.people.log('inside', 'x', 'x', 1);
        await held;
        order.push('tx end');
      });
      await new Promise((r) => setTimeout(r, 20));
      const outside = s.people.log('outside', 'x', 'x', 2).then(() => order.push('outside'));
      await new Promise((r) => setTimeout(r, 20));
      release();
      await Promise.all([inside, outside]);
      expect(order).toEqual(['tx end', 'outside']);
    }));
  });
}
