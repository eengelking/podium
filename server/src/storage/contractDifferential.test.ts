// The differential test's own handling of a divergence (#1201): a difference a `known` list names costs one comparison, and any other is shrunk.
// Two adapters are made from the SQLite one, and the second answers `fleet.costSince` differently, so the divergence is made here and needs no database server.
import { describe, expect, it } from 'vitest';
import { contractAdapterFor } from './index.js';
import type { ContractAdapter, KnownDefect } from './contractAdapter.js';
import { settleDivergence, type Step } from './contractDifferential.js';
import type { Storage } from './types.js';

async function pair(known: KnownDefect[]): Promise<{ adapters: ContractAdapter[]; opens: () => number }> {
  const base = await contractAdapterFor('sqlite');
  let opens = 0;
  const counted: ContractAdapter = { ...base, name: 'one', known: [], open: async () => { opens++; return base.open(); } };
  const odd: ContractAdapter = {
    ...base,
    name: 'two',
    known,
    open: async () => {
      opens++;
      const s = await base.open();
      return new Proxy(s, { get: (t, p) => (p === 'fleet' ? new Proxy(t.fleet, { get: (f, q) => (q === 'costSince' ? async () => 'not a number' : Reflect.get(f, q)) }) : Reflect.get(t, p)) }) as Storage;
    },
  };
  return { adapters: [counted, odd], opens: () => opens };
}

const PROGRAM: Step[] = [
  { target: 'people.allGroups', args: [] },
  { target: 'fleet.costSince', args: [Infinity] },
  { target: 'people.allGroups', args: [] },
];
const DIVERGES_AT = { at: 1, a: 'one', b: 'two', got: { ok: 'not a number' }, want: { ok: 0 } };

describe('settleDivergence', () => {
  it('reports a difference a known list names without shrinking it: no database is opened again', async () => {
    const { adapters, opens } = await pair([{ id: 'infinity', issue: '#1007', why: 'test', input: (v) => v === Infinity }]);
    const r = await settleDivergence({ adapters }, PROGRAM, DIVERGES_AT, 7);
    expect(r.tracked?.issue).toBe('#1007');
    expect(opens()).toBe(0);
    expect(r.report).toContain('not shrunk');
    expect(r.report).toContain('fleet.costSince(Infinity)');
  });

  it('still shrinks a difference no list names, and reports the fewest calls that show it', async () => {
    const { adapters, opens } = await pair([{ id: 'other', issue: '#1007', why: 'test', input: (v) => v === 'never sent' }]);
    const r = await settleDivergence({ adapters }, PROGRAM, DIVERGES_AT, 7);
    expect(r.tracked).toBeUndefined();
    expect(opens()).toBeGreaterThan(2);
    expect(r.report).toContain('after 1 call(s):');
    expect(r.report).not.toContain('people.allGroups');
    expect(r.report).toContain('replay with PODIUM_DIFF_SEED=7');
  });
});
