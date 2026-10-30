// Issue #45: after /exit under the Claude Code daemon a background job keeps running with no client attached.
// The reporter says whether any client is attached; the server keeps when that last became false and puts
// the moment the card leaves the wall on the view. A reporter that sends nothing counts as attached.
import { describe, it, expect, beforeEach } from 'vitest';
import { openSqliteStorage, type SqliteStorage } from '../storage/sqlite/index.js';
import { DEFAULT_CONFIG, Fleet, type FleetConfig } from './fleet.js';
import type { Report } from './protocol.js';
import { fixtureReport } from './testing.js';

const CFG: FleetConfig = { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' };
const T0 = 1_791_648_000_000;

let clock = T0;
let db: SqliteStorage;
beforeEach(() => {
  clock = T0;
  db = openSqliteStorage(':memory:');
});
const makeFleet = async (cfg: FleetConfig = CFG) => {
  const fleet = new Fleet(db, cfg, () => clock);
  await fleet.init();
  return fleet;
};

/** The fixture session, reported with the given attach state (undefined = a reporter that predates the field). */
function report(attached: boolean | null | undefined): Report {
  const r = structuredClone(fixtureReport());
  const s = r.session as unknown as Record<string, unknown>;
  if (attached === undefined) delete s.attached;
  else s.attached = attached;
  return r;
}

describe('attached', () => {
  it('is on the view as reported, true or false', async () => {
    const fleet = await makeFleet();
    await fleet.ingest(report(true));
    expect((await fleet.view(fixtureReport().session.id))?.attached).toBe(true);
    await fleet.ingest(report(false));
    expect((await fleet.view(fixtureReport().session.id))?.attached).toBe(false);
  });

  it('counts a report with no field, from an older reporter, as attached and never hides it', async () => {
    const fleet = await makeFleet();
    await fleet.ingest(report(undefined));
    const v = (await fleet.view(fixtureReport().session.id))!;
    expect(v.attached).toBeNull();
    expect(v.hideAt).toBeNull();
  });
});

describe('hideAt (when a card nobody is attached to leaves the wall)', () => {
  const id = fixtureReport().session.id;

  it('is null while a client is attached', async () => {
    const fleet = await makeFleet();
    await fleet.ingest(report(true));
    expect((await fleet.view(id))?.hideAt).toBeNull();
  });

  it('is the first report with nobody attached plus the delay (60 s by default)', async () => {
    const fleet = await makeFleet();
    await fleet.ingest(report(false));
    expect((await fleet.view(id))?.hideAt).toBe(T0 + 60_000);
  });

  it('keeps counting from the first detached report, not the latest', async () => {
    const fleet = await makeFleet();
    await fleet.ingest(report(false));
    clock += 20_000;
    await fleet.ingest(report(false));
    expect((await fleet.view(id))?.hideAt).toBe(T0 + 60_000);
    expect((await db.fleet.getSession(id))?.detached_at).toBe(T0);
  });

  it('follows DETACHED_HIDE_AFTER_MS', async () => {
    const fleet = await makeFleet({ ...CFG, detachedHideAfterMs: 5_000 });
    await fleet.ingest(report(false));
    expect((await fleet.view(id))?.hideAt).toBe(T0 + 5_000);
  });

  it('clears when someone attaches again, and starts over at the next detach', async () => {
    const fleet = await makeFleet();
    await fleet.ingest(report(false));
    clock += 30_000;
    await fleet.ingest(report(true));
    expect((await fleet.view(id))?.hideAt).toBeNull();
    expect((await db.fleet.getSession(id))?.detached_at).toBeNull();
    clock += 30_000;
    await fleet.ingest(report(false));
    expect((await fleet.view(id))?.hideAt).toBe(T0 + 60_000 + 60_000);
  });

  it('survives a settings-hook event, which carries no attach state', async () => {
    const fleet = await makeFleet();
    await fleet.ingest(report(false));
    await fleet.ingestHook({ hook_event_name: 'UserPromptSubmit', session_id: id, cwd: '/Users/dev/x', prompt: 'hi' });
    const v = (await fleet.view(id))!;
    expect(v.attached).toBe(false);
    expect(v.hideAt).toBe(T0 + 60_000);
  });

  it('does not take the session out of the live set or the totals', async () => {
    const fleet = await makeFleet();
    await fleet.ingest(report(false));
    clock += 10 * 60_000;
    expect(fleet.isLive(id)).toBe(true);
  });
});
