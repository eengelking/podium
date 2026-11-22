// The one test every storage adapter passes (#1008): the contract, the upgrade cases and (below) the guards, over the list of
// registered kinds in `index.ts`. A kind added there with a `testing` entry is run through all of it with no edit here, and none of
// the adapters is the reference for another. Tests of one adapter's own internals stay in its folder.
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contractAdapterFor, openStorage, registerStorageKind, testedStorageKinds } from './index.js';
import type { ContractAdapter, PhysicalDifference } from './contractAdapter.js';
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

/** True when `text` registers a case whose title begins with `title`: the title is the first argument of `it(` or `onEachAdapter(o, `, not a word in a comment or in some other string. */
function registersCase(text: string, title: string): boolean {
  const escaped = title.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(String.raw`(?:^|[^\w.])(?:it|test)\(\s*(['"\`])${escaped}|\bonEachAdapter\(\s*\w+,\s*(['"\`])${escaped}`, 'm').test(text);
}

/**
 * What is wrong with one adapter's layouts (DECISIONS 78), as the lines to print, or none. `found` is what its database says, `declared` its list, `tablesOf` the tables of every running adapter,
 * and `caseText` reads the file of a contract case in `server/src/storage/` (null when there is none).
 */
function layoutProblems(
  adapter: string,
  found: readonly string[],
  declared: readonly PhysicalDifference[],
  tablesOf: Readonly<Record<string, readonly string[]>>,
  caseText: (file: string) => string | null,
): string[] {
  const names = declared.map((d) => d.table);
  const out = [
    ...found.filter((t) => !names.includes(t)).map((t) => `${adapter}: the table ${t} is laid out another way and is not declared. Declare it in the adapter's list of physical differences with its reason, its measured gain and the contract case that proves the data is the same (DECISIONS 78), or make it the way every adapter's is.`),
    ...declared.filter((d) => !found.includes(d.table)).map((d) => `${adapter}: ${d.id} declares ${d.table} laid out with ${d.option}, and the database does not have it that way. Remove the entry or make the layout.`),
    ...declared.filter((d, i) => names.indexOf(d.table) !== i).map((d) => `${adapter}: ${d.table} is declared twice.`),
  ];
  for (const d of declared) {
    for (const [other, tables] of Object.entries(tablesOf)) if (!tables.includes(d.table)) out.push(`${adapter}: ${d.id} declares ${d.table}, which ${other} does not have. A physical difference is only in how a table every adapter has is laid out.`);
    for (const field of ['id', 'option', 'why', 'issue', 'gain'] as const) if (!d[field].trim()) out.push(`${adapter}: ${d.id || d.table} has no ${field}.`);
    const text = caseText(d.case.file);
    if (text === null) out.push(`${adapter}: ${d.id} names the contract case file ${d.case.file}, which is not in server/src/storage/.`);
    else if (!registersCase(text, d.case.title)) out.push(`${adapter}: ${d.id} names the case "${d.case.title}", which ${d.case.file} does not hold as a case (the title must open an it() or an onEachAdapter(o, ...) call, and a comment or a string elsewhere does not count).`);
  }
  return out;
}

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
    for (const a of running) describe(a.name, () => upgradeCases({ openUpgraded: (rows, reporters, sessions, messages, rights, adminReads, publicMessages, extras, chat, daily) => a.openUpgraded(rows, reporters, sessions, messages, rights, adminReads, publicMessages, extras, chat, daily) }));
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

  // How a table is laid out on disk is not in the names above, and no store call can see it (DECISIONS 78). Each adapter declares the tables it lays out another way, with the case that holds
  // their data the same, and its database is asked: a layout that is not declared fails, and so does a declaration the database does not bear out.
  it('declares every table an adapter lays out another way, and the database bears each declaration out', async () => {
    const tablesOf = Object.fromEntries(await Promise.all(running.map(async (a) => [a.name, Object.keys((await a.schema()).tables)] as const)));
    const here = path.dirname(fileURLToPath(import.meta.url));
    const caseText = (file: string): string | null => {
      if (!/^\w+\.ts$/.test(file)) return null;
      try {
        return readFileSync(path.join(here, file), 'utf8');
      } catch {
        return null;
      }
    };
    for (const a of running) {
      const others = Object.fromEntries(Object.entries(tablesOf).filter(([name]) => name !== a.name));
      expect(layoutProblems(a.name, await a.layouts(), a.physical, others, caseText)).toEqual([]);
    }
  });

  // The check above is only worth having if it fails when it should.
  it('fails for a layout that is not declared, a declaration the database does not have, and an entry with no case', () => {
    const entry: PhysicalDifference = { id: 'x-layout', table: 'orders', option: 'OPT', why: 'a reason', issue: '#1', gain: '10%', case: { file: 'adapters.test.ts', title: 'declares every table an adapter lays out another way' } };
    const tables = { other: ['orders', 'lines'] };
    const read = (f: string): string | null => (f === 'adapters.test.ts' ? readFileSync(fileURLToPath(import.meta.url), 'utf8') : null);
    expect(layoutProblems('mine', ['orders'], [entry], tables, read)).toEqual([]);
    expect(layoutProblems('mine', ['orders', 'lines'], [entry], tables, read).join('\n')).toMatch(/the table lines is laid out another way and is not declared/);
    expect(layoutProblems('mine', [], [entry], tables, read).join('\n')).toMatch(/x-layout declares orders laid out with OPT, and the database does not have it that way/);
    expect(layoutProblems('mine', ['orders'], [entry], { other: ['lines'] }, read).join('\n')).toMatch(/which other does not have/);
    expect(layoutProblems('mine', ['orders'], [{ ...entry, case: { file: 'nowhere.ts', title: 'x' } }], tables, read).join('\n')).toMatch(/nowhere\.ts, which is not in server\/src\/storage/);
    expect(layoutProblems('mine', ['orders'], [{ ...entry, case: { file: 'adapters.test.ts', title: ['a case', 'that is', 'not there'].join(' ') } }], tables, read).join('\n')).toMatch(/which adapters\.test\.ts does not hold/);
    // A title in a comment, or in a string that is not a case, does not make a case, and a title that opens an it() or an onEachAdapter() does, as a prefix of the whole title.
    const named = { ...entry, case: { file: 'x.ts', title: 'keeps the rows' } };
    const withText = (body: string) => layoutProblems('mine', ['orders'], [named], tables, () => body).join('\n');
    expect(withText("// keeps the rows of orders\n  it('something else', () => {});")).toMatch(/does not hold as a case/);
    expect(withText("const label = 'keeps the rows';\n  it('something else', () => {});")).toMatch(/does not hold as a case/);
    expect(withText("  it('keeps the rows of orders when it is purged', async () => {});")).toBe('');
    expect(withText("  onEachAdapter(o, 'keeps the rows of orders', async (s) => {});")).toBe('');
    expect(layoutProblems('mine', ['orders'], [{ ...entry, gain: ' ' }], tables, read).join('\n')).toMatch(/has no gain/);
    expect(layoutProblems('mine', ['orders'], [entry, { ...entry, id: 'again' }], tables, read).join('\n')).toMatch(/orders is declared twice/);
  });

  // The measurement helper of each adapter (#755): its SQL is the adapter's own, so a seeded table and an index it can drop and create are checked here.
  it('seeds samples and drops and creates the samples_t index in every adapter', async () => {
    for (const a of running) {
      const perf = await a.samplesPerf!();
      try {
        await perf.seed(2, 90, 1_800_000_000);
        expect(await perf.rows(), `${a.name} rows`).toBe(180);
        const withIndex = await perf.indexBytes();
        await perf.dropIndex();
        await perf.createIndex();
        const rebuilt = await perf.indexBytes();
        // The size is a number where the database can report one; SQLite without dbstat says null.
        if (withIndex !== null) expect(rebuilt, `${a.name} index size`).toBeGreaterThan(0);
        // A storage opens the same database, and the newest sample the seed wrote is at the end second.
        const storage = await openStorage({ PODIUM_DB: perf.podiumDb } as NodeJS.ProcessEnv);
        try {
          expect((await storage.fleet.latestSample('perf-000'))?.t, `${a.name} newest sample`).toBe(1_800_000_000);
        } finally {
          await storage.close();
        }
      } finally {
        await perf.close();
      }
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

  it('names npm run test:db first when a server is missing, and says PODIUM_TEST_ONLY is not a way past the error (#1011)', () => {
    let msg = '';
    try { checkServers({}, need, () => undefined); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/npm run test:db.*PODIUM_TEST_ONLY/s);
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
