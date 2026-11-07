// The one test every storage adapter passes (#1008): the contract, the upgrade cases and (below) the guards, over the list of
// registered kinds in `index.ts`. A kind added there with a `testing` entry is run through all of it with no edit here, and none of
// the adapters is the reference for another. Tests of one adapter's own internals stay in its folder.
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contractAdapterFor, registerStorageKind, testedStorageKinds } from './index.js';
import type { ContractAdapter } from './contractAdapter.js';
import { runStorageContract } from './contract.js';
import { differentialCases } from './contractDifferential.js';
import { upgradeCases } from './contractUpgrade.js';
import { calls, noting } from './contractCalls.js';
import { storageMethods } from './contractMethods.js';
import { checkServers, notRunNotice, onlyKinds } from './serverGate.js';

/** Plumbing a route assigns or reads, not a store call; each with the reason it is not called. */
const NOT_CALLED = new Set<string>([
  // Callbacks the routes assign to the store; the store never offers them as an operation.
  'peers().onRights', 'peers().onMessage', 'peers().withSource', 'activity().recordings.trail',
]);

const kinds = testedStorageKinds();
const adapters: ContractAdapter[] = (await Promise.all(kinds.map((k) => contractAdapterFor(k)))).map(noting);
/** The adapters whose server is configured. The global setup (`postgres/globalSetup.ts`) fails the run for one that is not, unless the run says it is not wanted. */
const limit = onlyKinds(process.env);
const running = adapters.filter((a) => a.available() && (!limit || limit.includes(a.name)));

// Each comparison case opens a database on every adapter, so under a loaded runner the default 5 s is too tight.
describe('the registered adapters', { timeout: 30_000 }, () => {
  afterAll(async () => {
    for (const a of adapters) await a.dispose();
  });

  it('are the kinds the registry names, each run through the contract below', () => {
    expect(kinds.length).toBeGreaterThan(0);
    expect(running.map((a) => a.name)).toEqual(adapters.filter((a) => a.available() && (!limit || limit.includes(a.name))).map((a) => a.name));
  });

  runStorageContract(running);
  differentialCases({ adapters: running });

  describe('upgrade contract', () => {
    for (const a of running) describe(a.name, () => upgradeCases({ openUpgraded: (rows, reporters, sessions, messages, rights, adminReads) => a.openUpgraded(rows, reporters, sessions, messages, rights, adminReads) }));
  });

  // A table, column or index in one adapter's schema and not in another's is a database change made in one adapter only.
  it('has the same tables, columns and indexes in every adapter', async () => {
    const schemas = await Promise.all(running.map(async (a) => ({ name: a.name, schema: await a.schema() })));
    const [first, ...rest] = schemas;
    expect(Object.keys(first?.schema.tables ?? {}).length, 'the guard read some tables').toBeGreaterThan(20);
    for (const other of rest) {
      const names = (x: typeof first) => Object.entries(x!.schema.tables).flatMap(([t, cols]) => cols.map((c) => `${t}.${c}`)).concat(x!.schema.indexes.map((i) => `index ${i}`)).sort();
      const a = names(first);
      const b = names(other);
      expect(a.filter((n) => !b.includes(n)), `in ${first!.name} and not in ${other.name}`).toEqual([]);
      expect(b.filter((n) => !a.includes(n)), `in ${other.name} and not in ${first!.name}`).toEqual([]);
    }
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
    checkServers({ PODIUM_TEST_ONLY: ' sqlite ,other', PODIUM_TEST_OTHER: 'y' }, need, (l) => lines.push(l));
    expect(lines.join('')).toMatch(/NOT RUN: postgres\./);
    expect(onlyKinds({ PODIUM_TEST_ONLY: ' sqlite ,x' })).toEqual(['sqlite', 'x']);
    expect(onlyKinds({ PODIUM_TEST_ONLY: '' })).toBeNull();
  });

  it('refuses a name in PODIUM_TEST_ONLY that is not a registered kind', () => {
    expect(() => checkServers({ PODIUM_TEST_ONLY: 'sqlte' }, need, () => undefined)).toThrow(/sqlte.*not a registered storage kind.*sqlite, postgres, other/);
  });

  it('names scripts/test-pg.sh first when a server is missing, and says PODIUM_TEST_ONLY is not a way past the error (#1011)', () => {
    let msg = '';
    try { checkServers({}, need, () => undefined); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/scripts\/test-pg\.sh.*PODIUM_TEST_ONLY/s);
    expect(msg).toMatch(/not a way past this error/);
    expect(msg).toMatch(/every adapter/);
  });

  it('says in the NOT RUN notice that a run limited this way is not a pass for a PR (#1011)', () => {
    expect(notRunNotice(['postgres'])).toMatch(/not.*pass for a pull request/);
  });

  it('still fails for a kind the limit names when its server is not configured', () => {
    expect(() => checkServers({ PODIUM_TEST_ONLY: 'postgres' }, need, () => undefined)).toThrow(/PODIUM_TEST_PG/);
  });
});

// Every registered adapter's tests run on every merge to development and main, and a release runs the browser suite on every database (#1008).
// Adding an adapter without its CI job, or without its e2e run, fails here and not at the first release that depends on it.
describe('the CI jobs for the registered adapters', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const read = (f: string): string => readFileSync(path.join(root, '.github', 'workflows', f), 'utf8');
  const ci = read('ci.yml');
  /** The jobs of a workflow, by name, each with its text. */
  const jobs = (text: string): Record<string, string> => {
    const body = text.slice(text.indexOf('\njobs:'));
    const parts = body.split(/\n  ([a-z0-9-]+):\n/).slice(1);
    return Object.fromEntries(parts.reduce<[string, string][]>((acc, v, i) => (i % 2 ? acc : [...acc, [v, parts[i + 1] ?? '']]), []));
  };

  /** Why an adapter that needs a server is not covered by a job, or null when it is. */
  const jobProblem = (all: Record<string, string>, a: { name: string; serverVar: string | null }): string | null => {
    const job = Object.entries(all).find(([, text]) => text.includes(`${a.serverVar}:`));
    if (!job) return `${a.name}: no job in ci.yml sets ${a.serverVar}. Add a job that runs "npm test -w server" with it, and tell the maintainer its check name for the "Protect development and main" ruleset`;
    return /^    if:/m.test(job[1]) ? `${a.name}: the job "${job[0]}" must run on every pull request and push` : null;
  };

  it('run on pull requests and pushes to development and main', () => {
    const on = ci.slice(ci.indexOf('\non:'), ci.indexOf('\npermissions:'));
    expect(on).toMatch(/pull_request:\s+branches: \[development, main\]/);
    expect(on).toMatch(/push:\s+branches: \[development, main\]/);
  });

  it('have a job for each adapter that needs a server, which sets its server variable and is not conditional', () => {
    const all = jobs(ci);
    for (const a of adapters.filter((x) => x.serverVar)) expect(jobProblem(all, a), `${a.name}`).toBeNull();
  });

  it('are required for a stub adapter too: one with a server variable and no job fails the guard', () => {
    expect(jobProblem(jobs(ci), { name: 'stub', serverVar: 'PODIUM_TEST_STUB' })).toMatch(/no job in ci\.yml sets PODIUM_TEST_STUB.*ruleset/s);
  });

  it('leave out of the main test job only kinds that have a job of their own', () => {
    const main = jobs(ci)['test-and-build'] ?? '';
    const only = /PODIUM_TEST_ONLY:\s*([\w,]+)/.exec(main)?.[1]?.split(',') ?? adapters.map((a) => a.name);
    const left = adapters.filter((a) => !only.includes(a.name));
    expect(left.filter((a) => !a.serverVar).map((a) => a.name), 'a kind with no server variable has no job of its own, so the main job must run it').toEqual([]);
  });

  it('run the browser suite on every database at a release, and fail when one is missing', () => {
    const e2e = read('e2e.yml');
    const list = /DATABASES: \$\{\{ inputs\.databases \|\| '([^']*)' \}\}/.exec(e2e)?.[1]?.split(' ') ?? [];
    const accepted = /case "\$db" in ([^)]*)\) ;;/.exec(e2e)?.[1]?.split('|') ?? [];
    for (const a of adapters) {
      expect(list, `e2e.yml: the default databases must include ${a.name}`).toContain(a.name);
      expect(accepted, `e2e.yml: the database case must accept ${a.name}`).toContain(a.name);
    }
    expect(e2e).toContain('no passing run of the suite on $db');
    expect(e2e).toContain('the e2e run was skipped on a PR into main');
  });
});

// A third adapter is added in one place, the registry, and runs the whole set with no edit to a contract file (#1008). The stub is SQLite under
// another name, so the comparison between it and the real adapters must also come out equal.
describe('a third adapter', () => {
  it('is picked up from the registry and runs the contract against the others', async () => {
    const sqlite = await contractAdapterFor('sqlite');
    const remove = registerStorageKind('stub', { fileBased: false, load: async () => { throw new Error('not opened by a server'); }, testing: async () => ({ ...sqlite, name: 'stub' }) });
    try {
      expect(testedStorageKinds()).toContain('stub');
      const stub = await contractAdapterFor('stub');
      const { sameOnAll } = await import('./contractSame.js');
      const t = await sameOnAll({ adapters: [sqlite, stub] }, async (s, rec) => {
        await s.people.log('k', 'd', 's', 1);
        await rec('log', (await s.people.listLog({})).rows.map((r) => r.kind));
      });
      expect(t.get('log')).toEqual(['k']);
      // A stub that answers differently fails, naming both.
      const odd = { ...sqlite, name: 'odd' };
      await expect(sameOnAll({ adapters: [sqlite, odd] }, async (s, rec) => { await rec('who', odd.name === 'odd' && s === s ? Math.random() : 0); })).rejects.toThrow(/differs between sqlite and odd/);
    } finally {
      remove();
    }
    expect(testedStorageKinds()).not.toContain('stub');
  });
});
