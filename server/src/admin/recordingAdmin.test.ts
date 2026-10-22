// The Admin routes for session recording (#353): the limits, the Recordings table with stop and delete, and the recordings
// on the Stored activity page (Source = Recordings).
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openDb } from '../fleet/db.js';
import { PeopleStore } from '../fleet/people.js';
import { openActivityDb } from '../fleet/activityDb.js';
import { ActivityHistory } from '../fleet/activityHistory.js';
import { ActivityHistorySettingsStore } from '../fleet/activityHistorySettings.js';
import { SessionRecordings } from '../fleet/recordings.js';
import { RecordingSettingsStore } from '../fleet/recordingSettings.js';
import { MAIN_LOOP } from '../fleet/protocol.js';
import { createAdminRouter } from './adminRouter.js';

const SECRET = 'the-admin-secret-0123456789';
const H = { 'X-Podium-Admin': '1' };
const T0 = 1_800_000_000_000;
const BODY = 'UNIQUE-RECORDED-TEXT-9042';

function setup(over: { withRecordings?: boolean; withHistory?: boolean } = {}) {
  const db = openDb(':memory:');
  const people = new PeopleStore(db);
  const settings = new RecordingSettingsStore(db);
  const activity = openActivityDb(':memory:');
  const service = new SessionRecordings(activity, {
    now: () => T0,
    settings: () => settings.get(),
    flagOn: () => true,
    authOn: true,
    isLive: () => true,
    loopsOf: () => [{ loop: MAIN_LOOP, name: 'Orchestrator' }],
  });
  const histSettings = new ActivityHistorySettingsStore(db, true);
  const history = new ActivityHistory(activity, { now: () => T0, settings: () => histSettings.get(), isLive: () => false, authOn: true });
  const changed = vi.fn();
  const app = express();
  app.use(
    '/api/admin',
    createAdminRouter({
      secret: SECRET,
      people,
      now: () => T0,
      log: () => {},
      ...(over.withRecordings === false ? {} : { recordings: { service, settings, changed } }),
      ...(over.withHistory ? { activityHistory: { history, settings: histSettings } } : {}),
    }),
  );
  return { app, people, settings, service, changed };
}

async function unlocked(over: Parameters<typeof setup>[0] = {}) {
  const s = setup(over);
  const agent = request.agent(s.app);
  expect((await agent.post('/api/admin/unlock').set(H).send({ name: 'Admin', token: SECRET })).status).toBe(200);
  return { ...s, agent };
}

function record(service: SessionRecordings, id: string, over: { owner?: string; name?: string; project?: string | null; loops?: string[]; n?: number } = {}) {
  service.noteOption(id, true);
  service.start(id, over.loops ?? [MAIN_LOOP], 'Ed', { name: over.name ?? `name-${id}`, project: over.project ?? 'acme/billing', owner: over.owner ?? 'Ed' });
  const entries = Array.from({ length: over.n ?? 2 }, (_, i) => ({ loop: MAIN_LOOP, seq: i + 1, at: T0 + i, kind: 'tool' as const, text: `${BODY} ${i}` }));
  service.ingest(id, { v: 1, sentAt: T0, entries });
}

const logRows = (people: PeopleStore) => people.listLog({ page: 1, pageSize: 100 }).rows;

describe('GET and PUT /settings carry session recording', () => {
  it('reads the limits, the totals and whether a token is set', async () => {
    const { agent, service } = await unlocked();
    record(service, 's1');
    const res = await agent.get('/api/admin/settings');
    expect(res.body.recording).toEqual({ settings: { keepHours: 6, budgetMb: 4096, sessionMb: 512 }, totals: { recordings: 1, bytes: expect.any(Number), running: 1 }, authOn: true });
    expect(res.body.recording.totals.bytes).toBeGreaterThan(0);
    expect(res.body.features.find((f: { id: string }) => f.id === 'session-recording')).toMatchObject({ on: false });
  });

  it('leaves the group out when the server has no recording store', async () => {
    const { agent } = await unlocked({ withRecordings: false });
    expect((await agent.get('/api/admin/settings')).body.recording).toBeUndefined();
    expect((await agent.put('/api/admin/settings').set(H).send({ recording: { keepHours: 12 } })).status).toBe(400);
  });

  it('saves a change, answers the new state, and writes both values to the Admin log', async () => {
    const { agent, people, settings } = await unlocked();
    const res = await agent.put('/api/admin/settings').set(H).send({ recording: { keepHours: 12, sessionMb: 128 } });
    expect(res.status).toBe(200);
    expect(res.body.recording.settings).toEqual({ keepHours: 12, budgetMb: 4096, sessionMb: 128 });
    expect(settings.get()).toEqual({ keepHours: 12, budgetMb: 4096, sessionMb: 128 });
    const row = logRows(people).find((r) => r.kind === 'recording_settings_changed');
    expect(row?.detail).toBe('Session recording limits: kept 6 to 12 hours, disk budget 4096 to 4096 MB, one session 512 to 128 MB');
    expect(row?.actor).toBe('Admin secret');
  });

  it.each([
    ['text', 'give keepHours'],
    ['an array', 'give keepHours'],
    ['an empty object', 'nothing to change'],
    ['an unknown field', 'unknown setting: nope'],
    ['keepHours below 1', 'from 1 to 168'],
    ['keepHours above 7 days', 'from 1 to 168'],
    ['a fraction', 'whole number'],
    ['budgetMb below 64', 'from 64 to 102400'],
    ['sessionMb below 8', 'from 8 to 4096'],
    ['a session limit above the budget', 'cannot be above the disk budget'],
  ])('refuses %s with 400', async (name, word) => {
    const { agent, settings } = await unlocked();
    const bodies: Record<string, unknown> = {
      text: 'x',
      'an array': [1],
      'an empty object': {},
      'an unknown field': { nope: 1 },
      'keepHours below 1': { keepHours: 0 },
      'keepHours above 7 days': { keepHours: 169 },
      'a fraction': { keepHours: 1.5 },
      'budgetMb below 64': { budgetMb: 10 },
      'sessionMb below 8': { sessionMb: 1 },
      'a session limit above the budget': { budgetMb: 100, sessionMb: 200 },
    };
    const res = await agent.put('/api/admin/settings').set(H).send({ recording: bodies[name] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(word);
    expect(settings.get()).toEqual({ keepHours: 6, budgetMb: 4096, sessionMb: 512 });
  });

  it('reads a damaged saved row as the defaults, field by field', async () => {
    const { settings } = setup();
    const db = (settings as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('recording_settings', '{"keepHours":24,"budgetMb":"big","sessionMb":9999999}');
    expect(settings.get()).toEqual({ keepHours: 24, budgetMb: 4096, sessionMb: 512 });
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('not json', 'recording_settings');
    expect(settings.get()).toEqual({ keepHours: 6, budgetMb: 4096, sessionMb: 512 });
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('7', 'recording_settings');
    expect(settings.get()).toEqual({ keepHours: 6, budgetMb: 4096, sessionMb: 512 });
  });

  it('needs the Admin unlocked and the cross-site header', async () => {
    const { app } = setup();
    expect((await request(app).get('/api/admin/recordings')).status).toBe(401);
    const { agent } = await unlocked();
    expect((await agent.put('/api/admin/settings').send({ recording: { keepHours: 12 } })).status).toBe(403);
  });
});

describe('GET /recordings', () => {
  it('lists the recordings with owner, starter, state, size and when they go, paged and filtered', async () => {
    const { agent, service } = await unlocked();
    record(service, 's1', { owner: 'Ed', name: 'billing' });
    record(service, 's2', { owner: 'Alex', name: 'api', loops: [MAIN_LOOP] });
    service.stop('s2', 'Admin');
    const all = (await agent.get('/api/admin/recordings')).body;
    expect(all).toMatchObject({ total: 2, page: 1, pageSize: 25, totals: { recordings: 2, running: 1 } });
    expect(all.rows[0]).toMatchObject({ sessionId: expect.any(String), name: expect.any(String), owner: expect.any(String), startedBy: 'Ed', state: expect.any(String), label: 'orchestrator', loops: 1, keptUntil: T0 + 6 * 3_600_000 });
    expect((await agent.get('/api/admin/recordings?state=stopped')).body.rows.map((r: { sessionId: string }) => r.sessionId)).toEqual(['s2']);
    expect((await agent.get('/api/admin/recordings?q=alex')).body.rows.map((r: { sessionId: string }) => r.sessionId)).toEqual(['s2']);
    expect((await agent.get('/api/admin/recordings?pageSize=1&page=2')).body.rows).toHaveLength(1);
    expect(JSON.stringify(all)).not.toContain(BODY);
  });

  it.each(['state=nope', 'page=0', 'pageSize=500', `q=${'x'.repeat(201)}`])('refuses %s with 400', async (q) => {
    const { agent } = await unlocked();
    expect((await agent.get(`/api/admin/recordings?${q}`)).status).toBe(400);
  });

  it('is 404 without a recording store', async () => {
    const { agent } = await unlocked({ withRecordings: false });
    expect((await agent.get('/api/admin/recordings')).status).toBe(404);
    expect((await agent.post('/api/admin/recordings/s1/stop').set(H)).status).toBe(404);
    expect((await agent.delete('/api/admin/recordings/s1').set(H)).status).toBe(404);
  });
});

describe('POST /recordings/:id/stop and DELETE /recordings/:id', () => {
  it('stops any session\'s recording as the Admin, once, and tells open consoles', async () => {
    const { agent, service, people, changed } = await unlocked();
    record(service, 's1');
    const res = await agent.post('/api/admin/recordings/s1/stop').set(H);
    expect(res.status).toBe(200);
    expect(res.body.grant).toMatchObject({ state: 'stopped', stoppedBy: 'Admin' });
    expect(changed).toHaveBeenCalledWith('s1');
    const stopped = logRows(people).filter((r) => r.kind === 'recording_stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ actor: 'Admin secret' });
    expect((await agent.post('/api/admin/recordings/s1/stop').set(H)).status).toBe(200);
    expect(logRows(people).filter((r) => r.kind === 'recording_stopped')).toHaveLength(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect((await agent.post('/api/admin/recordings/nope/stop').set(H)).status).toBe(404);
  });

  it('names the administrator who stopped it on the mark', async () => {
    const s = setup();
    const boss = s.people.createPerson('Boss');
    s.people.setGroup(boss.person.id, s.people.administratorsGroupId());
    const agent = request.agent(s.app);
    expect((await agent.post('/api/admin/unlock').set(H).send({ name: 'Boss', token: boss.token })).status).toBe(200);
    record(s.service, 's1');
    await agent.post('/api/admin/recordings/s1/stop').set(H);
    expect(s.service.page('s1', null, 10, null).entries.at(-1)).toMatchObject({ kind: 'stopped', by: 'Boss' });
    expect(logRows(s.people).find((r) => r.kind === 'recording_stopped')).toMatchObject({ actor: 'Boss' });
  });

  it('deletes any session\'s recording for good, logs the counts, and tells open consoles', async () => {
    const { agent, service, people, changed } = await unlocked();
    record(service, 's1');
    const res = await agent.delete('/api/admin/recordings/s1').set(H);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, entries: 2 });
    expect(service.has('s1')).toBe(false);
    expect(changed).toHaveBeenCalledWith('s1');
    const row = logRows(people).find((r) => r.kind === 'recording_deleted');
    expect(row?.detail).toBe(`Deleted the recording of name-s1 (s1): 2 entries, ${row?.detail.split(', ')[1]}`);
    expect(row).toMatchObject({ actor: 'Admin secret' });
    expect(JSON.stringify(logRows(people))).not.toContain(BODY);
    expect((await agent.delete('/api/admin/recordings/s1').set(H)).status).toBe(404);
  });

  it('answers 500 when the store cannot be reached', async () => {
    const { agent, service } = await unlocked();
    record(service, 's1');
    vi.spyOn(service, 'removeMany').mockRejectedValue(new Error('disk is gone'));
    const res = await agent.delete('/api/admin/recordings/s1').set(H);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('disk is gone');
  });
});

describe('Stored activity with Source = Recordings', () => {
  it('lists the recordings in the Stored activity shape, with the file size from the history when there is one', async () => {
    const { agent, service } = await unlocked({ withHistory: true });
    record(service, 's1', { owner: 'Ed', project: 'acme/billing' });
    record(service, 's2', { owner: 'Alex', project: 'acme/api' });
    const res = await agent.get('/api/admin/stored-activity?source=recordings');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, page: 1, pageSize: 25, projects: ['acme/api', 'acme/billing'], owners: ['Alex', 'Ed'] });
    expect(res.body.totals).toMatchObject({ entries: 4, sessions: 2 });
    expect(res.body.totals.fileBytes).toBeGreaterThan(0);
    expect(res.body.rows[0]).toMatchObject({ entries: 2, live: true });
    expect((await agent.get('/api/admin/stored-activity?source=recordings&owner=Alex')).body.rows.map((r: { sessionId: string }) => r.sessionId)).toEqual(['s2']);
    // without Source the page is the Activity history's, which holds none of these
    expect((await agent.get('/api/admin/stored-activity')).body.total).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain(BODY);
  });

  it('works without the Activity history (file size 0) and 404 without the recordings', async () => {
    const { agent, service } = await unlocked();
    record(service, 's1');
    expect((await agent.get('/api/admin/stored-activity?source=recordings')).body.totals.fileBytes).toBe(0);
    const off = await unlocked({ withRecordings: false, withHistory: true });
    expect((await off.agent.get('/api/admin/stored-activity?source=recordings')).status).toBe(404);
    expect((await off.agent.post('/api/admin/stored-activity/delete').set(H).send({ ids: ['s1'], source: 'recordings' })).status).toBe(404);
  });

  it('deletes ticked recordings, one Admin log row each, and leaves the Activity history alone', async () => {
    const { agent, service, people, changed } = await unlocked({ withHistory: true });
    record(service, 's1');
    record(service, 's2');
    record(service, 's3');
    const res = await agent.post('/api/admin/stored-activity/delete').set(H).send({ ids: ['s1', 's2'], source: 'recordings' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ entries: 4, sessions: 2 });
    expect(service.has('s1') || service.has('s2')).toBe(false);
    expect(service.has('s3')).toBe(true);
    expect(logRows(people).filter((r) => r.kind === 'recording_deleted')).toHaveLength(2);
    expect(logRows(people).some((r) => r.kind === 'activity_deleted')).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('deletes what a filter matches, and everything', async () => {
    const { agent, service } = await unlocked({ withHistory: true });
    record(service, 's1', { owner: 'Ed' });
    record(service, 's2', { owner: 'Alex' });
    expect((await agent.post('/api/admin/stored-activity/delete').set(H).send({ match: { source: 'recordings', owner: 'Alex' } })).body).toMatchObject({ sessions: 1 });
    expect(service.has('s2')).toBe(false);
    expect((await agent.post('/api/admin/stored-activity/delete').set(H).send({ match: { source: 'recordings' } })).status).toBe(400);
    expect((await agent.post('/api/admin/stored-activity/delete').set(H).send({ all: true, source: 'recordings' })).body).toMatchObject({ sessions: 1 });
    expect(service.has('s1')).toBe(false);
  });

  it('answers 500 when the recordings cannot be reached', async () => {
    const { agent, service } = await unlocked({ withHistory: true });
    record(service, 's1');
    vi.spyOn(service, 'removeMany').mockRejectedValue(new Error('disk is gone'));
    expect((await agent.post('/api/admin/stored-activity/delete').set(H).send({ ids: ['s1'], source: 'recordings' })).status).toBe(500);
  });

  it('still deletes from the Activity history for a body that names it', async () => {
    const { agent } = await unlocked({ withHistory: true });
    expect((await agent.post('/api/admin/stored-activity/delete').set(H).send({ ids: ['x'], source: 'activity' })).body).toMatchObject({ entries: 0 });
    expect((await agent.post('/api/admin/stored-activity/delete').set(H).send({ all: true, source: 'activity' })).status).toBe(200);
  });
});
