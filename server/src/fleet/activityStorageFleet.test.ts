// The fleet over the async activity storage (#313 stage 5a): what it reads from the main database for the two services, the
// order of the Podium-entry writes, the retention and delete paths, and the recording marker.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteStorage, type SqliteStorage } from '../storage/sqlite/index.js';
import { DEFAULT_CONFIG, Fleet, type FleetConfig } from './fleet.js';
import { MAIN_LOOP, type ActivityEntry, type Report } from './protocol.js';
import { fixtureReport } from './testing.js';

const T0 = 1_800_000_000_000;
const CFG: FleetConfig = { ...DEFAULT_CONFIG, home: '/Users/dev', dbPath: ':memory:' };
const open: SqliteStorage[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const tool = (at: number, text = `Read f${at}`): ActivityEntry => ({ at, kind: 'tool', text });

async function make() {
  const errors: { event: string; msg: string }[] = [];
  const logger = { info() {}, warn() {}, debug() {}, error: (event: string, msg: string) => errors.push({ event, msg }) } as never;
  const state = { now: T0 };
  const storage = openSqliteStorage(':memory:');
  open.push(storage);
  const fleet = new Fleet(storage, CFG, () => state.now, logger, { authOn: true, secret: 'the-admin-secret-0123456789' });
  await fleet.init();
  await fleet.activityHistorySettings.set({ policy: 'all' });
  await fleet.features.setFeature('respond', true);
  const r = fixtureReport();
  r.session.activityFeed = true;
  r.session.sessionRecording = true;
  r.session.respond = { level: 'everything', accepts: ['message', 'command'], limits: [] };
  r.sentAt = T0;
  return { fleet, storage, state, errors, r };
}

describe('the loops the stored history asks the mod to send', () => {
  it('are the orchestrator and the running agents, after the loops a viewer watches', async () => {
    const { fleet, r } = await make();
    await fleet.ingest(r);
    const sid = r.session.id;
    // the fixture's running agents are a2 and a4; a1 is done and a3 failed
    expect(await fleet.watchedLoops(sid)).toEqual([MAIN_LOOP, 'a2', 'a4']);
    fleet.activity.watch(sid, 'a4', 5);
    fleet.activity.watch(sid, 'a1', 5);
    expect(await fleet.watchedLoops(sid)).toEqual(['a4', 'a1', MAIN_LOOP, 'a2']);
  });

  it('are only the watched ones when the reporter does not send the feed or the history keeps nothing', async () => {
    const { fleet, r } = await make();
    r.session.activityFeed = false;
    await fleet.ingest(r);
    fleet.activity.watch(r.session.id, 'a1', 5);
    expect(await fleet.watchedLoops(r.session.id)).toEqual(['a1']);
    r.session.activityFeed = true;
    await fleet.ingest(r);
    await fleet.activityHistorySettings.set({ policy: 'default' });
    expect(await fleet.watchedLoops(r.session.id)).toEqual(['a1']);
  });
});

describe('a Podium entry', () => {
  it('reaches the stored history in the order it was asked for: added, then updated, then taken back', async () => {
    const { fleet, r } = await make();
    r.session.activity = [tool(T0)];
    await fleet.ingest(r);
    fleet.activity.watch(r.session.id, MAIN_LOOP, 5);
    const sent = fleet.respond.message(r.session.id, 'Ed', { text: 'please rerun the tests' });
    if (!sent.ok) throw new Error('message refused');
    fleet.respond.result(r.session.id, sent.delivery.id, 'queued');
    await fleet.flush();
    const page = await fleet.activityHistory.page(r.session.id, MAIN_LOOP, null);
    expect(page.entries.filter((e) => e.kind === 'podium')).toEqual([expect.objectContaining({ by: 'Ed', note: expect.any(String) })]);
    const second = fleet.respond.message(r.session.id, 'Ed', { text: 'and again' });
    if (!second.ok) throw new Error('message refused');
    fleet.respond.result(r.session.id, second.delivery.id, 'refused');
    await fleet.flush();
    expect((await fleet.activityHistory.page(r.session.id, MAIN_LOOP, null)).entries.filter((e) => e.kind === 'podium')).toHaveLength(1);
  });

  it('logs a failing write once per write and never reaches the answer', async () => {
    const { fleet, r, errors } = await make();
    await fleet.ingest(r);
    fleet.activity.watch(r.session.id, MAIN_LOOP, 5);
    const boom = () => Promise.reject(new Error('disk full'));
    vi.spyOn(fleet.activityHistory, 'addPodium').mockImplementation(boom);
    vi.spyOn(fleet.activityHistory, 'updatePodium').mockImplementation(boom);
    vi.spyOn(fleet.activityHistory, 'removePodium').mockImplementation(boom);
    const sent = fleet.respond.message(r.session.id, 'Ed', { text: 'please rerun the tests' });
    if (!sent.ok) throw new Error('message refused');
    expect(() => fleet.respond.result(r.session.id, sent.delivery.id, 'queued')).not.toThrow();
    const second = fleet.respond.message(r.session.id, 'Ed', { text: 'and again' });
    if (!second.ok) throw new Error('message refused');
    expect(() => fleet.respond.result(r.session.id, second.delivery.id, 'refused')).not.toThrow();
    await fleet.flush();
    expect(errors.map((e) => e.event)).toEqual(['activity.podium_failed', 'activity.podium_failed', 'activity.podium_failed', 'activity.podium_failed']);
    expect(errors[0]!.msg).toContain('disk full');
    expect(errors.map((e) => /could not (\w+)/.exec(e.msg)![1])).toEqual(['add', 'update', 'add', 'remove']);
  });

  it('is not stored for a session the main database does not hold', async () => {
    const { fleet, errors } = await make();
    const spy = vi.spyOn(fleet.activityHistory, 'addPodium');
    fleet.respond.dropSession('ghost');
    await fleet.flush();
    expect(spy).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });
});

describe('a recording', () => {
  async function recording() {
    const m = await make();
    await m.fleet.features.setFeature('session-recording', true);
    await m.fleet.ingest(m.r);
    const sid = m.r.session.id;
    expect(await m.fleet.recordings.start(sid, [MAIN_LOOP, 'a2'], 'Ed', { name: 'n', project: null, owner: null })).toBe('ok');
    return { ...m, sid };
  }

  it('shows in the session view with the loops the fleet store holds', async () => {
    const { fleet, sid } = await recording();
    const view = await fleet.view(sid);
    expect(view?.recording).toMatchObject({ state: 'recording', ownerAllows: true });
    const loops = view!.recording!.loops;
    // the orchestrator, then the agents in the order the store gives them
    expect(loops.map((l) => l.loop)).toEqual([MAIN_LOOP, ...(await fleet.db.getAgents(sid)).map((a) => a.id)]);
    expect(loops).toHaveLength(5);
    expect(loops.filter((l) => l.recorded).map((l) => l.loop)).toEqual([MAIN_LOOP, 'a2']);
    expect(loops.find((l) => l.loop === 'a4')?.name).toBe('pdf');
  });

  it('is stopped for every session when the Admin turns the flag off, and the cards learn of it', async () => {
    const { fleet, sid } = await recording();
    const changed = vi.spyOn(fleet, 'recordingChanged');
    await fleet.features.setFeature('session-recording', false);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(sid));
    expect(await fleet.recordings.stateFor(sid)).toBe('stopped');
  });

  it('logs a failure to stop on the flag going off', async () => {
    const { fleet, errors } = await recording();
    vi.spyOn(fleet.recordings, 'stopAll').mockRejectedValue(new Error('locked'));
    await fleet.features.setFeature('session-recording', false);
    await vi.waitFor(() => expect(errors.map((e) => e.event)).toEqual(['recording.stop_failed']));
  });

  it('carries over to the session a /clear made', async () => {
    const { fleet, r, sid } = await recording();
    const next = structuredClone(r) as Report;
    next.session.id = 'cleared-into';
    next.session.clearedFrom = sid;
    await fleet.ingest(next);
    expect(await fleet.recordings.stateFor('cleared-into')).toBe('recording');
    expect(await fleet.recordings.stateFor(sid)).toBe('stopped');
  });

  it('marks an ended session in History for a viewer who may know of it, and for no one else', async () => {
    const { fleet, r, sid } = await recording();
    const done = structuredClone(r) as Report;
    done.session.status = 'done';
    done.sentAt = T0 + 1000;
    await fleet.ingest(done);
    const day = [T0 - 86_400_000, T0 + 86_400_000] as const;
    const known = await fleet.history(day[0], day[1], () => true);
    expect(known.find((h) => h.id === sid)?.recording).toEqual({ keptUntil: expect.any(Number) });
    expect((await fleet.history(day[0], day[1], () => false)).find((h) => h.id === sid)?.recording).toBeUndefined();
    await fleet.features.setFeature('session-recording', false);
    expect((await fleet.history(day[0], day[1], () => true)).find((h) => h.id === sid)?.recording).toBeUndefined();
  });
});

describe('a session that goes', () => {
  it('takes its stored activity and its recording with it, in the background', async () => {
    const { fleet, r } = await make();
    await fleet.features.setFeature('session-recording', true);
    r.session.activity = [tool(T0), tool(T0 + 1)];
    await fleet.ingest(r);
    await fleet.recordings.start(r.session.id, [MAIN_LOOP], 'Ed', { name: 'n', project: null, owner: null });
    expect((await fleet.activityHistory.totals()).entries).toBe(2);
    expect(await fleet.deleteSession(r.session.id)).toBe(true);
    await fleet.activityHistory.idle();
    await vi.waitFor(async () => expect(await fleet.recordings.has(r.session.id)).toBe(false));
    expect((await fleet.activityHistory.totals()).entries).toBe(0);
  });

  it('is dropped from the stored activity by retention once the main database lets it go, and only then', async () => {
    const { fleet, storage, r } = await make();
    const keep = structuredClone(r) as Report;
    keep.session.id = 'kept';
    r.session.activity = [tool(T0)];
    keep.session.activity = [tool(T0)];
    await fleet.ingest(r);
    await fleet.ingest(keep);
    // the main database forgets one of them without the fleet's delete path (its own retention)
    await storage.fleet.deleteSession(r.session.id);
    await fleet.retain();
    await fleet.activityHistory.idle();
    await vi.waitFor(async () => expect((await fleet.activityHistory.totals()).sessions).toBe(1));
    expect((await fleet.activityHistory.page('kept', MAIN_LOOP, null)).entries).toHaveLength(1);
  });

  it('logs when retention cannot reach the stored activity or the recordings', async () => {
    const { fleet, errors } = await make();
    vi.spyOn(fleet.activityHistory, 'dropMissingSessions').mockRejectedValue(new Error('a'));
    vi.spyOn(fleet.recordings, 'dropMissingSessions').mockRejectedValue(new Error('b'));
    await fleet.retain();
    await tick();
    expect(errors.map((e) => e.event).sort()).toEqual(['retention.activity_failed', 'retention.recording_failed']);
  });
});
