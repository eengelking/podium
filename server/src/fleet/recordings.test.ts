// The session recording store (#353): consent, capture with dedupe and redaction, the two limits, per-part expiry, deletes, the
// Admin's lists and the paging of a replay. The HTTP side is in recordingRoutes.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { openActivityDb } from './activityDb.js';
import { MAIN_LOOP, RECORDING_DEFAULTS, type RecordingBatch, type RecordingEntry, type RecordingSettings } from './protocol.js';
import { SessionRecordings, type RecordingTrail } from './recordings.js';
import { HOUR_MS, MB } from './recordingSettings.js';

const T0 = 1_800_000_000_000;
const SECRET = 'the-admin-secret-0123456789';
const META = { name: 'billing', project: 'acme/billing', owner: 'Ed' };

function make(over: { authOn?: boolean; chunkRows?: number; exclusive?: boolean } = {}) {
  const db = openActivityDb(':memory:');
  const s = {
    now: T0,
    flag: true,
    live: new Set(['s1', 's2', 's3']),
    settings: { ...RECORDING_DEFAULTS } as RecordingSettings,
    agents: ['a1'],
  };
  const trails: RecordingTrail[] = [];
  const compacted = vi.fn(() => Promise.resolve(7));
  const rec = new SessionRecordings(db, {
    now: () => s.now,
    settings: () => s.settings,
    flagOn: () => s.flag,
    authOn: over.authOn ?? true,
    isLive: (id) => s.live.has(id),
    loopsOf: () => [{ loop: MAIN_LOOP, name: 'Orchestrator' }, ...s.agents.map((a) => ({ loop: a, name: `agent ${a}` }))],
    secrets: () => [SECRET],
    chunkRows: over.chunkRows,
    ...(over.exclusive ? { exclusive: <T>(fn: () => Promise<T>) => fn(), compact: compacted } : {}),
  });
  rec.trail = (t) => trails.push(t);
  return { rec, s, db, trails, compacted };
}

const entry = (loop: string, seq: number, text = `text ${seq}`, extra: Partial<RecordingEntry> = {}): RecordingEntry => ({ loop, seq, at: T0 + seq, kind: 'tool', text, ...extra });
const batch = (...entries: RecordingEntry[]): RecordingBatch => ({ v: 1, sentAt: T0, entries });

/** A recording that is chosen, with the owner's option on. */
function running(over: Parameters<typeof make>[0] = {}, loops = [MAIN_LOOP, 'a1']) {
  const m = make(over);
  m.rec.noteOption('s1', true);
  expect(m.rec.start('s1', loops, 'Ed', META)).toBe('ok');
  return m;
}

describe('the three yes answers', () => {
  it('grants nothing while no one has chosen the session, and says which answers are missing', () => {
    const { rec } = make();
    expect(rec.grant('s1')).toMatchObject({ state: 'off', consent: { admin: true, chosen: false, owner: false }, loops: [], keptUntil: null, bytes: 0 });
    rec.noteOption('s1', true);
    expect(rec.grant('s1').consent).toEqual({ admin: true, chosen: false, owner: true });
  });

  it('is off for every session while the flag is off, and when the server has no token', () => {
    const m = running();
    m.s.flag = false;
    expect(m.rec.enabled()).toBe(false);
    expect(m.rec.grant('s1')).toMatchObject({ state: 'off', consent: { admin: false, chosen: false, owner: true }, loops: [] });
    expect(m.rec.capturing('s1')).toBe(false);
    const open = make({ authOn: false });
    expect(open.rec.enabled()).toBe(false);
    expect(open.rec.grant('s1').consent.admin).toBe(false);
    expect(open.rec.view('s1')).toBeNull();
  });

  it('records only with the choice and the owner option together', () => {
    const { rec } = make();
    expect(rec.start('s1', [MAIN_LOOP], 'Ed', META)).toBe('ok');
    // chosen, but the owner has not allowed it: nothing is captured and the grant says why
    expect(rec.capturing('s1')).toBe(false);
    expect(rec.grant('s1')).toMatchObject({ state: 'recording', consent: { admin: true, chosen: true, owner: false }, loops: [MAIN_LOOP], startedBy: 'Ed', startedAt: T0 });
    rec.noteOption('s1', true);
    expect(rec.capturing('s1')).toBe(true);
    rec.noteOption('s1', undefined); // a reporter that does not send the option is read as off
    expect(rec.capturing('s1')).toBe(false);
    expect(rec.optionOn('s1')).toBe(false);
  });

  it('stops capturing when the session ends or the flag goes off, and keeps what it has', () => {
    const m = running();
    m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1)));
    m.s.live.delete('s1');
    expect(m.rec.grant('s1')).toMatchObject({ state: 'stopped', consent: { chosen: false }, loops: [] });
    expect(m.rec.capturing('s1')).toBe(false);
    m.s.live.add('s1');
    expect(m.rec.capturing('s1')).toBe(true);
    m.s.flag = false;
    expect(m.rec.view('s1')?.state).toBe('stopped');
    expect(m.rec.page('s1', null, 10, null).entries).toHaveLength(1);
  });

  it('forgets the option of a session that left', () => {
    const { rec } = make();
    rec.noteOption('s1', true);
    rec.forgetSession('s1');
    expect(rec.optionOn('s1')).toBe(false);
  });
});

describe('start and stop', () => {
  it('starts, changes the loops of a running recording without losing who started it, and starts a stopped one again', () => {
    const m = running();
    m.s.now = T0 + 1000;
    expect(m.rec.start('s1', [MAIN_LOOP], 'Boss', META)).toBe('ok');
    expect(m.rec.grant('s1')).toMatchObject({ state: 'recording', loops: [MAIN_LOOP], startedBy: 'Ed', startedAt: T0 });
    const out = m.rec.stop('s1', 'Boss');
    expect(out?.changed).toBe(true);
    m.s.now = T0 + 2000;
    expect(m.rec.start('s1', [MAIN_LOOP, 'a1'], 'Boss', META)).toBe('ok');
    expect(m.rec.grant('s1')).toMatchObject({ state: 'recording', loops: [MAIN_LOOP, 'a1'], startedBy: 'Boss', startedAt: T0 + 2000, stoppedBy: null, stoppedAt: null });
    // the earlier stop mark is kept
    expect(m.rec.page('s1', null, 10, null).entries.map((e) => e.kind)).toEqual(['stopped']);
  });

  it('stop keeps what was recorded, writes a mark naming who stopped it, and does nothing the second time', () => {
    const m = running();
    m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, 'first')));
    m.s.now = T0 + 5000;
    const out = m.rec.stop('s1', 'Boss');
    expect(out).toMatchObject({ changed: true, grant: { state: 'stopped', stoppedBy: 'Boss', stoppedAt: T0 + 5000, loops: [], consent: { chosen: false } } });
    expect(m.rec.stop('s1', 'Ed')).toMatchObject({ changed: false, grant: { state: 'stopped', stoppedBy: 'Boss' } });
    const rows = m.rec.page('s1', null, 10, null).entries;
    expect(rows.map((r) => [r.kind, r.text, r.by])).toEqual([
      ['tool', 'first', undefined],
      ['stopped', '', 'Boss'],
    ]);
    expect(m.rec.capturing('s1')).toBe(false);
    expect(m.rec.stop('nope', 'Ed')).toBeNull();
    expect(m.rec.stateFor('s1')).toBe('stopped');
    expect(m.rec.stateFor('nope')).toBeUndefined();
  });

  it('refuses to start again after a limit until the recording is deleted, and while a delete is going', async () => {
    const m = running();
    m.s.settings = { ...m.s.settings, sessionMb: 100 / MB };
    m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, 'x'.repeat(200))));
    expect(m.rec.grant('s1').state).toBe('limit');
    expect(m.rec.start('s1', [MAIN_LOOP], 'Ed', META)).toBe('limit');
    const gone = m.rec.removeMany(['s1']);
    m.rec.noteOption('s1', true);
    expect(m.rec.start('s1', [MAIN_LOOP], 'Ed', META)).toBe('busy');
    await gone;
    expect(m.rec.start('s1', [MAIN_LOOP], 'Ed', META)).toBe('ok');
  });

  it('stopAll stops every running recording, naming who, and tells the log', () => {
    const m = running();
    m.rec.noteOption('s2', true);
    m.rec.start('s2', [MAIN_LOOP], 'Ed', META);
    m.rec.stop('s2', 'Ed');
    expect(m.rec.stopAll('Admin')).toEqual(['s1']);
    expect(m.rec.grant('s1')).toMatchObject({ state: 'stopped', stoppedBy: 'Admin' });
    expect(m.trails).toEqual([{ kind: 'stopped', sessionId: 's1', by: 'Admin' }]);
    expect(m.rec.stopAll('Admin')).toEqual([]);
  });

  it('does not let a failing log write undo a stop', () => {
    const m = running();
    m.rec.trail = () => {
      throw new Error('log is full');
    };
    expect(m.rec.stopAll('Admin')).toEqual(['s1']);
    expect(m.rec.stateFor('s1')).toBe('stopped');
  });
});

describe('capture', () => {
  it('stores entries of the chosen loops once each, and drops a resend by (loop, seq)', () => {
    const m = running({}, [MAIN_LOOP]);
    const b = batch(entry(MAIN_LOOP, 1), entry(MAIN_LOOP, 2), entry('a1', 1, 'an agent that was not chosen'));
    expect(m.rec.ingest('s1', b)).toBe(2);
    expect(m.rec.ingest('s1', b)).toBe(0);
    expect(m.rec.ingest('s1', batch(entry(MAIN_LOOP, 2), entry(MAIN_LOOP, 3)))).toBe(1);
    const page = m.rec.page('s1', null, 10, null);
    expect(page.entries.map((e) => `${e.loop}:${e.text}`)).toEqual([`${MAIN_LOOP}:text 1`, `${MAIN_LOOP}:text 2`, `${MAIN_LOOP}:text 3`]);
    expect(page.total).toBe(3);
    expect(m.rec.ingest('nope', batch(entry(MAIN_LOOP, 1)))).toBe(0);
  });

  it('stores nothing of a batch that fails half way, and goes on working', () => {
    const m = running();
    expect(() => m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1), { ...entry(MAIN_LOOP, 2), at: undefined as never }))).toThrow();
    expect(m.rec.page('s1', null, 10, null).entries).toEqual([]);
    expect(m.rec.grant('s1').bytes).toBe(0);
    expect(m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1)))).toBe(1);
  });

  it('reads a damaged list of chosen loops as none', () => {
    const m = running();
    m.db.prepare('UPDATE rec_sessions SET loops = ?').run('not json');
    expect(m.rec.grant('s1').loops).toEqual([]);
    m.db.prepare('UPDATE rec_sessions SET loops = ?').run('{"a":1}');
    expect(m.rec.view('s1')?.loops.every((l) => !l.recorded)).toBe(true);
  });

  it('keeps every field of an entry and leaves out the ones that are not set', () => {
    const m = running();
    m.rec.ingest(
      's1',
      batch(
        entry(MAIN_LOOP, 1, 'ls -la', { kind: 'tool', name: 'Bash' }),
        entry(MAIN_LOOP, 2, 'total 0', { kind: 'result', name: 'Bash', callSeq: 1, failed: true, cut: true }),
        entry('a1', 1, '', { kind: 'gap', lost: 4 }),
        entry('a1', 2, '', { kind: 'thinking' }),
      ),
    );
    const rows = m.rec.page('s1', null, 10, null).entries;
    expect(rows[0]).toEqual({ n: 1, loop: MAIN_LOOP, at: T0 + 1, kind: 'tool', text: 'ls -la', name: 'Bash' });
    expect(rows[1]).toEqual({ n: 2, loop: MAIN_LOOP, at: T0 + 2, kind: 'result', text: 'total 0', name: 'Bash', callSeq: 1, failed: true, cut: true });
    expect(rows[2]).toMatchObject({ kind: 'gap', lost: 4, loop: 'a1' });
    expect(rows[3]).toEqual({ n: 4, loop: 'a1', at: T0 + 2, kind: 'thinking', text: '' });
  });

  it("replaces Podium's own credentials in what the mod sent, and nothing else", () => {
    const m = running();
    const token = 'pdm_0123456789ab_0123456789abcdef0123456789abcdef';
    m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, `curl -H "X-Podium-Token: ${token}" and ${SECRET} end`), entry(MAIN_LOOP, 2, 'password=hunter2 stays: the mod redacts, the server adds no pattern pass')));
    const rows = m.rec.page('s1', null, 10, null).entries;
    expect(rows[0]!.text).toBe('curl -H "X-Podium-Token: [redacted]" and [redacted] end');
    expect(rows[1]!.text).toContain('password=hunter2');
  });

  it('pages a replay newest first, oldest first within a page, with the older cursor, a loop filter and a clamped size', () => {
    const m = running();
    const entries: RecordingEntry[] = [];
    for (let i = 1; i <= 7; i++) entries.push(entry(i % 2 ? MAIN_LOOP : 'a1', Math.ceil(i / 2), `row ${i}`));
    m.rec.ingest('s1', batch(...entries));
    const newest = m.rec.page('s1', null, 3, null);
    expect(newest.entries.map((e) => e.text)).toEqual(['row 5', 'row 6', 'row 7']);
    expect(newest.olderBefore).toBe(5);
    expect(newest.total).toBe(7);
    const older = m.rec.page('s1', newest.olderBefore, 3, null);
    expect(older.entries.map((e) => e.text)).toEqual(['row 2', 'row 3', 'row 4']);
    const oldest = m.rec.page('s1', older.olderBefore, 3, null);
    expect(oldest.entries.map((e) => e.text)).toEqual(['row 1']);
    expect(oldest.olderBefore).toBeNull();
    const agent = m.rec.page('s1', null, 2, 'a1');
    expect(agent.entries.map((e) => e.text)).toEqual(['row 4', 'row 6']);
    expect(agent.olderBefore).toBe(4);
    expect(agent.total).toBe(3);
    expect(m.rec.page('s1', agent.olderBefore, 2, 'a1').olderBefore).toBeNull();
    expect(m.rec.page('s1', null, 99_999, null).entries).toHaveLength(7);
    expect(m.rec.page('s1', null, 0, null).entries).toHaveLength(7);
    expect(m.rec.page('nope', null, 5, null)).toEqual({ entries: [], olderBefore: null, total: 0 });
  });
});

describe('the session limit and the disk budget', () => {
  const hundred = 'x'.repeat(100);

  it('stops the recording with a limit mark at the entry that would pass the limit, and stores nothing after it', () => {
    const m = running();
    m.s.settings = { ...m.s.settings, sessionMb: 400 / MB };
    expect(m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, hundred), entry(MAIN_LOOP, 2, hundred), entry(MAIN_LOOP, 3, hundred), entry(MAIN_LOOP, 4, hundred)))).toBe(2);
    expect(m.rec.grant('s1')).toMatchObject({ state: 'limit', limit: 'session', consent: { chosen: false }, loops: [] });
    const rows = m.rec.page('s1', null, 10, null).entries;
    expect(rows.map((r) => r.kind)).toEqual(['tool', 'tool', 'limit']);
    expect(rows[2]!.text).toContain('size limit');
    expect(m.rec.capturing('s1')).toBe(false);
    expect(m.trails).toEqual([{ kind: 'limit', sessionId: 's1', which: 'session', bytes: 330 }]);
    expect(m.rec.view('s1')).toMatchObject({ state: 'limit', limit: 'session' });
  });

  it('does not count an entry it already holds against the limit', () => {
    const m = running();
    m.s.settings = { ...m.s.settings, sessionMb: 400 / MB };
    m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, hundred), entry(MAIN_LOOP, 2, hundred)));
    expect(m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, hundred), entry(MAIN_LOOP, 2, hundred)))).toBe(0);
    expect(m.rec.grant('s1').state).toBe('recording');
  });

  it('stops every running recording when the budget is reached, and takes no new one while the total is at it', () => {
    const m = running();
    m.rec.noteOption('s2', true);
    m.rec.start('s2', [MAIN_LOOP], 'Ed', META);
    m.s.settings = { ...m.s.settings, budgetMb: 400 / MB };
    expect(m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, hundred), entry(MAIN_LOOP, 2, hundred)))).toBe(2);
    expect(m.rec.ingest('s2', batch(entry(MAIN_LOOP, 1, hundred)))).toBe(0);
    expect(m.rec.grant('s2')).toMatchObject({ state: 'limit', limit: 'budget' });
    expect(m.rec.grant('s1')).toMatchObject({ state: 'limit', limit: 'budget' });
    expect(m.trails.map((t) => t.kind === 'limit' && t.which)).toEqual(['budget', 'budget']);
    expect(m.rec.page('s1', null, 10, null).entries.at(-1)?.kind).toBe('limit');
    expect(m.rec.totalBytes()).toBeGreaterThanOrEqual(400);
    expect(m.rec.start('s3', [MAIN_LOOP], 'Ed', META)).toBe('budget');
  });
});

describe('expiry, part by part', () => {
  it('removes each part keepHours after it was recorded, and shows the oldest part that is left as the time it goes', async () => {
    const m = running({ chunkRows: 3 });
    m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, 'early 1'), entry(MAIN_LOOP, 2, 'early 2')));
    m.s.now = T0 + 3 * HOUR_MS;
    m.rec.ingest('s1', batch(entry(MAIN_LOOP, 3, 'later 1'), entry(MAIN_LOOP, 4, 'later 2'), entry(MAIN_LOOP, 5, 'later 3')));
    expect(m.rec.grant('s1').keptUntil).toBe(T0 + 6 * HOUR_MS);
    expect(await m.rec.purge(T0 + 6 * HOUR_MS)).toMatchObject({ entries: 0 }); // not older than six hours yet
    m.s.now = T0 + 6 * HOUR_MS + 1;
    const out = await m.rec.purge();
    expect(out).toMatchObject({ entries: 2, sessions: 1 });
    expect(out.bytes).toBeGreaterThan(0);
    expect(m.rec.page('s1', null, 10, null).entries.map((e) => e.text)).toEqual(['later 1', 'later 2', 'later 3']);
    expect(m.rec.grant('s1').keptUntil).toBe(T0 + 9 * HOUR_MS);
    expect(m.rec.totals()).toMatchObject({ recordings: 1 });
  });

  it('removes in chunks, honors a short keep time at once, and compacts the file when it removed something', async () => {
    const m = running({ chunkRows: 3, exclusive: true });
    m.rec.ingest('s1', batch(...Array.from({ length: 7 }, (_, i) => entry(MAIN_LOOP, i + 1))));
    m.s.settings = { ...m.s.settings, keepHours: 1 };
    m.s.now = T0 + HOUR_MS + 5;
    expect(await m.rec.purge()).toEqual({ entries: 7, bytes: expect.any(Number), sessions: 1, freed: 7 });
    expect(m.compacted).toHaveBeenCalledTimes(1);
    expect((await m.rec.purge()).freed).toBe(0);
    expect(m.compacted).toHaveBeenCalledTimes(1);
    // the session is still running, so its empty recording stays
    expect(m.rec.has('s1')).toBe(true);
    expect(m.rec.grant('s1')).toMatchObject({ state: 'recording', bytes: 0, keptUntil: T0 + 2 * HOUR_MS + 5 });
  });

  it('drops a recording that expired completely, unless it is still running', async () => {
    const m = running();
    m.rec.noteOption('s2', true);
    m.rec.start('s2', [MAIN_LOOP], 'Ed', META);
    m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1)));
    m.rec.stop('s1', 'Ed');
    m.s.now = T0 + 7 * HOUR_MS;
    await m.rec.purge();
    expect(m.rec.has('s1')).toBe(false);
    expect(m.rec.has('s2')).toBe(true);
    m.s.live.delete('s2');
    await m.rec.purge();
    expect(m.rec.has('s2')).toBe(false);
  });
});

describe('deleting', () => {
  it('removes the recording and its entries, stops capture at once, and reports what went', async () => {
    const m = running({ exclusive: true });
    m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1), entry(MAIN_LOOP, 2)));
    const bytes = m.rec.grant('s1').bytes;
    const pending = m.rec.removeMany(['s1', 'missing']);
    expect(m.rec.has('s1')).toBe(false);
    expect(m.rec.capturing('s1')).toBe(false);
    const out = await pending;
    expect(out).toMatchObject({ entries: 2, sessions: 1, bytes, freed: 7, each: [{ sessionId: 's1', name: 'billing', entries: 2, bytes }] });
    expect(m.rec.page('s1', null, 10, null).entries).toEqual([]);
    expect(await m.rec.removeMany(['s1'])).toEqual({ entries: 0, sessions: 0, bytes: 0, freed: 0, each: [] });
  });

  it('removes a long recording in chunks', async () => {
    const m = running({ chunkRows: 2 });
    m.rec.ingest('s1', batch(...Array.from({ length: 5 }, (_, i) => entry(MAIN_LOOP, i + 1))));
    const out = await m.rec.removeSession('s1');
    expect(out.entries).toBe(5);
    expect((m.db.prepare('SELECT COUNT(*) AS c FROM rec_entries').get() as { c: number }).c).toBe(0);
  });

  it("removes the recordings of sessions the main database no longer holds, and only those", async () => {
    const m = running();
    m.rec.noteOption('s2', true);
    m.rec.start('s2', [MAIN_LOOP], 'Ed', META);
    m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1)));
    expect(await m.rec.dropMissingSessions((id) => id === 's2')).toBe(1);
    expect(m.rec.has('s1')).toBe(false);
    expect(m.rec.has('s2')).toBe(true);
    expect(await m.rec.dropMissingSessions(() => true)).toBe(0);
  });
});

describe('a /clear', () => {
  it('carries a running recording over to the new session with its starter, once, and only for the orchestrator', () => {
    const m = running();
    m.s.live.add('s9');
    expect(m.rec.carryOver('s1', 's9', META)).toBe(true);
    expect(m.rec.grant('s9')).toMatchObject({ state: 'recording', loops: [MAIN_LOOP], startedBy: 'Ed', startedAt: T0 });
    expect(m.rec.stateFor('s1')).toBe('stopped');
    expect(m.trails).toEqual([{ kind: 'carried', sessionId: 's9', from: 's1', by: 'Ed' }]);
    // the new session already has a recording, and the old one is no longer running
    expect(m.rec.carryOver('s1', 's9', META)).toBe(false);
  });

  it('carries nothing over when the old session was not recording, did not record the orchestrator, or the flag is off', () => {
    const m = make();
    expect(m.rec.carryOver('s1', 's9', META)).toBe(false);
    m.rec.start('s1', ['a1'], 'Ed', META);
    expect(m.rec.carryOver('s1', 's9', META)).toBe(false);
    m.rec.start('s1', [MAIN_LOOP], 'Ed', META);
    m.s.flag = false;
    expect(m.rec.carryOver('s1', 's9', META)).toBe(false);
    expect(m.rec.has('s9')).toBe(false);
  });

  it('carries nothing over to a session whose recording is still being deleted', async () => {
    const m = running();
    m.rec.start('s9', [MAIN_LOOP], 'Ed', META);
    const pending = m.rec.removeMany(['s9']);
    expect(m.rec.carryOver('s1', 's9', META)).toBe(false);
    await pending;
  });
});

describe('a prompt delivered from Podium', () => {
  it('is kept as a prompt entry with who sent it, redacted, for a loop that is being captured', () => {
    const m = running({}, [MAIN_LOOP]);
    m.rec.addPodiumPrompt('s1', MAIN_LOOP, { at: T0 + 10, text: `Answer from Ed: use password=hunter2 and ${SECRET}`, by: 'Ed' });
    m.rec.addPodiumPrompt('s1', MAIN_LOOP, { at: T0 + 11, text: 'second', by: 'Ed' });
    const rows = m.rec.page('s1', null, 10, null).entries;
    expect(rows.map((r) => [r.kind, r.by, r.at])).toEqual([
      ['prompt', 'Ed', T0 + 10],
      ['prompt', 'Ed', T0 + 11],
    ]);
    expect(rows[0]!.text).toBe('Answer from Ed: use password=[redacted] and [redacted]');
  });

  it('is not kept when capture is off, or for a loop nobody chose', () => {
    const m = running({}, [MAIN_LOOP]);
    m.rec.addPodiumPrompt('s1', 'a1', { at: T0, text: 'for an agent', by: 'Ed' });
    m.rec.noteOption('s1', false);
    m.rec.addPodiumPrompt('s1', MAIN_LOOP, { at: T0, text: 'owner has not allowed it', by: 'Ed' });
    m.rec.addPodiumPrompt('s2', MAIN_LOOP, { at: T0, text: 'nothing chosen', by: 'Ed' });
    expect(m.rec.page('s1', null, 10, null).entries).toEqual([]);
  });
});

describe('what everyone sees, and what the Admin lists', () => {
  it('shows the state, the starter, every loop with whether it is recorded and when it goes, and no text', () => {
    const m = running({}, [MAIN_LOOP]);
    m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1, 'SECRET BODY')));
    const v = m.rec.view('s1')!;
    expect(v).toMatchObject({ state: 'recording', startedBy: 'Ed', ownerAllows: true, keptUntil: T0 + 6 * HOUR_MS, limit: null });
    expect(v.loops).toEqual([
      { loop: MAIN_LOOP, name: 'Orchestrator', recorded: true },
      { loop: 'a1', name: 'agent a1', recorded: false },
    ]);
    expect(JSON.stringify(v)).not.toContain('SECRET BODY');
    expect(m.rec.view('s2')).toBeNull();
    expect(m.rec.loopInfo('s2').every((l) => !l.recorded)).toBe(true);
  });

  it('lists recordings for the Admin with labels, state and size, filtered and paged', () => {
    const m = running();
    m.rec.noteOption('s2', true);
    m.rec.start('s2', [MAIN_LOOP], 'Boss', { name: 'api', project: null, owner: 'Alex' });
    m.rec.noteOption('s3', true);
    m.rec.start('s3', ['a1'], 'Boss', { name: 'web', project: null, owner: null });
    m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1)));
    m.rec.stop('s2', 'Boss');
    const all = m.rec.adminList({ page: 1, pageSize: 25 });
    expect(all.total).toBe(3);
    expect(all.totals).toMatchObject({ recordings: 3, running: 2 });
    const byId = Object.fromEntries(all.rows.map((r) => [r.sessionId, r]));
    expect(byId.s1).toMatchObject({ state: 'recording', label: 'orchestrator and 1 agent', loops: 2, startedBy: 'Ed', owner: 'Ed' });
    expect(byId.s2).toMatchObject({ state: 'stopped', label: 'orchestrator' });
    expect(byId.s3).toMatchObject({ label: '1 agent' });
    expect(m.rec.adminList({ page: 1, pageSize: 25, state: 'stopped' }).rows.map((r) => r.sessionId)).toEqual(['s2']);
    expect(m.rec.adminList({ page: 1, pageSize: 25, q: 'ALEX' }).rows.map((r) => r.sessionId)).toEqual(['s2']);
    expect(m.rec.adminList({ page: 1, pageSize: 25, q: 'web' }).rows.map((r) => r.sessionId)).toEqual(['s3']);
    expect(m.rec.adminList({ page: 1, pageSize: 25, q: 's1' }).rows.map((r) => r.sessionId)).toEqual(['s1']);
    const paged = m.rec.adminList({ page: 2, pageSize: 2 });
    expect(paged).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(paged.rows).toHaveLength(1);
    expect(m.rec.adminList({ page: 0, pageSize: 0 })).toMatchObject({ page: 1, pageSize: 25 });
  });

  it('lists the same recordings for Stored activity, with its filters, totals and distinct values', () => {
    const m = running();
    m.rec.noteOption('s2', true);
    m.rec.start('s2', [MAIN_LOOP], 'Boss', { name: 'api', project: 'acme/api', owner: 'Alex' });
    m.rec.ingest('s1', batch(entry(MAIN_LOOP, 1), entry(MAIN_LOOP, 2)));
    m.s.now = T0 + 3 * HOUR_MS;
    m.rec.ingest('s2', batch(entry(MAIN_LOOP, 1)));
    const all = m.rec.listStored({}, 1, 25);
    expect(all).toMatchObject({ total: 2, page: 1, pageSize: 25, projects: ['acme/api', 'acme/billing'], owners: ['Alex', 'Ed'] });
    expect(all.totals).toMatchObject({ entries: 3, sessions: 2, fileBytes: 0 });
    expect(all.match).toMatchObject({ entries: 3, sessions: 2 });
    expect(all.rows.map((r) => r.sessionId)).toEqual(['s2', 's1']);
    expect(all.rows[1]).toMatchObject({ name: 'billing', owner: 'Ed', live: true, entries: 2, oldestAt: T0 });
    const f = (x: object) => m.rec.listStored(x, 1, 25).rows.map((r) => r.sessionId);
    expect(f({ q: 'API' })).toEqual(['s2']);
    expect(f({ q: 's1' })).toEqual(['s1']);
    expect(f({ project: 'acme/billing' })).toEqual(['s1']);
    expect(f({ owner: 'Alex' })).toEqual(['s2']);
    expect(f({ olderThanDays: 0.1 })).toEqual(['s1']);
    expect(f({ from: T0 + HOUR_MS })).toEqual(['s2']);
    expect(f({ to: T0 + HOUR_MS })).toEqual(['s1']);
    expect(m.rec.listStored({}, 3, 1).rows.map((r) => r.sessionId)).toEqual([]);
    expect(m.rec.listStored({}, 0, 0)).toMatchObject({ page: 1, pageSize: 25 });
    expect(m.rec.idsFor({ ids: ['x'] })).toEqual(['x']);
    expect(m.rec.idsFor({ match: { owner: 'Ed' } })).toEqual(['s1']);
    expect(m.rec.idsFor({ all: true }).sort()).toEqual(['s1', 's2']);
  });

  it('counts a recording with nothing stored in the Admin totals but not in Stored activity', () => {
    const m = running();
    expect(m.rec.totals()).toEqual({ recordings: 1, bytes: 0, running: 1 });
    expect(m.rec.listStored({}, 1, 25).total).toBe(0);
  });
});
