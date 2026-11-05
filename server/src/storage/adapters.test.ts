// The one test every storage adapter passes (#1008): the contract, the upgrade cases and (below) the guards, over the list of
// registered kinds in `index.ts`. A kind added there with a `testing` entry is run through all of it with no edit here, and none of
// the adapters is the reference for another. Tests of one adapter's own internals stay in its folder.
import { afterAll, describe, expect, it } from 'vitest';
import { contractAdapterFor, testedStorageKinds } from './index.js';
import type { ContractAdapter } from './contractAdapter.js';
import { runStorageContract } from './contract.js';
import { differentialCases } from './contractDifferential.js';
import { upgradeCases } from './contractUpgrade.js';
import { calls, noting } from './contractCalls.js';
import { storageMethods } from './contractMethods.js';
import { checkServers, onlyKinds } from './serverGate.js';

/** Plumbing a route assigns or reads, not a store call; each with the reason it is not called. */
const NOT_CALLED = new Set<string>([
  // Callbacks the routes assign to the store; the store never offers them as an operation.
  'peers().onRights', 'peers().onMessage', 'peers().withSource', 'activity().recordings.trail',
]);

const kinds = testedStorageKinds();
const adapters: ContractAdapter[] = (await Promise.all(kinds.map((k) => contractAdapterFor(k)))).map(noting);
/** The adapters whose server is configured. The global setup (`postgres/globalSetup.ts`) fails the run for one that is not, unless the run says it is not wanted. */
const running = adapters.filter((a) => a.available());

describe('the registered adapters', () => {
  afterAll(async () => {
    for (const a of adapters) await a.dispose();
  });

  it('are the kinds the registry names, each run through the contract below', () => {
    expect(kinds.length).toBeGreaterThan(0);
    expect(running.map((a) => a.name)).toEqual(adapters.filter((a) => a.available()).map((a) => a.name));
  });

  runStorageContract(running);
  differentialCases({ adapters: running });

  describe('upgrade contract', () => {
    for (const a of running) describe(a.name, () => upgradeCases({ openUpgraded: (rows, reporters, sessions) => a.openUpgraded(rows, reporters, sessions) }));
  });

  // Runs after the cases above (a file's tests run in order). A method of the interface that no case calls on some adapter has no case.
  it('has a case that calls every method of the storage interface, on every adapter', () => {
    const missing = running.flatMap((a) => storageMethods().filter((m) => !calls.get(a.name)?.has(m) && !NOT_CALLED.has(m)).map((m) => `${a.name}: ${m}`));
    expect(
      missing,
      'STORE METHOD WITHOUT A CASE: types.ts offers each method listed here, and no contract case or differential target calls it on that adapter. ' +
        'Add a scenario step in a contract*.ts case (with its expected value written out) or a target in contractDifferential.ts; do not add it to NOT_CALLED to make this pass.',
    ).toEqual([]);
  });
});

describe('the server gate', () => {
  const need = [{ name: 'sqlite', serverVar: null }, { name: 'postgres', serverVar: 'PODIUM_TEST_PG' }, { name: 'other', serverVar: 'PODIUM_TEST_OTHER' }];

  it('passes quietly when every server variable is set', () => {
    const lines: string[] = [];
    checkServers({ PODIUM_TEST_PG: 'x', PODIUM_TEST_OTHER: 'y' }, need, (l) => lines.push(l));
    expect(lines).toEqual([]);
  });

  it('fails, naming the adapter and its variable, when a server is not configured', () => {
    expect(() => checkServers({ PODIUM_TEST_OTHER: 'y' }, need, () => undefined)).toThrow(/PODIUM_TEST_PG is not set.*postgres storage tests/s);
    expect(() => checkServers({ PODIUM_TEST_PG: '', PODIUM_TEST_OTHER: 'y' }, need, () => undefined)).toThrow(/postgres/);
  });

  it('lets a run limited by PODIUM_TEST_ONLY leave kinds out, and says they were NOT RUN', () => {
    const lines: string[] = [];
    checkServers({ PODIUM_TEST_ONLY: ' sqlite ,x' }, need, (l) => lines.push(l));
    expect(lines.join('')).toMatch(/NOT RUN: postgres, other\./);
    expect(onlyKinds({ PODIUM_TEST_ONLY: ' sqlite ,x' })).toEqual(['sqlite', 'x']);
    expect(onlyKinds({ PODIUM_TEST_ONLY: '' })).toBeNull();
  });

  it('still fails for a kind the limit names when its server is not configured', () => {
    expect(() => checkServers({ PODIUM_TEST_ONLY: 'postgres' }, need, () => undefined)).toThrow(/PODIUM_TEST_PG/);
  });
});
