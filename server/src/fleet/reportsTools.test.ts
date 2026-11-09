// Admin > Reporting > Tools (#720): calls per tool, calls per session and harness versions, for every harness, through the Admin API.
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAdminRouter } from '../admin/adminRouter.js';
import { toCsv, type ReportReply } from './reports.js';
import { addDays, costFn, writeRollups } from './rollups.js';
import { DAY_MS, NOW, TODAY, agent, at, session, world, type World } from '../storage/sqlite/rollupFixtures.js';

const SECRET = 'the-admin-secret-0123456789';
const H = { 'X-Podium-Admin': '1' };

async function api(w: World) {
  await writeRollups(w.storage, NOW, costFn(w.deps.pricing()), { sessionsMs: 30 * DAY_MS });
  const app = express();
  app.use('/api/admin', createAdminRouter({ secret: SECRET, storage: w.storage, people: w.people, reports: w.deps, now: () => NOW }));
  const agentReq = request.agent(app);
  await agentReq.post('/api/admin/unlock').set(H).send({ name: 'Admin', token: SECRET });
  return { get: (path: string) => agentReq.get(`/api/admin/reports/${path}`).set(H) };
}

/** Sessions from both harnesses on the last two days (one of them today, which the report reads live) and a few days back. */
async function filled(): Promise<World> {
  const w = world();
  const add = async (id: string, daysAgo: number, harness: string, version: string | null, counts: Record<string, number> | null, reporter: string) => {
    await w.fdb.upsertSession(session({ id, owner: 'Priya', harness, engine_version: version, started_at: at(daysAgo, 9), last_seen_at: at(daysAgo, 11), ended_at: at(daysAgo, 11) }));
    if (counts) await w.fdb.upsertAgent(agent(id, `${id}-a`, { tool_counts_json: JSON.stringify(counts) }));
    w.storage.sqliteHandle.prepare("INSERT OR IGNORE INTO reporters (key, kind, machine_id, owner, reporter_version, engine_version, first_seen_at, last_seen_at) VALUES (?, 'mod', ?, 'Priya', '1.2.2', ?, 1, 2)").run(reporter, reporter, version);
    w.storage.sqliteHandle.prepare('INSERT INTO reporter_sessions (reporter_key, session_id) VALUES (?, ?)').run(reporter, id);
  };
  await add('c1', 3, 'claude-code', '2.1.305', { Bash: 10, Read: 2, mcp__github__search_code: 6, mcp__github__get_file: 2, mcp__playwright__click: 1 }, 'r1');
  await add('c2', 3, 'claude-code', '2.1.319', { Bash: 30 }, 'r2');
  await add('o1', 3, 'opencode', '1.4.2', { Bash: 4, Edit: 1 }, 'r3');
  await add('c3', 0, 'claude-code', '2.1.319', { Bash: 5, Edit: 5 }, 'r2');
  await add('c4', 0, 'claude-code', '2.1.319', null, 'r4');
  return w;
}

const rowsOf = (r: ReportReply): string[] => r.rows.map((x) => Object.values(x).join('|'));

describe('tools: calls by tool', () => {
  it('has a row for each period, harness and tool, with an MCP server named apart from its tool', async () => {
    const { get } = await api(await filled());
    const r = (await get(`tools?from=${addDays(TODAY, -5)}&to=${TODAY}&by=day`)).body as ReportReply;
    expect(r.report).toBe('tools');
    expect(r.columns.map((c) => c.key)).toEqual(['period', 'harness', 'server', 'tool', 'calls']);
    const d3 = addDays(TODAY, -3);
    expect(rowsOf(r)).toEqual([
      `${d3}|claude-code||Bash|40`, `${d3}|claude-code||Read|2`, `${d3}|claude-code|github|get_file|2`, `${d3}|claude-code|github|search_code|6`, `${d3}|claude-code|playwright|click|1`,
      `${d3}|opencode||Bash|4`, `${d3}|opencode||Edit|1`, `${TODAY}|claude-code||Bash|5`, `${TODAY}|claude-code||Edit|5`,
    ]);
    expect(r.total).toEqual({ calls: 66 });
    expect(r.harnesses).toEqual(['claude-code', 'opencode']);
    expect(r.basedOn).toBe('rollups and live');
  });

  it('narrows to one harness and groups by week', async () => {
    const { get } = await api(await filled());
    const r = (await get(`tools?from=${addDays(TODAY, -5)}&to=${TODAY}&by=week&harness=opencode`)).body as ReportReply;
    expect(rowsOf(r).every((x) => x.includes('|opencode|'))).toBe(true);
    expect(r.total).toEqual({ calls: 5 });
    expect(r.harnesses).toEqual(['claude-code', 'opencode']);
  });

  it('is the same data as its CSV', async () => {
    const { get } = await api(await filled());
    const q = `tools?from=${addDays(TODAY, -5)}&to=${TODAY}`;
    const json = (await get(q)).body as ReportReply;
    const csv = (await get(`${q}&format=csv`)).text;
    expect(csv).toBe(toCsv(json.columns, json.rows));
    expect(csv.startsWith('Period,Harness,MCP server,Tool,Calls\r\n')).toBe(true);
  });
});

describe('tools: calls per session', () => {
  it('reads a median and a 90th percentile per period and harness, and for the whole period', async () => {
    const { get } = await api(await filled());
    const r = (await get(`tools?breakdown=session&from=${addDays(TODAY, -5)}&to=${TODAY}&by=day`)).body as ReportReply;
    expect(r.columns.map((c) => c.key)).toEqual(['period', 'harness', 'sessions', 'median', 'p90']);
    const d3 = addDays(TODAY, -3);
    // day -3: Claude Code sessions of 21 and 30 calls, OpenCode one of 5; today: Claude Code sessions of 10 and 0 calls
    expect(rowsOf(r)).toEqual([`${d3}|claude-code|2|21|30`, `${d3}|opencode|1|5|5`, `${TODAY}|claude-code|2|0|10`]);
    expect(r.total).toEqual({ sessions: 5, median: 10, p90: 30 });
    expect(r.byHarness).toEqual([{ harness: 'claude-code', sessions: 4, median: 10, p90: 30 }, { harness: 'opencode', sessions: 1, median: 5, p90: 5 }]);
  });
});

describe('tools: harness versions', () => {
  it('counts reporters per version, marks the newest of each harness only against itself, and says how many run an older one', async () => {
    const { get } = await api(await filled());
    const r = (await get(`tools?breakdown=version&from=${addDays(TODAY, -5)}&to=${TODAY}&by=day`)).body as ReportReply;
    expect(r.columns.map((c) => c.key)).toEqual(['period', 'harness', 'version', 'reporters', 'newest']);
    const d3 = addDays(TODAY, -3);
    expect(rowsOf(r)).toEqual([`${d3}|claude-code|2.1.305|1|Older`, `${d3}|claude-code|2.1.319|1|Newest seen`, `${d3}|opencode|1.4.2|1|Newest seen`, `${TODAY}|claude-code|2.1.319|2|Newest seen`]);
    // the last period: both Claude Code reporters run the newest version, and so does the one OpenCode reporter of an earlier day (its last period is day -3)
    expect(r.behind).toEqual([{ harness: 'claude-code', newest: '2.1.319', behind: 0, reporters: 2 }, { harness: 'opencode', newest: '1.4.2', behind: 0, reporters: 1 }]);
  });

  it('compares versions as numbers, not as text', async () => {
    const w = world();
    await w.fdb.upsertSession(session({ id: 'a', harness: 'claude-code', engine_version: '2.1.9', last_seen_at: at(1, 11) }));
    await w.fdb.upsertSession(session({ id: 'b', harness: 'claude-code', engine_version: '2.1.10', last_seen_at: at(1, 11) }));
    for (const [k, id] of [['ra', 'a'], ['rb', 'b']] as const) {
      w.storage.sqliteHandle.prepare("INSERT INTO reporters (key, kind, machine_id, owner, reporter_version, first_seen_at, last_seen_at) VALUES (?, 'mod', ?, 'Priya', '1', 1, 2)").run(k, k);
      w.storage.sqliteHandle.prepare('INSERT INTO reporter_sessions (reporter_key, session_id) VALUES (?, ?)').run(k, id);
    }
    const { get } = await api(w);
    const r = (await get(`tools?breakdown=version&from=${addDays(TODAY, -3)}&to=${TODAY}`)).body as ReportReply;
    expect(r.behind).toEqual([{ harness: 'claude-code', newest: '2.1.10', behind: 1, reporters: 2 }]);
  });
});

describe('tools: the period and the request', () => {
  it('says so when the period starts before the data does, and never fills the gap with zeros', async () => {
    const { get } = await api(await filled());
    const r = (await get(`tools?from=${addDays(TODAY, -60)}&to=${TODAY}&by=week`)).body as ReportReply;
    expect(r.partial).toBe(true);
    expect(r.oldestDay > r.from).toBe(true);
    expect(r.rows.every((x) => String(x.period) >= addDays(TODAY, -9) && Number(x.calls) > 0)).toBe(true);
  });

  it('answers 400 to a breakdown or a harness it does not know', async () => {
    const { get } = await api(await filled());
    for (const q of ['tools?breakdown=cost', 'tools?harness=has%20space', `tools?harness=${'x'.repeat(41)}`, 'tools?harness=a&harness=b']) expect([q, (await get(q)).status]).toEqual([q, 400]);
  });

  it('is empty, not an error, with no sessions', async () => {
    const { get } = await api(world());
    const r = (await get('tools')).body as ReportReply;
    expect(r.rows).toEqual([]);
    expect(r.total).toEqual({ calls: 0 });
    expect(r.harnesses).toEqual([]);
  });
});
