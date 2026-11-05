// The one test every storage adapter passes (#1008): the contract, the upgrade cases and (below) the guards, over the list of
// registered kinds in `index.ts`. A kind added there with a `testing` entry is run through all of it with no edit here, and none of
// the adapters is the reference for another. Tests of one adapter's own internals stay in its folder.
import { afterAll, describe, expect, it } from 'vitest';
import { contractAdapterFor, testedStorageKinds } from './index.js';
import type { ContractAdapter } from './contractAdapter.js';
import { runStorageContract } from './contract.js';
import { upgradeCases } from './contractUpgrade.js';
import { checkServers, onlyKinds } from './serverGate.js';

const kinds = testedStorageKinds();
const adapters: ContractAdapter[] = await Promise.all(kinds.map((k) => contractAdapterFor(k)));
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

  describe('upgrade contract', () => {
    for (const a of running) describe(a.name, () => upgradeCases({ openUpgraded: (rows, reporters, sessions) => a.openUpgraded(rows, reporters, sessions) }));
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
