// The 5-minute purge of session recordings (#353), as the sweeper runs it, and the scrub of what the server stores whole.
import { describe, expect, it, vi } from 'vitest';
import { openSqliteStorage } from '../storage/sqlite/index.js';
import type { PeopleStoreApi } from '../storage/types.js';
import { openActivityDb } from './activityDb.js';
import { ActivityHistory } from './activityHistory.js';
import { ActivityHistorySettingsStore } from './activityHistorySettings.js';
import { SessionRecordings } from './recordings.js';
import { MAIN_LOOP, RECORDING_DEFAULTS } from './protocol.js';
import { HOUR_MS } from './recordingSettings.js';
import { purgeRecordings, purgeStored } from './sweeper.js';
import { scrubStored } from '../logging/redact.js';

const T0 = 1_800_000_000_000;
const BODY = 'UNIQUE-RECORDED-TEXT-3318';

function setup() {
  const storage = openSqliteStorage(':memory:');
  const db = storage.sqliteHandle;
  const people = storage.people;
  const activity = openActivityDb(':memory:');
  const clock = { now: T0 };
  const settings = new ActivityHistorySettingsStore(db, true);
  const history = new ActivityHistory(activity, { now: () => clock.now, settings: () => settings.get(), isLive: () => false, authOn: true });
  const rec = new SessionRecordings(activity, {
    now: () => clock.now,
    settings: () => RECORDING_DEFAULTS,
    flagOn: () => true,
    authOn: true,
    isLive: () => true,
    loopsOf: () => [{ loop: MAIN_LOOP, name: 'Orchestrator' }],
    exclusive: (fn) => history.runExclusive(fn),
    compact: () => history.compactNow(),
  });
  const info = vi.fn();
  const logger = { info } as never;
  rec.noteOption('s1', true);
  rec.start('s1', [MAIN_LOOP], 'Ed', { name: 'billing', project: null, owner: 'Ed' });
  rec.ingest('s1', { v: 1, sentAt: T0, entries: [{ loop: MAIN_LOOP, seq: 1, at: T0, kind: 'tool', text: BODY }] });
  return { rec, people, history, clock, info, logger };
}

const rows = async (people: PeopleStoreApi) => (await people.listLog({ page: 1, pageSize: 50 })).rows;

describe('purgeRecordings', () => {
  it('is silent when nothing is older than the keep time', async () => {
    const { rec, people, logger, info } = setup();
    await purgeRecordings(rec, people, logger, T0 + HOUR_MS);
    expect(await rows(people)).toEqual([]);
    expect(info).not.toHaveBeenCalled();
  });

  it('writes one Admin log row and one log line for a run that removed something, with counts and never text', async () => {
    const { rec, people, logger, info } = setup();
    await purgeRecordings(rec, people, logger, T0 + 7 * HOUR_MS);
    const log = await rows(people);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: 'recording_purged', actor: null });
    expect(log[0]!.detail).toMatch(/^1 entry \(.+\) removed from 1 recording$/);
    expect(info).toHaveBeenCalledWith('recording.purged', expect.any(String), { entries: 1, bytes: expect.any(Number), sessions: 1, freed: expect.any(Number) });
    expect(JSON.stringify(log) + JSON.stringify(info.mock.calls)).not.toContain(BODY);
  });

  it('skips a run that starts while the last is still going', async () => {
    const { rec, people, logger } = setup();
    const first = purgeRecordings(rec, people, logger, T0 + 7 * HOUR_MS);
    await purgeRecordings(rec, people, logger, T0 + 7 * HOUR_MS);
    await first;
    expect(await rows(people)).toHaveLength(1);
    // and it can run again afterwards, also after a failure
    vi.spyOn(rec, 'purge').mockRejectedValueOnce(new Error('locked'));
    await expect(purgeRecordings(rec, people, logger, T0)).rejects.toThrow('locked');
    await purgeRecordings(rec, people, logger, T0);
  });
});

describe('purgeStored', () => {
  it('runs the history and the recordings, and throws the first failure after both have finished', async () => {
    const { rec, people, history, logger } = setup();
    const purged = vi.spyOn(history, 'purge');
    await purgeStored(history, rec, people, logger, T0 + 7 * HOUR_MS);
    expect(purged).toHaveBeenCalled();
    expect((await rows(people)).map((r) => r.kind)).toEqual(['recording_purged']);
    const recPurge = vi.spyOn(rec, 'purge').mockRejectedValue(new Error('locked'));
    await expect(purgeStored(history, rec, people, logger, T0)).rejects.toThrow('locked');
    expect(purged).toHaveBeenCalledTimes(2);
    recPurge.mockRestore();
  });
});

describe('scrubStored', () => {
  const SECRET = 'the-admin-secret-0123456789';
  const TOKEN = 'pdm_0123456789ab_0123456789abcdef0123456789abcdef';

  it('replaces a person token and the server secret and keeps line breaks and length', () => {
    const text = `line one ${TOKEN}\n${SECRET}\n  indented ${'z'.repeat(2000)}`;
    const out = scrubStored(text, [SECRET], false);
    expect(out).toBe(`line one [redacted]\n[redacted]\n  indented ${'z'.repeat(2000)}`);
  });

  it('ignores a secret too short to tell from text, and an empty one', () => {
    expect(scrubStored('a short pw and more', ['short', ''], false)).toBe('a short pw and more');
  });

  it('also replaces the common secret shapes when asked, for text the server wrote itself', () => {
    expect(scrubStored('use password=hunter2 and sk-abcdefghijklmnopqrstu please', [], true)).toBe('use password=[redacted] and [redacted] please');
    expect(scrubStored('use password=hunter2', [], false)).toBe('use password=hunter2');
  });
});
