// An adapter whose test server is not configured must not be taken for a pass (#891, #1008). Used by the global setup
// (named in vitest.config.ts) before any test runs, over every registered adapter that needs a server.
//
// Unset server variable: the run fails and says which adapter and which variable. The one way round it is to say so, with
// PODIUM_TEST_ONLY=<kinds, comma separated>, which runs only those kinds and prints that every other one was NOT RUN.
export interface ServerNeed {
  name: string;
  /** The environment variable naming its server, or null when it needs none. */
  serverVar: string | null;
}

export function notRunNotice(names: string[]): string {
  return [
    '',
    `  ! NOT RUN: ${names.join(', ')}. PODIUM_TEST_ONLY limits this run, so the contract, the upgrade cases and the differential test did not run on ${names.length > 1 ? 'them' : 'it'}.`,
    '    A green run here says nothing about them, and it is not a pass for a pull request. Run them with a throwaway container each:  scripts/test-db.sh',
    '',
  ].join('\n');
}

/** The kinds a run is limited to, or null when it is not limited. */
export function onlyKinds(env: Record<string, string | undefined>): string[] | null {
  const { PODIUM_TEST_ONLY: only } = env; // destructured: podiumctl's settings test lists what the server reads, and this is for tests only
  const kinds = (only ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  return kinds.length ? kinds : null;
}

/** Throws when an adapter that needs a server has none configured and the run is not limited to other kinds; otherwise prints what was left out. */
export function checkServers(env: Record<string, string | undefined>, adapters: ServerNeed[], print: (text: string) => void = (t) => console.warn(t)): void {
  const only = onlyKinds(env);
  const unknown = (only ?? []).filter((k) => !adapters.some((a) => a.name === k));
  if (unknown.length) throw new Error(`PODIUM_TEST_ONLY names ${unknown.join(', ')}, which ${unknown.length > 1 ? 'are' : 'is'} not a registered storage kind (registered: ${adapters.map((a) => a.name).join(', ')}).`);
  const skipped: string[] = [];
  for (const a of adapters) {
    if (!a.serverVar || env[a.serverVar]) continue;
    if (only && !only.includes(a.name)) { skipped.push(a.name); continue; }
    throw new Error(`${a.serverVar} is not set, so the ${a.name} storage tests cannot run, and a run that leaves one out is not a pass. Run them with a throwaway container each: scripts/test-db.sh. PODIUM_TEST_ONLY=<the kinds to run> leaves an adapter out on purpose and is not a way past this error: a pull request needs every adapter to have run, so set it only when the person running the tests asked for that.`);
  }
  if (skipped.length) print(notRunNotice(skipped));
}
