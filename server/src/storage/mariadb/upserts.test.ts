// Every upsert and insert-that-skips on MariaDB (#823). `ON DUPLICATE KEY UPDATE` and `INSERT IGNORE` do not name the key they conflict on, as
// `ON CONFLICT (...)` and SQLite's `INSERT OR IGNORE` do, so on a table with two unique keys they could change or skip the wrong row. The
// first case reads every such statement in the adapter and the keys of its table from the database, and fails unless exactly one unique key
// can conflict. The others run each statement through its store, beside a neighbor that shares part of the key, and check that the row the
// key names is the one that changed and that the neighbor did not.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../contract.js';
import type { AgentRow, SampleRow, SessionWaitRow } from '../rows.js';
import type { Storage } from '../types.js';
import { MariaDbConn, parseTarget } from './conn.js';
import { openMariaDbStorage } from './index.js';
import { TEST_MARIADB, createTestDatabase, truncate, type TestDatabase } from './testing.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Each upsert or insert-that-skips in the adapter's code: the file, the table and the columns it writes (null when built from a row's keys). */
function sites(): { file: string; table: string; cols: string[] | null; kind: 'update' | 'ignore' }[] {
  const out: { file: string; table: string; cols: string[] | null; kind: 'update' | 'ignore' }[] = [];
  for (const file of readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const text = readFileSync(path.join(here, file), 'utf8');
    for (const m of text.matchAll(/INSERT (IGNORE )?INTO "?(\w+)"? \(([^)]*)\)/g)) {
      const rest = text.slice(m.index!, m.index! + 1500);
      const next = rest.slice(10).search(/INSERT (IGNORE )?INTO/);
      const statement = next < 0 ? rest : rest.slice(0, next + 10);
      const kind = m[1] ? 'ignore' : statement.includes('ON DUPLICATE KEY UPDATE') ? 'update' : null;
      if (!kind) continue;
      out.push({ file, table: m[2]!, cols: m[3]!.includes('${') ? null : m[3]!.split(',').map((c) => c.trim().replaceAll('"', '')), kind });
    }
  }
  return out;
}

describe('the upsert and insert-ignore sites', () => {
  it('are the ones this test knows, so a new one is checked here too', () => {
    const found = sites().map((s) => `${s.file}:${s.table}:${s.kind}`).sort();
    expect(found).toEqual([
      'activityHistory.ts:loops:update', 'activityHistory.ts:stored_sessions:update', 'activityHistorySettings.ts:settings:update',
      'chat.ts:chat_read_state:update', 'chat.ts:chat_read_state:update', 'chat.ts:settings:ignore', 'chat.ts:settings:update',
      'featureFlags.ts:settings:update',
      'fleet.ts:agent_texts:update', 'fleet.ts:agent_texts:update', 'fleet.ts:agents:update', 'fleet.ts:agents:update', 'fleet.ts:blowouts:ignore', 'fleet.ts:events:ignore',
      'fleet.ts:samples:ignore', 'fleet.ts:samples:update', 'fleet.ts:session_waits:update', 'fleet.ts:sessions:update',
      'modelPrices.ts:settings:update', 'peerRights.ts:peer_owner_settings:update', 'peerRights.ts:peer_rights:update', 'peerSettings.ts:settings:update',
      'people.ts:person_machines:update', 'people.ts:settings:update', 'recordingSettings.ts:settings:update', 'recordings.ts:rec_sessions:update',
      'reportQueries.ts:answers_daily:ignore', 'reportQueries.ts:answers_daily:update', 'reportQueries.ts:fleet_daily:update', 'reportQueries.ts:hour_peaks_daily:update',
      'reporters.ts:reporter_ignores:ignore', 'reporters.ts:reporter_sessions:ignore', 'reporters.ts:reporter_sessions:update', 'reporters.ts:reporters:update', 'reporters.ts:settings:update',
      'tlsSettings.ts:settings:ignore', 'tlsSettings.ts:settings:update', 'wallSettings.ts:settings:update',
    ].sort());
  });
});

describe.skipIf(!TEST_MARIADB)('the upsert and insert-ignore sites on a database', () => {
  let td: TestDatabase;
  let s: Storage;
  let db: MariaDbConn;

  beforeAll(async () => {
    td = await createTestDatabase();
    s = await openMariaDbStorage(td.url.replace(/^mariadb:\/\//, ''), 0);
    db = new MariaDbConn({ target: parseTarget(td.url), max: 2 });
  });
  afterAll(async () => {
    await db.close();
    await s.close();
    await td.drop();
  });
  beforeEach(async () => {
    await truncate(db, 'sessions', 'session_waits', 'agents', 'agent_texts', 'events', 'blowouts', 'samples', 'settings', 'person_machines', 'reporters', 'reporter_sessions', 'reporter_ignores', 'answers_daily', 'hour_peaks_daily', 'fleet_daily', 'chat_read_state');
  });

  it('can conflict on exactly one unique key of each table, the one the site means', async () => {
    const keys = await db.all<{ t: string; i: string; c: string }>(
      "SELECT table_name AS t, index_name AS i, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS c FROM information_schema.statistics WHERE table_schema = DATABASE() AND non_unique = 0 GROUP BY table_name, index_name",
    );
    const auto = new Set((await db.all<{ k: string }>("SELECT CONCAT(table_name, '.', column_name) AS k FROM information_schema.columns WHERE table_schema = DATABASE() AND extra LIKE '%auto_increment%'")).map((r) => r.k));
    const columns = async (t: string) => (await db.all<{ c: string }>('SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?', [t])).map((r) => r.c);
    for (const site of sites()) {
      const written = site.cols ?? (await columns(site.table));
      // A key on a generated id the statement does not write can never conflict.
      const live = keys.filter((k) => k.t === site.table && !(k.c.split(',').length === 1 && auto.has(`${k.t}.${k.c}`) && !written.includes(k.c)));
      expect(live.length, `${site.file}: ${site.table} has ${live.map((k) => k.i).join(', ')}`).toBe(1);
      expect(live[0]!.c.split(',').every((c) => written.includes(c)), `${site.file}: ${site.table} writes every column of ${live[0]!.i}`).toBe(true);
    }
  });

  it('settings: replaces one key and skips a seed that is there, leaving the others', async () => {
    await s.wallSettings.setShowBackgroundSessions(true);
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?), (?, ?)', ['tls.allowReportersOverHttp', 'false', 'neighbor', 'n']);
    await s.tlsSettings.seedAllowReportersOverHttp(true);
    expect(await s.tlsSettings.allowReportersOverHttp()).toBe(false);
    const before = await db.all('SELECT key, value FROM settings ORDER BY key');
    await s.wallSettings.setShowBackgroundSessions(false);
    const after = await db.all<{ key: string; value: string }>('SELECT key, value FROM settings ORDER BY key');
    expect(after.length).toBe(before.length);
    expect(after.filter((r, i) => JSON.stringify(r) !== JSON.stringify(before[i])).length).toBe(1);
    expect(after.find((r) => r.key === 'neighbor')?.value).toBe('n');
  });

  it('sessions and session_waits: a second write replaces that session only', async () => {
    await s.fleet.upsertSession(session({ id: 'a', name: 'one' }));
    await s.fleet.upsertSession(session({ id: 'ab', name: 'neighbor' }));
    await s.fleet.upsertSession(session({ id: 'a', name: 'two' }));
    expect(await db.all('SELECT id, name FROM sessions ORDER BY id')).toEqual([{ id: 'a', name: 'two' }, { id: 'ab', name: 'neighbor' }]);
    const wait = (id: string, n: number): SessionWaitRow => ({ session_id: id, permission_ms: n, permission_n: n, question_ms: 0, question_n: 0, plan_ms: 0, plan_n: 0, tracked_since: 1, open_kind: null, open_since: null });
    await s.fleet.putSessionWait(wait('a', 1));
    await s.fleet.putSessionWait(wait('ab', 5));
    await s.fleet.putSessionWait(wait('a', 2));
    expect(await db.all('SELECT session_id, permission_n FROM session_waits ORDER BY session_id')).toEqual([{ session_id: 'a', permission_n: 2 }, { session_id: 'ab', permission_n: 5 }]);
  });

  it('agents and agent texts, one at a time and in a batch: the (session, agent) pair, not the agent id alone', async () => {
    await s.fleet.upsertSession(session({ id: 's1' }));
    await s.fleet.upsertSession(session({ id: 's2' }));
    const agent = (sid: string, id: string, name: string): AgentRow => ({ session_id: sid, id, parent_id: null, kind: 'subagent', type: 'Explore', name, description: 'd', model: null, effort: null, effort_source: null, status: 'running', started_at: 1, ended_at: null, context_tokens: null, context_window: null, context_percent: null, tok_in: 0, tok_out: 0, tok_cr: 0, tok_cw: 0, cost_usd_est: null, skills_json: null, last_tool: null, tool_calls: 0, tool_counts_json: null, tool_stats_json: null, usage_json: null, blowouts: 0, steps_done: null, steps_total: null, prompt_excerpt: null, answer_excerpt: null, failure_json: null, model_label: null, model_provider: null }) as AgentRow;
    await s.fleet.upsertAgent(agent('s1', 'x', 'first'));
    await s.fleet.upsertAgent(agent('s2', 'x', 'neighbor'));
    await s.fleet.upsertAgent(agent('s1', 'x', 'second'));
    await s.fleet.upsertAgents([agent('s1', 'y', 'batch'), agent('s1', 'x', 'third')]);
    expect(await db.all('SELECT session_id, id, name FROM agents ORDER BY session_id, id')).toEqual([
      { session_id: 's1', id: 'x', name: 'third' }, { session_id: 's1', id: 'y', name: 'batch' }, { session_id: 's2', id: 'x', name: 'neighbor' },
    ]);
    await s.fleet.upsertAgentTexts('s1', 'x', { prompt: 'p1' });
    await s.fleet.upsertAgentTexts('s2', 'x', { prompt: 'other' });
    await s.fleet.upsertAgentTexts('s1', 'x', { answer: 'a1' });
    await s.fleet.upsertAgentTextsMany('s1', [{ agentId: 'x', prompt: 'p2' }, { agentId: 'y', answer: 'ay' }]);
    expect(await db.all('SELECT session_id, agent_id, prompt_text, answer_text FROM agent_texts ORDER BY session_id, agent_id')).toEqual([
      { session_id: 's1', agent_id: 'x', prompt_text: 'p2', answer_text: 'a1' }, { session_id: 's1', agent_id: 'y', prompt_text: null, answer_text: 'ay' },
      { session_id: 's2', agent_id: 'x', prompt_text: 'other', answer_text: null },
    ]);
  });

  it('events and blowouts: a repeat is skipped and says so, and a row that differs in one part of the key is kept', async () => {
    const ev = (id: string, text: string) => ({ id, session_id: 's1', agent_id: null, t: 1, kind: 'note', text, data_json: null });
    expect(await s.fleet.insertEvent(ev('e1', 'first'))).toBe(true);
    expect(await s.fleet.insertEvent(ev('e1', 'again'))).toBe(false);
    expect(await s.fleet.insertEvent(ev('E1', 'case'))).toBe(true);
    expect(await db.all('SELECT id, text FROM events ORDER BY id')).toEqual([{ id: 'E1', text: 'case' }, { id: 'e1', text: 'first' }]);
    const b = (agent: string | null, t: number, before: number) => ({ session_id: 's1', agent_id: agent, t, kind: 'compact', tokens_before: before, tokens_after: 1 });
    await s.fleet.insertBlowout(b('a', 1, 10));
    await s.fleet.insertBlowout(b('a', 1, 99));
    await s.fleet.insertBlowout(b('a', 2, 20));
    // A missing agent never equals another missing one, so both are kept, as on the other adapters.
    await s.fleet.insertBlowout(b(null, 1, 30));
    await s.fleet.insertBlowout(b(null, 1, 31));
    expect(await db.all('SELECT agent_id, t, tokens_before FROM blowouts ORDER BY id')).toEqual([
      { agent_id: 'a', t: 1, tokens_before: 10 }, { agent_id: 'a', t: 2, tokens_before: 20 }, { agent_id: null, t: 1, tokens_before: 30 }, { agent_id: null, t: 1, tokens_before: 31 },
    ]);
  });

  it('samples: an upsert replaces that second of that session, keeping its usage for "=", and an insert-if-absent skips it', async () => {
    const sample = (sid: string, t: number, total: number, usage: string | null): SampleRow => ({ session_id: sid, t, tokens_total: total, tokens_delta: 0, peak_context: 0, running_agents: 0, cost_usd: null, usage_json: usage });
    await s.fleet.upsertSample(sample('s1', 1, 10, 'u1'));
    await s.fleet.upsertSample(sample('s1', 2, 20, 'u2'));
    await s.fleet.upsertSample(sample('s2', 1, 30, 'u3'));
    await s.fleet.upsertSample(sample('s1', 1, 11, '='));
    await s.fleet.insertSampleIfAbsent(sample('s1', 2, 99, 'nope'));
    await s.fleet.insertSampleIfAbsent(sample('s1', 3, 33, null));
    expect(await db.all('SELECT session_id, t, tokens_total, usage_json FROM samples ORDER BY session_id, t')).toEqual([
      { session_id: 's1', t: 1, tokens_total: 11, usage_json: 'u1' }, { session_id: 's1', t: 2, tokens_total: 20, usage_json: 'u2' },
      { session_id: 's1', t: 3, tokens_total: 33, usage_json: null }, { session_id: 's2', t: 1, tokens_total: 30, usage_json: 'u3' },
    ]);
  });

  it('person machines: the (person, machine) pair', async () => {
    const { person: a } = await s.people.createPerson('Ana', null, 1);
    const { person: b } = await s.people.createPerson('Ben', null, 1);
    await s.people.touch(a.id, '10.0.0.1', 100);
    await s.people.touch(b.id, '10.0.0.1', 100);
    await s.people.touch(a.id, '10.0.0.1', 200);
    expect(await db.all('SELECT person_id, machine, last_seen_at FROM person_machines ORDER BY person_id')).toEqual([
      { person_id: a.id, machine: '10.0.0.1', last_seen_at: 200 }, { person_id: b.id, machine: '10.0.0.1', last_seen_at: 100 },
    ]);
  });

  it('answers, hour peaks and fleet days: the whole day key, and a peak that never goes down', async () => {
    await s.fleet.markAnswerDay('2026-11-01');
    await s.fleet.markAnswerDay('2026-11-01');
    await s.fleet.addAnswer('2026-11-01', 'claude-code', 'question', 0);
    await s.fleet.addAnswer('2026-11-01', 'claude-code', 'question', 0);
    await s.fleet.addAnswer('2026-11-01', 'claude-code', 'question', 1);
    await s.fleet.addAnswer('2026-11-02', 'claude-code', 'question', 0);
    expect(await db.all('SELECT day, kind, bucket, count FROM answers_daily ORDER BY day, kind, bucket')).toEqual([
      { day: '2026-11-01', kind: 'none', bucket: -1, count: 0 }, { day: '2026-11-01', kind: 'question', bucket: 0, count: 2 },
      { day: '2026-11-01', kind: 'question', bucket: 1, count: 1 }, { day: '2026-11-02', kind: 'question', bucket: 0, count: 1 },
    ]);
    await s.fleet.upsertHourPeaks([{ day: 'd', harness: 'h', hour: 1, peak: 5 }, { day: 'd', harness: 'h', hour: 2, peak: 1 }]);
    await s.fleet.upsertHourPeaks([{ day: 'd', harness: 'h', hour: 1, peak: 3 }, { day: 'd', harness: 'h', hour: 2, peak: 4 }]);
    expect(await db.all('SELECT hour, peak FROM hour_peaks_daily ORDER BY hour')).toEqual([{ hour: 1, peak: 5 }, { hour: 2, peak: 4 }]);
    const day = (d: string, people: number) => ({ day: { day: d, activePeople: people, activeReporters: 1, sessionsStarted: 1, peakLive: 0, reporterVersions: {}, engineVersions: {} }, peak: people });
    await s.fleet.upsertFleetDays([day('2026-11-01', 3), day('2026-11-02', 7)]);
    await s.fleet.upsertFleetDays([day('2026-11-01', 2)]);
    expect(await db.all('SELECT day, active_people, peak_live_sessions FROM fleet_daily ORDER BY day')).toEqual([
      { day: '2026-11-01', active_people: 2, peak_live_sessions: 3 }, { day: '2026-11-02', active_people: 7, peak_live_sessions: 7 },
    ]);
  });

  it('reporters, their session links and ignore rules: the reporter key and the (reporter, session) pair', async () => {
    const seen = (machineId: string, sessionId: string, version: string, peers: boolean | null = null) => ({ kind: 'mod' as const, machineId, machineName: machineId, source: '127.0.0.1', owner: 'ed', credential: 'person', version, engineVersion: null, sessionId, peers });
    await s.reporters.record(seen('m1', 's1', '1.0.0', true), 1);
    await s.reporters.record(seen('m2', 's1', '2.0.0'), 1);
    await s.reporters.record(seen('m1', 's1', '1.1.0'), 2);
    await s.reporters.record(seen('m1', 's2', '1.1.0'), 3);
    expect(await db.all('SELECT key, reporter_version, first_seen_at, last_seen_at FROM reporters ORDER BY key')).toEqual([
      { key: 'm1', reporter_version: '1.1.0', first_seen_at: 1, last_seen_at: 3 }, { key: 'm2', reporter_version: '2.0.0', first_seen_at: 1, last_seen_at: 1 },
    ]);
    // A report that leaves peers out keeps what the link had.
    expect(await db.all('SELECT reporter_key, session_id, peers FROM reporter_sessions ORDER BY reporter_key, session_id')).toEqual([
      { reporter_key: 'm1', session_id: 's1', peers: 1 }, { reporter_key: 'm1', session_id: 's2', peers: null }, { reporter_key: 'm2', session_id: 's1', peers: null },
    ]);
    // A reporter with no machine id that turns up at a new address with a known session is merged: its links move once, and a link
    // the other row already has is skipped.
    const addr = (source: string, sessionId: string) => ({ kind: 'mod' as const, machineId: null, machineName: null, source, owner: 'ed', credential: 'person', version: '1.0.0', engineVersion: null, sessionId });
    await s.reporters.record(addr('10.0.0.1', 'x1'), 10);
    await s.reporters.record(addr('10.0.0.2', 'x2'), 11);
    await db.run("INSERT INTO reporter_sessions (reporter_key, session_id) VALUES ('addr:10.0.0.2', 'x1')");
    await s.reporters.record(addr('10.0.0.2', 'x1'), 12);
    expect(await db.all("SELECT reporter_key, session_id FROM reporter_sessions WHERE reporter_key LIKE 'addr:%' ORDER BY reporter_key, session_id")).toEqual([
      { reporter_key: 'addr:10.0.0.1', session_id: 'x1' }, { reporter_key: 'addr:10.0.0.1', session_id: 'x2' },
    ]);
    const first = await s.reporters.addIgnore('version', '9.9.9', 1);
    const again = await s.reporters.addIgnore('version', '9.9.9', 2);
    const other = await s.reporters.addIgnore('address', '9.9.9', 3);
    expect(again).toEqual(first);
    expect(other.id).not.toBe(first.id);
    expect(await db.all('SELECT kind, pattern, created_at FROM reporter_ignores ORDER BY id')).toEqual([{ kind: 'version', pattern: '9.9.9', created_at: 1 }, { kind: 'address', pattern: '9.9.9', created_at: 3 }]);
  });

  it('chat read state: the (person, thread) pair', async () => {
    const chat = s.chat({ now: () => 5 });
    await chat.readState.bump('ana', 'grp_a', true);
    await chat.readState.bump('ana', 'grp_a', false);
    await chat.readState.bump('ana', 'grp_b', false);
    await chat.readState.bump('ben', 'grp_a', false);
    await chat.readState.markRead('ana', 'grp_b', 'm9');
    expect(await db.all('SELECT person, thread, unread, mentions, last_read FROM chat_read_state ORDER BY person, thread')).toEqual([
      { person: 'ana', thread: 'grp_a', unread: 2, mentions: 1, last_read: null }, { person: 'ana', thread: 'grp_b', unread: 0, mentions: 0, last_read: 'm9' },
      { person: 'ben', thread: 'grp_a', unread: 1, mentions: 0, last_read: null },
    ]);
  });
});
