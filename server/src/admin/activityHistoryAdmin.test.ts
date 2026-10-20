// The Admin routes for the Activity history (#432): the setting, the preview, the Stored activity list and its delete.
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openDb } from '../fleet/db.js';
import { PeopleStore } from '../fleet/people.js';
import { openActivityDb } from '../fleet/activityDb.js';
import { ActivityHistory } from '../fleet/activityHistory.js';
import { ActivityHistorySettingsStore } from '../fleet/activityHistorySettings.js';
import { ACTIVITY_LOG_KINDS } from '../fleet/activityHistoryTypes.js';
import { fixtureReport } from '../fleet/testing.js';
import type { Report } from '../fleet/protocol.js';
import { createAdminRouter } from './adminRouter.js';

const SECRET = 'the-admin-secret-0123456789';
const H = { 'X-Podium-Admin': '1' };
const T0 = 1_800_000_000_000;
const SECRET_TEXT = 'UNIQUE-ENTRY-TEXT-5521';

function setup(over: { withHistory?: boolean; onChanged?: () => void } = {}) {
  const db = openDb(':memory:');
  const people = new PeopleStore(db);
  const settings = new ActivityHistorySettingsStore(db, true);
  const history = new ActivityHistory(openActivityDb(':memory:'), { now: () => T0, settings: () => settings.get(), isLive: () => false, authOn: true });
  const app = express();
  app.use('/api/admin', createAdminRouter({ secret: SECRET, onActivityHistoryChanged: over.onChanged, people, now: () => T0, log: () => {}, ...(over.withHistory === false ? {} : { activityHistory: { history, settings } }) }));
  return { app, people, settings, history };
}

async function unlocked(over: Parameters<typeof setup>[0] = {}) {
  const s = setup(over);
  const agent = request.agent(s.app);
  expect((await agent.post('/api/admin/unlock').set(H).send({ name: 'Admin', token: SECRET })).status).toBe(200);
  return { ...s, agent };
}

function store(history: ActivityHistory, settings: ActivityHistorySettingsStore, id: string, owner = 'Ed', n = 2) {
  settings.set({ policy: 'all' });
  const r: Report = fixtureReport();
  r.session = { ...r.session, id, activity: Array.from({ length: n }, (_, i) => ({ at: T0 - 7_200_000 + i, kind: 'tool' as const, text: `${SECRET_TEXT} ${i}` })) };
  r.agents = [];
  history.ingest(r, 0, { name: `name-${id}`, project: 'acme/billing', owner });
}

const logRows = (people: PeopleStore) => people.listLog({ page: 1, pageSize: 100 }).rows;

describe('GET and PUT /settings carry the Activity history', () => {
  it('reads the state: settings, totals, last purge and whether a token is set', async () => {
    const { agent } = await unlocked();
    const res = await agent.get('/api/admin/settings').set(H);
    expect(res.body.activityHistory).toEqual({
      settings: { policy: 'default', n: 30, unit: 'days', capGb: null },
      totals: { entries: 0, bytes: 0, sessions: 0, fileBytes: expect.any(Number) },
      lastPurge: null,
      authOn: true,
    });
  });

  it('leaves the key out when the store is not wired', async () => {
    const { agent } = await unlocked({ withHistory: false });
    expect((await agent.get('/api/admin/settings').set(H)).body).not.toHaveProperty('activityHistory');
    expect((await agent.put('/api/admin/settings').set(H).send({ activityHistory: { policy: 'all' } })).status).toBe(400);
  });

  it.each([
    [{ policy: 'after', n: 30, unit: 'days', capGb: null }, 'Activity history set to purge after 30 days, no size cap'],
    [{ policy: 'end', n: 30, unit: 'days', capGb: 5 }, 'Activity history set to purge when the session ends, size cap 5 GB'],
    [{ policy: 'all', n: 30, unit: 'days', capGb: null }, 'Activity history set to keep everything, no automatic purge, no size cap'],
    [{ policy: 'default', n: 30, unit: 'days', capGb: null }, 'Activity history set to not kept (the default), no size cap'],
  ])('saves %j and writes one admin log row', async (body, detail) => {
    const { agent, people, settings } = await unlocked();
    const res = await agent.put('/api/admin/settings').set(H).send({ activityHistory: body });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.activityHistory.settings).toEqual(body);
    expect(settings.get()).toEqual(body);
    const rows = logRows(people).filter((r) => r.kind === ACTIVITY_LOG_KINDS.changed);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toBe(detail);
  });

  it.each([
    ['a bad policy', { policy: 'forever' }],
    ['a bad period', { policy: 'after', n: 0 }],
    ['a bad cap', { capGb: 5000 }],
    ['an unknown key', { policy: 'all', extra: 1 }],
    ['nothing', {}],
    ['not an object', 'all'],
    ['a list', ['all']],
  ])('refuses %s with 400 and no log row', async (_name, body) => {
    const { agent, people } = await unlocked();
    const res = await agent.put('/api/admin/settings').set(H).send({ activityHistory: body });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
    expect(logRows(people).filter((r) => r.kind === ACTIVITY_LOG_KINDS.changed)).toHaveLength(0);
  });
});

describe('telling open consoles', () => {
  it('runs the callback after a successful save and not after a refused one or a flag list read', async () => {
    const onChanged = vi.fn();
    const { agent } = await unlocked({ onChanged });
    expect((await agent.put('/api/admin/settings').set(H).send({ activityHistory: { policy: 'forever' } })).status).toBe(400);
    await agent.get('/api/admin/settings').set(H);
    expect(onChanged).not.toHaveBeenCalled();
    expect((await agent.put('/api/admin/settings').set(H).send({ activityHistory: { policy: 'all' } })).status).toBe(200);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('does not list activity-history among the Admin flags', async () => {
    const { agent } = await unlocked();
    const ids = ((await agent.get('/api/admin/settings').set(H)).body.features as { id: string }[]).map((f) => f.id);
    expect(ids).not.toContain('activity-history');
  });
});

describe('POST /activity-history/preview', () => {
  it('says what saving would remove, without saving', async () => {
    const { agent, history, settings } = await unlocked();
    store(history, settings, 's1');
    const res = await agent.post('/api/admin/activity-history/preview').set(H).send({ settings: { policy: 'after', n: 1, unit: 'hours', capGb: null } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: 2, bytes: expect.any(Number), sessions: 1, stopsCapturing: false });
    expect(settings.get().policy).toBe('all');
    expect(history.totals().entries).toBe(2);
  });

  it('for the default policy reports what is stored and that capture would stop', async () => {
    const { agent, history, settings } = await unlocked();
    store(history, settings, 's1');
    const res = await agent.post('/api/admin/activity-history/preview').set(H).send({ settings: { policy: 'default', n: 30, unit: 'days', capGb: null } });
    expect(res.body).toMatchObject({ entries: 2, sessions: 1, stopsCapturing: true });
  });

  it.each([
    ['no settings', {}],
    ['a missing field', { settings: { policy: 'all' } }],
    ['an unknown field', { settings: { policy: 'all', n: 1, unit: 'days', capGb: null, x: 1 } }],
    ['a bad unit', { settings: { policy: 'all', n: 1, unit: 'years', capGb: null } }],
  ])('refuses %s with 400', async (_name, body) => {
    const { agent } = await unlocked();
    const res = await agent.post('/api/admin/activity-history/preview').set(H).send(body);
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('answers 404 when the store is not wired', async () => {
    const { agent } = await unlocked({ withHistory: false });
    expect((await agent.post('/api/admin/activity-history/preview').set(H).send({ settings: {} })).status).toBe(404);
  });
});

describe('GET /stored-activity', () => {
  it('lists the stored sessions with the totals and the filter choices', async () => {
    const { agent, history, settings } = await unlocked();
    store(history, settings, 's1', 'Ed');
    store(history, settings, 's2', 'Alex', 3);
    const res = await agent.get('/api/admin/stored-activity?page=1&pageSize=25').set(H);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, page: 1, pageSize: 25, totals: { entries: 5, sessions: 2 }, match: { entries: 5, sessions: 2 }, projects: ['acme/billing'], owners: ['Alex', 'Ed'] });
    expect(res.body.rows.map((r: { sessionId: string }) => r.sessionId).sort()).toEqual(['s1', 's2']);
  });

  it('applies the filter and the paging', async () => {
    const { agent, history, settings } = await unlocked();
    store(history, settings, 's1', 'Ed');
    store(history, settings, 's2', 'Alex', 3);
    const byOwner = await agent.get('/api/admin/stored-activity?owner=Alex&loop=main&q=name-s2&project=acme%2Fbilling&olderThanDays=0&from=1&to=99999999999999').set(H);
    expect(byOwner.status).toBe(200);
    expect(byOwner.body.rows.map((r: { sessionId: string }) => r.sessionId)).toEqual(['s2']);
    const paged = await agent.get('/api/admin/stored-activity?page=2&pageSize=1').set(H);
    expect(paged.body).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(paged.body.rows).toHaveLength(1);
  });

  it.each([
    'page=0',
    'page=abc',
    'pageSize=500',
    'pageSize=1.5',
    'loop=sideways',
    'olderThanDays=-1',
    'olderThanDays=soon',
    'from=yesterday',
    'to=NaN',
    'q=a&q=b',
    `q=${'x'.repeat(201)}`,
  ])('answers 400 for %s, never 500', async (qs) => {
    const { agent } = await unlocked();
    const res = await agent.get(`/api/admin/stored-activity?${qs}`).set(H);
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('answers 404 when the store is not wired', async () => {
    const { agent } = await unlocked({ withHistory: false });
    expect((await agent.get('/api/admin/stored-activity').set(H)).status).toBe(404);
  });
});

describe('POST /stored-activity/delete', () => {
  it('deletes ticked sessions and writes one log row with counts and no entry text', async () => {
    const { agent, history, settings, people } = await unlocked();
    store(history, settings, 's1');
    store(history, settings, 's2', 'Alex', 3);
    const res = await agent.post('/api/admin/stored-activity/delete').set(H).send({ ids: ['s2'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ entries: 3, sessions: 1, bytes: expect.any(Number), freed: expect.any(Number) });
    expect(history.totals().entries).toBe(2);
    const rows = logRows(people).filter((r) => r.kind === ACTIVITY_LOG_KINDS.deleted);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toMatch(/^Deleted 3 entries \(\d+(\.\d)? (B|KB)\) from 1 session, chosen by ticked sessions$/);
    expect(JSON.stringify(logRows(people))).not.toContain(SECRET_TEXT);
  });

  it('deletes by a filter, and says so', async () => {
    const { agent, history, settings, people } = await unlocked();
    store(history, settings, 's1', 'Ed');
    store(history, settings, 's2', 'Alex');
    const res = await agent.post('/api/admin/stored-activity/delete').set(H).send({ match: { owner: 'Ed' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ entries: 2, sessions: 1 });
    expect(logRows(people).find((r) => r.kind === ACTIVITY_LOG_KINDS.deleted)!.detail).toContain('chosen by a filter');
    const withSource = await agent.post('/api/admin/stored-activity/delete').set(H).send({ match: { source: 'activity', owner: 'Alex' } });
    expect(withSource.body).toMatchObject({ entries: 2, sessions: 1 });
  });

  it('deletes everything, and says so; one entry reads in the singular', async () => {
    const { agent, history, settings, people } = await unlocked();
    store(history, settings, 's1', 'Ed', 1);
    const res = await agent.post('/api/admin/stored-activity/delete').set(H).send({ all: true });
    expect(res.body).toMatchObject({ entries: 1, sessions: 1 });
    expect(history.totals().entries).toBe(0);
    expect(logRows(people).find((r) => r.kind === ACTIVITY_LOG_KINDS.deleted)!.detail).toMatch(/^Deleted 1 entry .* from 1 session, chosen by everything$/);
  });

  it('formats a large delete in megabytes', async () => {
    const { agent, history, settings, people } = await unlocked();
    store(history, settings, 's1', 'Ed', 30);
    await agent.post('/api/admin/stored-activity/delete').set(H).send({ all: true });
    expect(logRows(people).find((r) => r.kind === ACTIVITY_LOG_KINDS.deleted)!.detail).toMatch(/\(\d+\.\d KB\)/);
  });

  it('refuses an empty filter, and a filter that only says all', async () => {
    const { agent, history, settings } = await unlocked();
    store(history, settings, 's1');
    for (const match of [{}, { loop: 'all' }, { q: '  ' }]) {
      const res = await agent.post('/api/admin/stored-activity/delete').set(H).send({ match });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Pick a filter, or delete everything.');
    }
    expect(history.totals().entries).toBe(2);
  });

  it.each([
    ['no body', undefined],
    ['an empty body', {}],
    ['two choices', { ids: ['a'], all: true }],
    ['all that is not true', { all: false }],
    ['an empty id list', { ids: [] }],
    ['a non-string id', { ids: [1] }],
    ['an empty id', { ids: [''] }],
    ['a very long id', { ids: ['x'.repeat(201)] }],
    ['ids that is not a list', { ids: 'a' }],
    ['match that is not an object', { match: 'a' }],
    ['a bad filter value', { match: { loop: 'x' } }],
    ['an unknown filter field', { match: { colour: 'red' } }],
    ['a bad source', { match: { source: 'recordings', owner: 'Ed' } }],
    ['an unknown key', { nope: 1 }],
  ])('refuses %s with 400', async (_name, body) => {
    const { agent } = await unlocked();
    const res = await agent.post('/api/admin/stored-activity/delete').set(H).send(body as object | undefined);
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('refuses more than 200 ids, and takes 200 of the longest length (over the 8 KB default limit)', async () => {
    const { agent, history, settings } = await unlocked();
    store(history, settings, 's1');
    const many = Array.from({ length: 201 }, (_, i) => `s${i}`);
    expect((await agent.post('/api/admin/stored-activity/delete').set(H).send({ ids: many })).status).toBe(400);
    const big = Array.from({ length: 200 }, (_, i) => `${i}`.padEnd(200, 'x'));
    const res = await agent.post('/api/admin/stored-activity/delete').set(H).send({ ids: big });
    expect(res.status).toBe(200);
    expect(res.body.entries).toBe(0);
  });

  it('keeps the default limit for every other route', async () => {
    const { agent } = await unlocked();
    const res = await agent.put('/api/admin/settings').set(H).send({ activityHistory: { policy: 'all', pad: 'x'.repeat(9000) } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad request'); // refused by the 8 KB body limit, before the settings were read
  });

  it('answers 400 for malformed JSON, and 404 when the store is not wired', async () => {
    const { agent } = await unlocked();
    expect((await agent.post('/api/admin/stored-activity/delete').set(H).set('Content-Type', 'application/json').send('{nope')).status).toBe(400);
    const off = await unlocked({ withHistory: false });
    expect((await off.agent.post('/api/admin/stored-activity/delete').set(H).send({ all: true })).status).toBe(404);
  });

  it('refuses a cross-site request', async () => {
    const { agent } = await unlocked();
    expect((await agent.post('/api/admin/stored-activity/delete').send({ all: true })).status).toBe(403);
  });
});

describe('the store fails (the calls are async)', () => {
  it('answers 500 with a plain message for a preview, a list and a delete, and writes no Admin log row for the delete', async () => {
    const { agent, history, people } = await unlocked();
    vi.spyOn(history, 'preview').mockRejectedValue(new Error('disk'));
    vi.spyOn(history, 'list').mockRejectedValue(new Error('disk'));
    vi.spyOn(history, 'deleteBy').mockRejectedValue(new Error('disk'));
    const want = { ok: false, error: 'could not reach the stored activity' };
    const prev = await agent.post('/api/admin/activity-history/preview').set(H).send({ settings: { policy: 'all', n: 30, unit: 'days', capGb: null } });
    expect([prev.status, prev.body]).toEqual([500, want]);
    const list = await agent.get('/api/admin/stored-activity').set(H);
    expect([list.status, list.body]).toEqual([500, want]);
    const del = await agent.post('/api/admin/stored-activity/delete').set(H).send({ all: true });
    expect([del.status, del.body]).toEqual([500, want]);
    expect(logRows(people).filter((r) => r.kind === ACTIVITY_LOG_KINDS.deleted)).toHaveLength(0);
  });
});
