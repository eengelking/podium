// Admin > Reporting > Sessions (#725): the answers sent from Podium and how long the sessions had waited for them, for every harness, through the Admin API.
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAdminRouter } from '../admin/adminRouter.js';
import { toCsv, type ReportReply } from './reports.js';
import { addDays, costFn, writeRollups } from './rollups.js';
import { timeBucket } from './protocol.js';
import { DAY_MS, NOW, TODAY, world, type World } from '../storage/sqlite/rollupFixtures.js';

const SECRET = 'the-admin-secret-0123456789';
const H = { 'X-Podium-Admin': '1' };
const D2 = addDays(TODAY, -2);
const D9 = addDays(TODAY, -9);

async function api(w: World, run = true) {
  if (run) await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), { sessionsMs: 30 * DAY_MS });
  const app = express();
  app.use('/api/admin', createAdminRouter({ secret: SECRET, storage: w.storage, people: w.people, reports: w.deps, now: () => NOW }));
  const agentReq = request.agent(app);
  await agentReq.post('/api/admin/unlock').set(H).send({ name: 'Admin', token: SECRET });
  return { get: (path: string) => agentReq.get(`/api/admin/reports/${path}`).set(H) };
}

/** Counting began nine days ago. Two days ago: Claude Code answered five permissions in about 10 s, four in about a minute and one in five minutes, a question in 90 s and a message; OpenCode one question and one plan. Today one permission. */
async function filled(): Promise<World> {
  const w = world();
  await w.fdb.markAnswerDay(D9);
  const put = async (day: string, harness: string, kind: 'permission' | 'question' | 'plan' | 'message', ms: number | null, times = 1) => {
    for (let i = 0; i < times; i++) await w.fdb.addAnswer(day, harness, kind, ms === null ? -1 : timeBucket(ms));
  };
  await put(D2, 'claude-code', 'permission', 10_000, 5);
  await put(D2, 'claude-code', 'permission', 60_000, 4);
  await put(D2, 'claude-code', 'permission', 300_000);
  await put(D2, 'claude-code', 'question', 90_000);
  await put(D2, 'claude-code', 'message', null);
  await put(D2, 'opencode', 'question', 30_000);
  await put(D2, 'opencode', 'plan', 120_000);
  await put(TODAY, 'claude-code', 'permission', 20_000);
  return w;
}

const near = (v: unknown, want: number): void => {
  expect(typeof v).toBe('number');
  expect(Math.abs((v as number) - want)).toBeLessThanOrEqual(Math.max(1, want * 0.1));
};

describe('sessiontime: answers sent through Podium', () => {
  it('counts each kind per period and harness, today included, and says since when it counts', async () => {
    const { get } = await api(await filled());
    const r = (await get(`sessiontime?breakdown=answers&from=${D9}&to=${TODAY}&by=day`)).body as ReportReply;
    expect(r.columns.map((c) => c.key)).toEqual(['period', 'harness', 'permission', 'question', 'plan', 'message', 'all']);
    expect(r.rows.map((x) => Object.values(x).join('|'))).toEqual([`${D2}|claude-code|10|1|0|1|12`, `${D2}|opencode|0|1|1|0|2`, `${TODAY}|claude-code|1|0|0|0|1`]);
    expect(r.total).toEqual({ permission: 11, question: 2, plan: 1, message: 1, all: 15 });
    expect((r.byHarness as Record<string, unknown>[]).map((x) => `${x.harness}=${x.all}`)).toEqual(['claude-code=13', 'opencode=2']);
    expect(r.answersSince).toBe(D9);
    expect(r.harnesses).toEqual(['claude-code', 'opencode']);
    expect(r.partial).toBe(false);
    // a period with no answer is a zero once counting had begun
    const days = r.periods as Record<string, unknown>[];
    expect(days.find((x) => x.period === addDays(TODAY, -5))).toMatchObject({ all: 0 });
  });

  it('shows a dash, not a zero, for the periods before counting began, and flags the report as partial', async () => {
    const { get } = await api(await filled());
    const r = (await get(`sessiontime?breakdown=answers&from=${addDays(D9, -3)}&to=${TODAY}&by=day`)).body as ReportReply;
    expect(r.partial).toBe(true);
    const periods = r.periods as Record<string, unknown>[];
    expect(periods.find((x) => x.period === addDays(D9, -1))).toMatchObject({ permission: null, all: null });
    expect(periods.find((x) => x.period === D9)).toMatchObject({ all: 0 });
    // the totals count only what was counted
    expect((r.total as Record<string, number>).all).toBe(15);
  });

  it('adds days into weeks and months', async () => {
    const { get } = await api(await filled());
    const r = (await get(`sessiontime?breakdown=answers&from=${D9}&to=${TODAY}&by=month`)).body as ReportReply;
    expect((r.periods as Record<string, number>[]).reduce((n, x) => n + (x.all ?? 0), 0)).toBe(15);
  });

  it('narrows to one harness', async () => {
    const { get } = await api(await filled());
    const r = (await get(`sessiontime?breakdown=answers&from=${D9}&to=${TODAY}&by=day&harness=opencode`)).body as ReportReply;
    expect(r.rows.map((x) => Object.values(x).join('|'))).toEqual([`${D2}|opencode|0|1|1|0|2`]);
    expect(r.total).toMatchObject({ all: 2 });
    expect((r.byHarness as Record<string, unknown>[]).map((x) => x.harness)).toEqual(['opencode']);
  });

  it('says counting began today when nothing has been counted, with no row of its own', async () => {
    const { get } = await api(world(), false);
    const r = (await get(`sessiontime?breakdown=answers&from=${D2}&to=${TODAY}&by=day`)).body as ReportReply;
    expect(r.rows).toEqual([]);
    expect(r.answersSince).toBe(TODAY);
    expect(r.total).toMatchObject({ all: 0 });
  });

  it('leaves a marker for each day the retention ran, so a quiet day is a zero', async () => {
    const w = world();
    await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), { sessionsMs: 30 * DAY_MS });
    const stored = await w.fdb.rollupRows('answers_daily', TODAY, TODAY);
    expect(stored).toEqual([{ day: TODAY, harness: '', kind: 'none', bucket: -1, count: 0 }]);
    const { get } = await api(w, false);
    const r = (await get(`sessiontime?breakdown=answers&from=${D2}&to=${TODAY}&by=day`)).body as ReportReply;
    expect(r.answersSince).toBe(TODAY);
    expect(r.rows).toEqual([]);
  });

  it('refuses a person, group or model filter, which answers are not kept by', async () => {
    const { get } = await api(await filled());
    for (const f of ['person=Maya', 'group=Platform', 'model=opus']) {
      for (const b of ['answers', 'answerwait']) {
        const res = await get(`sessiontime?breakdown=${b}&from=${D9}&to=${TODAY}&${f}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/cannot be filtered by person, group or model/);
      }
    }
  });

  it('exports the same rows as CSV with a harness column, and holds no text', async () => {
    const { get } = await api(await filled());
    const q = `sessiontime?breakdown=answers&from=${D9}&to=${TODAY}&by=day`;
    const r = (await get(q)).body as ReportReply;
    const csv = (await get(`${q}&format=csv`)).text;
    expect(csv.split('\r\n')[0]).toBe('Period,Harness,Permission,Question,Plan,Message,All');
    expect(csv).toBe(toCsv(r.columns, r.rows));
    expect(csv).toContain(`${D2},claude-code,10,1,0,1,12`);
  });
});

describe('sessiontime: how long sessions waited for an answer', () => {
  it('reads a median and a 90th percentile from the wait classes, within 10%', async () => {
    const { get } = await api(await filled());
    const r = (await get(`sessiontime?breakdown=answerwait&from=${D9}&to=${TODAY}&by=day`)).body as ReportReply;
    expect(r.columns.map((c) => c.key)).toEqual(['period', 'harness', 'answers', 'medianS', 'p90S']);
    const whole = r.total as Record<string, unknown>;
    // 14 answers to an ask: ten of them in about 10 to 60 s, the rest up to 300 s. A message is not among them.
    expect(whole.answers).toBe(14);
    near(whole.medianS, 30);
    near(whole.p90S, 120);
  });

  it('gives each kind, with a message that has no wait, and each harness', async () => {
    const { get } = await api(await filled());
    const r = (await get(`sessiontime?breakdown=answerwait&from=${D9}&to=${TODAY}&by=day`)).body as ReportReply;
    const kinds = r.kinds as Record<string, unknown>[];
    expect(kinds.map((k) => `${k.kind}=${k.answers}`)).toEqual(['permission=11', 'question=2', 'plan=1', 'message=1']);
    expect(kinds[3]).toMatchObject({ medianS: null, p90S: null });
    near(kinds[2]!.medianS, 120);
    const by = r.byHarness as Record<string, unknown>[];
    expect(by.map((h) => `${h.harness}=${h.answers}`)).toEqual(['claude-code=12', 'opencode=2']);
  });

  it('gives each period, with a dash before counting began', async () => {
    const { get } = await api(await filled());
    const r = (await get(`sessiontime?breakdown=answerwait&from=${addDays(D9, -2)}&to=${TODAY}&by=day`)).body as ReportReply;
    const p = r.periods as Record<string, unknown>[];
    expect(p.find((x) => x.period === addDays(D9, -2))).toMatchObject({ answers: null, medianS: null, p90S: null });
    expect(p.find((x) => x.period === addDays(TODAY, -4))).toMatchObject({ answers: 0, medianS: null });
    expect(p.find((x) => x.period === TODAY)).toMatchObject({ answers: 1 });
    expect(r.partial).toBe(true);
  });

  it('narrows to one harness, and exports the same rows as CSV', async () => {
    const { get } = await api(await filled());
    const q = `sessiontime?breakdown=answerwait&from=${D9}&to=${TODAY}&by=day&harness=opencode`;
    const r = (await get(q)).body as ReportReply;
    expect((r.total as Record<string, unknown>).answers).toBe(2);
    expect(r.rows.map((x) => `${x.harness}=${x.answers}`)).toEqual(['opencode=2']);
    expect((await get(`${q}&format=csv`)).text).toBe(toCsv(r.columns, r.rows));
  });

  it('has no median when nobody answered an ask', async () => {
    const w = world();
    await w.fdb.addAnswer(D2, 'claude-code', 'message', -1);
    const { get } = await api(w);
    const r = (await get(`sessiontime?breakdown=answerwait&from=${D9}&to=${TODAY}&by=day`)).body as ReportReply;
    expect(r.total).toEqual({ answers: 0, medianS: null, p90S: null });
  });
});
