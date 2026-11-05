// Contract cases for the fleet, people and reporter methods the first cases do not reach (#890): spend and its split, samples and
// retention, sessions that were cleared or dropped, the People tab's deletes and lookups, and the reporter ignore and forget rules.
// Each runs one scenario over every adapter (`sameOnAll`).
import { it, expect } from 'vitest';
import { onEachAdapter, sameOnAll, type Openers } from './contractSame.js';
import { session } from './contract.js';
import { validateReport, MAX_REPORT_NUMBER } from '../fleet/protocol.js';
import { ingestReport } from '../fleet/ingest.js';
import { loadFixture } from '../fleet/testing.js';
import type { AgentRow, CostOf, ReporterSeen, SampleRow } from './rows.js';

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
/** A person's key id and token hash come from a random token, so they differ between two storages by design; the rest must not. */
const bare = <T extends { keyId: string; tokenHash: string } | undefined | null>(p: T): T => (p ? { ...p, keyId: 'k', tokenHash: 'h' } : p);
const priced: CostOf = (row) => row.cost_usd;
const sample = (id: string, t: number, over: Partial<SampleRow> = {}): SampleRow => ({
  session_id: id, t, tokens_total: 10 * t % 97, tokens_delta: t % 7, peak_context: 5, running_agents: 1, cost_usd: null, ...over,
});
const agent = (sessionId: string, id: string, over: Partial<AgentRow> = {}): AgentRow => ({
  session_id: sessionId, id, parent_id: null, kind: 'sub', type: 'Explore', name: null, description: 'look', model: null, effort: null, effort_source: null,
  status: 'running', started_at: T0, ended_at: null, context_tokens: null, context_window: null, context_percent: null, tok_in: 1, tok_out: 2, tok_cr: 3, tok_cw: 4,
  cost_usd_est: 0.25, skills_json: null, last_tool: null, tool_calls: 0, tool_counts_json: null, usage_json: null, blowouts: 0, steps_done: null, steps_total: null,
  prompt_excerpt: null, answer_excerpt: null, failure_json: null, model_label: null, model_provider: null, ...over,
});
const seen = (id: string, name: string | null, over: Partial<ReporterSeen> = {}): ReporterSeen => ({
  kind: 'mod', machineId: id, machineName: name, source: `10.0.0.${id.length}`, owner: 'ed', credential: 'person', version: '0.1.0', engineVersion: null,
  sessionId: `s-${id}`, os: 'macOS', peers: true, ...over,
});

export function fleetCases(o: Openers): void {
  it('agrees on every adapter for the spend queries: totals, the split by owner, ties in the order, and the group of an owner', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const f = s.fleet;
      const { person } = await s.people.createPerson('Ann', null, T0);
      const crew = await s.people.createGroup('Crew', T0);
      await s.people.setGroup(person.id, crew.id);
      await s.people.createPerson('ann-two', null, T0);
      // equal spend on three owners, so the order of the split is decided by the tie rule and not by the amounts
      const rows = [
        session({ id: 'a', name: 'a', owner: 'Ann', cost_usd: 2, last_seen_at: T0 + 10 }),
        session({ id: 'b', name: 'b', owner: 'ann-two', cost_usd: 2, last_seen_at: T0 + 10 }),
        session({ id: 'c', name: 'c', owner: null, cost_usd: 2, last_seen_at: T0 + 10 }),
        session({ id: 'd', name: 'd', owner: 'Ann', cost_usd: 0.5, last_seen_at: T0 + 20, usage_json: '[]' }),
        session({ id: 'e', name: 'e', owner: 'ghost', cost_usd: null, last_seen_at: T0 + 20 }),
        session({ id: 'old', name: 'old', owner: 'Ann', cost_usd: 9, last_seen_at: T0 - DAY }),
      ];
      for (const r of rows) await f.upsertSession(r);
      await f.upsertAgent(agent('a', 'a1'));
      await f.upsertAgent(agent('a', 'a2', { cost_usd_est: 0.5 }));
      await f.upsertAgent(agent('d', 'd1', { cost_usd_est: null }));
      await rec('spend', f.sessionSpendSince(T0, priced));
      await rec('spend (no cost function)', f.sessionSpendSince(T0));
      await rec('agent costs', f.agentCostsSince(T0, priced));
      await rec('cost since', f.costSince(T0, priced));
      await rec('cost since (everything)', f.costSince(0, priced));
      await rec('by owner', f.costByOwnerSince(T0, priced));
      await rec('totals', f.spendTotals(T0, priced));
      await rec('group of Ann', f.groupOfOwner('Ann'));
      await rec('group of the person with none', f.groupOfOwner('ann-two'));
      await rec('group of nobody', f.groupOfOwner(null));
      await rec('group of an unknown name', f.groupOfOwner('ghost'));
    });
    expect(t.get('group of nobody')).toBeNull();
    expect(t.get('group of Ann')).toBe('Crew');
  });

  it('agrees on every adapter for sessions that were cleared, dropped, deleted or ended, and for the reporter versions they carry', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const f = s.fleet;
      await f.upsertSession(session({ id: 'first', reporter_version: '1.0.0', ended_at: T0 + 5, status: 'done' }));
      await f.upsertSession(session({ id: 'second', reporter_version: '1.0.0', cleared_from: 'first' }));
      await f.upsertSession(session({ id: 'third', reporter_version: '0.9.0', cleared_from: 'first' }));
      await f.upsertSession(session({ id: 'none', reporter_version: null }));
      await rec('cleared into', f.clearedInto('first'));
      await rec('cleared into (nothing)', f.clearedInto('second'));
      await rec('versions', f.distinctReporterVersions());
      await rec('ended between', f.endedBetween(T0, T0 + 10));
      await f.setDropped('second', T0 + 6);
      await rec('ended between (dropped)', f.endedBetween(T0, T0 + 10));
      await rec('live candidates (dropped hidden)', f.liveCandidates(0));
      await rec('delete', f.deleteSession('third'));
      await rec('delete again', f.deleteSession('third'));
      await rec('get deleted', f.getSession('third'));
    });
    expect(t.get('delete')).toBe(true);
    expect(t.get('delete again')).toBe(false);
  });

  it('agrees on every adapter for agent texts, aborting open agents, compactions and samples written once', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const f = s.fleet;
      await f.upsertSession(session({ id: 'x' }));
      await f.upsertAgent(agent('x', 'run', { status: 'running' }));
      await f.upsertAgent(agent('x', 'queued', { status: 'queued' }));
      await f.upsertAgent(agent('x', 'fin', { status: 'done', ended_at: T0 + 1 }));
      await rec('texts (none)', f.getAgentTexts('x', 'run'));
      await f.upsertAgentTexts('x', 'run', { prompt: 'p1' });
      await rec('texts (prompt)', f.getAgentTexts('x', 'run'));
      await f.upsertAgentTexts('x', 'run', { answer: 'a1' });
      await rec('texts (kept prompt)', f.getAgentTexts('x', 'run'));
      await f.abortOpenAgents('x', T0 + 9);
      await rec('agents (aborted)', f.getAgents('x'));
      await rec('agents by ids (one unknown, one repeated)', f.getAgentsByIds('x', ['fin', 'nope', 'run', 'fin']));
      await rec('agents by ids (none asked)', f.getAgentsByIds('x', []));
      await rec('agents by ids (another session)', f.getAgentsByIds('other', ['run']));
      await f.insertBlowout({ session_id: 'x', agent_id: null, t: T0, kind: 'compact', tokens_before: 9, tokens_after: 1 });
      await f.insertBlowout({ session_id: 'x', agent_id: null, t: T0 + 1, kind: 'auto-compact', tokens_before: 9, tokens_after: 1 });
      await f.insertBlowout({ session_id: 'x', agent_id: null, t: T0 + 2, kind: 'clear', tokens_before: null, tokens_after: null });
      await rec('auto compactions', f.countAutoCompactions('x'));
      await f.insertSampleIfAbsent(sample('x', 100, { tokens_total: 1 }));
      await f.insertSampleIfAbsent(sample('x', 100, { tokens_total: 2 }));
      await rec('sample (first wins)', f.latestSample('x'));
      await f.upsertSample(sample('x', 100, { tokens_total: 3 }));
      await rec('sample (upsert replaces)', f.latestSample('x'));
    });
    expect((t.get('sample (first wins)') as SampleRow).tokens_total).toBe(1);
    expect((t.get('sample (upsert replaces)') as SampleRow).tokens_total).toBe(3);
  });

  it('reads many sessions at once, and writes many agents at once, as the one-at-a-time methods do (#906)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const f = s.fleet;
      const { person } = await s.people.createPerson('Ann', null, T0);
      const crew = await s.people.createGroup('Crew', T0);
      await s.people.setGroup(person.id, crew.id);
      await s.people.createPerson('solo', null, T0);
      await f.upsertSession(session({ id: 'b', owner: 'Ann', started_at: T0 + 2 }));
      await f.upsertSession(session({ id: 'a', owner: 'solo', started_at: T0 + 1 }));
      await f.upsertSession(session({ id: 'c', owner: null }));
      // one statement for each of three agents, one of them with texts and one that is rewritten
      await f.upsertAgents([agent('a', 'a2', { started_at: T0 + 5 }), agent('a', 'a1', { started_at: T0 + 5 }), agent('b', 'b1')]);
      await f.upsertAgents([agent('a', 'a1', { status: 'done', ended_at: T0 + 9 })]);
      await f.upsertAgents([]);
      await f.upsertAgentTextsMany('a', [{ agentId: 'a1', prompt: 'p1' }, { agentId: 'a2', answer: 'x2' }]);
      await f.upsertAgentTextsMany('a', [{ agentId: 'a1', answer: 'x1' }]);
      await f.upsertAgentTextsMany('a', []);
      await rec('texts a1 (kept prompt)', f.getAgentTexts('a', 'a1'));
      await rec('texts a2', f.getAgentTexts('a', 'a2'));
      await f.insertBlowout({ session_id: 'b', agent_id: null, t: T0 + 3, kind: 'compact', tokens_before: 9, tokens_after: 1 });
      await f.insertBlowout({ session_id: 'b', agent_id: null, t: T0 + 1, kind: 'clear', tokens_before: null, tokens_after: null });
      await f.insertEvent({ id: 'e1', session_id: 'a', agent_id: null, t: T0, kind: 'compact', text: 't', data_json: '{"trigger":"auto"}' });
      await f.insertEvent({ id: 'e2', session_id: 'a', agent_id: null, t: T0 + 1, kind: 'compact', text: 't', data_json: '{"trigger":"manual"}' });
      for (const [id, secs] of [['b', [100, 90, 95]], ['a', [100]]] as const) for (const t of secs) await f.upsertSample(sample(id, t));
      const ids = ['c', 'missing', 'a', 'b'];
      const batched = await rec('sessions', f.getSessions(ids));
      const agents = await rec('agents', f.getAgentsOf(ids));
      const blowouts = await rec('blowouts', f.getBlowoutsOf(ids));
      const compactions = await rec('auto compactions', f.countAutoCompactionsOf(ids));
      const samples = await rec('samples', f.samplesSinceOf(ids, 95));
      const owners: (string | null)[] = ['solo', null, 'Ann', 'ghost'];
      const groups = await rec('groups', f.groupsOfOwners(owners));
      await rec('nothing asked', [await f.getSessions([]), await f.getAgentsOf([]), await f.samplesSinceOf([], 0), await f.groupsOfOwners([])]);
      // the batch answers what the one-at-a-time methods answer, in the order the ids were given
      const rows: unknown[] = [];
      for (const id of ids) {
        const r = await f.getSession(id);
        if (r) rows.push(r);
      }
      expect(batched).toEqual(rows);
      for (const id of ids) {
        expect(agents.get(id)).toEqual(await f.getAgents(id));
        expect(blowouts.get(id)).toEqual(await f.getBlowouts(id));
        expect(compactions.get(id)).toBe(await f.countAutoCompactions(id));
        expect(samples.get(id)).toEqual(await f.samplesSince(id, 95));
      }
      expect([...agents.keys()]).toEqual(ids);
      for (const owner of owners) expect(groups.get(owner)).toBe(await f.groupOfOwner(owner));
    });
    expect((t.get('sessions') as { id: string }[]).map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(t.get('texts a1 (kept prompt)')).toEqual({ prompt: 'p1', answer: 'x1' });
    expect(t.get('auto compactions')).toEqual(new Map([['c', 0], ['missing', 0], ['a', 1], ['b', 0]]));
  });

  onEachAdapter(o, 'batched reads and writes past one statement\'s share of ids and rows return everything, in order (#906)', async (s) => {
    const f = s.fleet;
    const ids = Array.from({ length: 1100 }, (_, i) => `n${String(i).padStart(4, '0')}`);
    for (const id of ids) await f.upsertSession(session({ id, name: id }));
    await f.upsertAgents(Array.from({ length: 1100 }, (_, i) => agent('n0000', `g${String(i).padStart(4, '0')}`, { started_at: T0 + i })));
    await f.upsertAgentTextsMany('n0000', Array.from({ length: 1100 }, (_, i) => ({ agentId: `g${String(i).padStart(4, '0')}`, prompt: `p${i}` })));
    expect((await f.getSessions(ids)).map((r) => r.id)).toEqual(ids);
    const agents = await f.getAgentsOf(ids);
    expect(agents.size).toBe(1100);
    expect(agents.get('n0000')!.map((a) => a.id)).toEqual((await f.getAgents('n0000')).map((a) => a.id));
    expect(agents.get('n0000')).toHaveLength(1100);
    expect(agents.get('n1099')).toEqual([]);
    expect(await f.getAgentTexts('n0000', 'g1099')).toEqual({ prompt: 'p1099', answer: null });
    expect((await f.countAutoCompactionsOf(ids)).size).toBe(1100);
  }, 60_000);

  it('agrees on every adapter for the fleet-wide rates and for what retention deletes', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const f = s.fleet;
      const now = T0 + 400 * DAY;
      await f.upsertSession(session({ id: 'live', ended_at: null, last_seen_at: now }));
      await f.upsertSession(session({ id: 'gone', ended_at: T0, status: 'done', last_seen_at: T0 }));
      await f.upsertAgent(agent('gone', 'g1', { status: 'done', ended_at: T0 }));
      await f.insertEvent({ id: 'old-e', session_id: 'gone', agent_id: null, t: T0, kind: 'k', text: 't', data_json: null });
      await f.insertEvent({ id: 'new-e', session_id: 'live', agent_id: null, t: now, kind: 'k', text: 't', data_json: null });
      const sec = Math.floor(now / 1000);
      // two sessions sampling the same second and minute, with a cost that goes up, then down, then up
      for (const [id, cost] of [['live', 1], ['gone', 1]] as const) {
        await f.upsertSample(sample(id, sec - 120, { tokens_delta: 4, cost_usd: cost }));
        await f.upsertSample(sample(id, sec - 60, { tokens_delta: 6, cost_usd: cost + 0.5 }));
        await f.upsertSample(sample(id, sec - 30, { tokens_delta: 1, cost_usd: cost + 0.25 }));
        await f.upsertSample(sample(id, sec, { tokens_delta: 2, cost_usd: cost + 1 }));
      }
      await f.upsertSample(sample('gone', Math.floor(T0 / 1000), { cost_usd: 1 }));
      await rec('tokens per second', f.fleetTokensPerSecond(sec - 200));
      await rec('cost per minute', f.fleetCostPerMinute(sec - 200, priced));
      await rec('cost per minute (no cost function)', f.fleetCostPerMinute(sec - 200));
      await rec('retained', f.retain(now, { samplesMs: 30 * DAY, eventsMs: 30 * DAY, sessionsMs: 30 * DAY, adminLogMs: 30 * DAY }));
      await rec('live kept', f.getSession('live'));
      await rec('ended session gone', f.getSession('gone'));
      await rec('its agents gone', f.getAgents('gone'));
      await rec('events left', f.listEvents({ limit: 10 }));
      await rec('retained again', f.retain(now, { samplesMs: 30 * DAY, eventsMs: 30 * DAY, sessionsMs: 30 * DAY, adminLogMs: 30 * DAY }));
    });
    expect(t.get('ended session gone')).toBeUndefined();
    expect(t.get('live kept')).toBeDefined();
  });

  it('stores text with non-ASCII letters, emoji, quotes, backslashes and wildcards as it is, and finds it by a search that treats them as plain characters (#1007)', async () => {
    // Every value here is one a person can type or a harness can send, and the report validator lets it through (it removes control
    // characters, which includes NUL; a NUL never reaches a store, and not every database stores one, so it is no case here).
    // a token and the credential made from it are random, so they are not compared
    const plain = <P extends { credential?: string; keyId?: string; tokenHash?: string }>(p: P): P => ({
      ...p,
      ...(p.keyId === undefined ? {} : { keyId: 'k' }),
      ...(p.tokenHash === undefined ? {} : { tokenHash: 'h' }),
      ...(p.credential === undefined ? {} : { credential: 'c' }),
    });
    const odd = ['Émile Zola', 'émile', '日本語 テスト', 'party \u{1F389} \u{1F9D1}‍\u{1F4BB}', 'é combining', 'it\'s "quoted" \\ back; --', '100% sure_ish', '%', '_', 'ǅ title'];
    const t = await sameOnAll(o, async (s, rec) => {
      // the people, group, machine and Admin-log paths
      for (const [i, name] of odd.entries()) await rec(`person ${i}`, s.people.createPerson(name, null, T0 + i).then((r) => plain(r.person)));
      for (const [i, name] of odd.entries()) await rec(`group ${i}`, s.people.createGroup(`g ${name}`, T0 + i));
      for (const [i, name] of odd.entries()) await s.people.log('note', name, name, T0 + i, name);
      await rec('people', s.people.list({ pageSize: 50 }).then((r) => ({ ...r, rows: r.rows.map(plain) })));
      // the built-in group is created when the database is, so its time is the wall clock's and is not compared
      await rec('groups', s.people.listGroups({ pageSize: 50 }).then((r) => ({ ...r, rows: r.rows.filter((g) => !g.builtIn) })));
      await rec('log', s.people.listLog({ pageSize: 50 }));
      // a search takes % and _ as the characters they are
      for (const q of ['%', '_', '100%', 'sure_', 'Émile', 'émile', 'ÉMILE', '日本', '\u{1F389}', 'é', '\\', '"quoted"', "it's", 'ǆ'])
        await rec(`search ${JSON.stringify(q)}`, s.people.list({ q, pageSize: 50 }).then((r) => r.rows.map((p) => p.name)));
      // sessions, agents, events and settings
      const fleet = s.fleet;
      for (const [i, name] of odd.entries()) {
        await fleet.upsertSession(session({ id: `s${i}`, name, cwd: `/w/${name}`, wait_note: name, owner: name, started_at: T0 + i }));
        await fleet.upsertAgent(agent(`s${i}`, `a${i}`, { description: name, name, prompt_excerpt: name, answer_excerpt: name, last_tool: name }));
        await fleet.insertEvent({ id: `e${i}`, session_id: `s${i}`, agent_id: null, t: T0 + i, kind: 'note', text: name, data_json: JSON.stringify({ name }) });
        await fleet.upsertAgentTexts(`s${i}`, `a${i}`, { prompt: name, answer: name });
      }
      await rec('sessions', fleet.getSessions(odd.map((_, i) => `s${i}`)));
      await rec('agents', fleet.getAgentsOf(odd.map((_, i) => `s${i}`)));
      await rec('events', fleet.listEvents({ limit: 50 }));
      await rec('texts', Promise.all(odd.map((_, i) => fleet.getAgentTexts(`s${i}`, `a${i}`))));
      // reporter ignore rules and the reporter search
      for (const [i, name] of odd.entries()) await s.reporters.record(seen(`m${i}`, name), T0 + i);
      for (const [i, name] of odd.entries()) await rec(`ignore ${i}`, s.reporters.addIgnore('key', `k-${name}`, T0 + i));
      await rec('ignores', s.reporters.listIgnores());
      for (const q of ['%', '_', 'Émile', 'émile', '日本', '\u{1F389}', '\\']) await rec(`reporters ${JSON.stringify(q)}`, s.reporters.keys({ q }, T0 + 100));
    });
    // the values themselves, not only the agreement between two databases
    const names = (t.get('people') as { rows: { name: string }[] }).rows.map((p) => p.name).sort();
    expect(names).toEqual([...odd].sort());
    const sessions = t.get('sessions') as { name: string; wait_note: string; owner: string }[];
    expect(sessions.map((r) => r.name)).toEqual(odd);
    expect(sessions.map((r) => r.wait_note)).toEqual(odd);
    expect((t.get('texts') as { prompt: string }[]).map((r) => r.prompt)).toEqual(odd);
    expect((t.get('events') as { text: string }[]).map((r) => r.text).sort()).toEqual([...odd].sort());
    // a wildcard is a plain character in a search: '%' finds the two names with a percent sign in them, '_' the two with an underscore
    expect(t.get('search "%"')).toEqual(['%', '100% sure_ish']);
    expect(t.get('search "_"')).toEqual(['100% sure_ish', '_']);
    // a person's name is folded by the app (full Unicode lower case) before it reaches a store, so É and é are one letter to the search
    for (const q of ['Émile', 'émile', 'ÉMILE']) expect(t.get(`search ${JSON.stringify(q)}`), q).toEqual(['émile', 'Émile Zola']);
    expect(t.get('search "日本"')).toEqual(['日本語 テスト']);
    expect(t.get('search "\\\\"')).toEqual(["it's \"quoted\" \\ back; --"]);
  });

  it('stores a NUL in a string without it and a NaN as NULL, the same on every adapter (#1007)', async () => {
    // The report validator strips a NUL and refuses a NaN before a store is called, so none of this is reachable over HTTP. It is a rule of
    // the storage layer anyway: a database may refuse a NUL in text, or keep a NaN as a number that is not NULL, so each adapter converts
    // them where it binds a value, and the stored data is the same in all of them.
    const t = await sameOnAll(o, async (s, rec) => {
      const f = s.fleet;
      await f.upsertSession(session({ id: 'n', name: 'a\0b', wait_note: '\0', owner: 'x\0', cost_usd: Number.NaN, started_at: T0, last_seen_at: T0 }));
      await f.upsertAgent(agent('n', 'a1', { description: 'd\0', cost_usd_est: Number.NaN }));
      await f.upsertSample(sample('n', Math.floor(T0 / 1000), { cost_usd: Number.NaN }));
      await f.insertEvent({ id: 'e', session_id: 'n', agent_id: null, t: T0, kind: 'note', text: 'te\0xt', data_json: null });
      await rec('session', f.getSession('n'));
      await rec('agents', f.getAgents('n'));
      await rec('events', f.listEvents({ limit: 10 }));
      await rec('cost per minute', f.fleetCostPerMinute(0, priced));
    });
    const row = t.get('session') as { name: string; wait_note: string; owner: string; cost_usd: number | null };
    expect(row.name).toBe('ab');
    expect(row.wait_note).toBe('');
    expect(row.owner).toBe('x');
    expect(row.cost_usd).toBeNull();
    expect((t.get('agents') as { description: string; cost_usd_est: number | null }[])[0]).toMatchObject({ description: 'd', cost_usd_est: null });
    expect((t.get('events') as { text: string }[])[0]!.text).toBe('text');
  });

  it('stores and reads back the largest number the validator takes in every whole-number column, and doubles at both ends of the range (#1007)', async () => {
    const M = MAX_REPORT_NUMBER;
    const reals = { cost_usd: 1 / 3, context_percent: M / 3 };
    const t = await sameOnAll(o, async (s, rec) => {
      const f = s.fleet;
      await f.upsertSession(session({
        id: 'max', started_at: M, last_seen_at: M, ended_at: M, dropped_at: M, context_tokens: M, context_window: M, tok_in: M, tok_out: M, tok_cr: M, tok_cw: M,
        blowouts: M, attached: 1, detached_at: M, ...reals,
      }));
      await f.upsertSession(session({ id: 'tiny', cost_usd: 1e-300, context_percent: 5e-324, started_at: 0, last_seen_at: 0, tok_in: 0 }));
      await f.upsertAgent(agent('max', 'a', {
        started_at: M, ended_at: M, context_tokens: M, context_window: M, tok_in: M, tok_out: M, tok_cr: M, tok_cw: M, tool_calls: M, blowouts: M, steps_done: M, steps_total: M,
        cost_usd_est: M / 7, context_percent: 1 / 3,
      }));
      await f.upsertSample(sample('max', M, { tokens_total: M, tokens_delta: M, running_agents: M, peak_context: M / 3, cost_usd: 1e-300 }));
      await f.insertEvent({ id: 'e', session_id: 'max', agent_id: null, t: M, kind: 'k', text: 't', data_json: null });
      await f.insertBlowout({ session_id: 'max', agent_id: null, t: M, kind: 'compact', tokens_before: M, tokens_after: M });
      await rec('session', f.getSession('max'));
      await rec('tiny', f.getSession('tiny'));
      await rec('agents', f.getAgents('max'));
      await rec('sample', f.latestSample('max'));
      await rec('events', f.listEvents({ sessionId: 'max', limit: 5 }));
      await rec('events before the end of the range', f.listEvents({ before: M + 1, limit: 5 }));
      await rec('blowouts', f.getBlowouts('max'));
      await rec('live', f.liveCandidates(0));
      await rec('ended between', f.endedBetween(M - 1, M + 1));
      await rec('samples since', f.samplesSince('max', M));
    });
    const row = t.get('session') as Record<string, unknown>;
    for (const col of ['started_at', 'last_seen_at', 'ended_at', 'dropped_at', 'context_tokens', 'context_window', 'tok_in', 'tok_out', 'tok_cr', 'tok_cw', 'blowouts', 'detached_at']) expect(row[col], col).toBe(M);
    expect(row.cost_usd).toBe(reals.cost_usd);
    expect(row.context_percent).toBe(reals.context_percent);
    expect((t.get('tiny') as Record<string, unknown>).cost_usd).toBe(1e-300);
    expect((t.get('tiny') as Record<string, unknown>).context_percent).toBe(5e-324);
    expect((t.get('agents') as Record<string, unknown>[])[0]).toMatchObject({ started_at: M, tool_calls: M, steps_total: M, cost_usd_est: M / 7 });
    expect(t.get('sample')).toMatchObject({ t: M, tokens_total: M, running_agents: M, peak_context: M / 3 });
    expect((t.get('events') as { t: number }[]).map((e) => e.t)).toEqual([M]);
  });
}

export function peopleCases(o: Openers): void {
  it('agrees on every adapter for looking a person up by key id or administrator token, and for the group they are in', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const p = s.people;
      const admins = await rec('administrators group', p.administratorsGroupId());
      const { person: boss, token } = await p.createPerson('boss', admins, T0);
      const { person: rank, token: rankToken } = await p.createPerson('rank', null, T0);
      await rec('find by key id', p.findByKeyId(boss.keyId).then(bare));
      await rec('find by unknown key id', p.findByKeyId('nope'));
      await rec('administrator by token', p.findAdministratorByToken(token).then(bare));
      await rec('not an administrator', p.findAdministratorByToken(rankToken));
      await rec('wrong token', p.findAdministratorByToken('podium_x'));
      const g = await rec('group', p.createGroup('Crew', T0));
      await rec('get group', p.getGroup(g.id));
      await rec('get unknown group', p.getGroup(99_999));
      await rec('set group', p.setGroup(rank.id, g.id));
      await rec('set group of an unknown person', p.setGroup(99_999, g.id));
      await rec('person with group', p.getPerson(rank.id).then(bare));
      await rec('delete group', p.deleteGroup(g.id));
      await rec('delete group again', p.deleteGroup(g.id));
      await rec('person after the group went', p.getPerson(rank.id).then(bare));
    });
    expect(t.get('find by unknown key id')).toBeUndefined();
    expect(t.get('not an administrator')).toBeUndefined();
  });

  it('agrees on every adapter for the last-administrator rule, restoring a revoked person and deleting several at once', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const p = s.people;
      const admins = (await p.administratorsGroupId())!;
      const { person: a } = await p.createPerson('adm-a', admins, T0);
      const { person: plain } = await p.createPerson('plain', null, T0);
      await rec('last administrator', p.assertNotLastAdministrator(a.id));
      await rec('not in the group', p.assertNotLastAdministrator(plain.id));
      const { person: b } = await p.createPerson('adm-b', admins, T0 + 1);
      await rec('one of two', p.assertNotLastAdministrator(a.id));
      await rec('revoke b', p.revoke(b.id, T0 + 2));
      await rec('a is last again', p.assertNotLastAdministrator(a.id));
      await rec('revoked person is fine', p.assertNotLastAdministrator(b.id));
      await rec('restore b', p.restore(b.id));
      await rec('restore b again', p.restore(b.id));
      await rec('restore unknown', p.restore(99_999));
      await rec('delete both administrators', p.deleteMany([a.id, b.id]).then((r) => r.map(bare)));
      await rec('still there', p.getPerson(a.id).then(bare));
      await rec('delete plain and an unknown id', p.deleteMany([plain.id, 99_999]).then((r) => r.map(bare)));
      await rec('plain is gone', p.getPerson(plain.id).then(bare));
    });
    expect(String((t.get('last administrator') as { threw?: string }).threw ?? '')).not.toBe('');
    expect(t.get('not in the group')).toBeUndefined();
  });
}

export function reporterCases(o: Openers): void {
  it('agrees on every adapter for the keys a sender is known by, the filtered key list, removing, and the refused-report list', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const r = s.reporters;
      await rec('keys (new)', r.keysFor({ kind: 'mod', machineId: 'mk', source: '203.0.113.1', sessionId: 'sk', owner: 'ed' }));
      const k1 = await rec('record', r.record(seen('mk', 'kay'), T0));
      await r.record(seen('m2', 'bee', { owner: 'bob' }), T0 + 1);
      await r.record(seen('m3', 'cee', { kind: 'hooks', machineId: null, source: '203.0.113.22', sessionId: 's3' }), T0 + 2);
      await rec('keys (known session)', r.keysFor({ kind: 'mod', machineId: null, source: '203.0.113.99', sessionId: 's-mk', owner: 'ed' }));
      await rec('keys', r.keys({}, T0 + 3));
      await rec('keys (query)', r.keys({ q: 'bee' }, T0 + 3));
      await rec('keys (state)', r.keys({ state: 'reporting' }, T0 + 3));
      await rec('get', r.get(k1, T0 + 3));
      await rec('get unknown', r.get('nope', T0 + 3));
      await rec('rejected', r.rejected('203.0.113.77', 'bad token', T0 + 4));
      await rec('rejected (no source)', r.rejected(null, 'bad token', T0 + 5));
      await rec('remove', r.remove(k1));
      await rec('remove again', r.remove(k1));
      await rec('remove many', r.removeMany(['m2', 'nope']));
      await rec('left', r.keys({}, T0 + 6));
    });
    expect(t.get('remove')).toBe(true);
    expect(t.get('remove again')).toBe(false);
    expect(t.get('remove many')).toBe(1);
  });

  it('agrees on every adapter for ignore rules: first match wins, a rule hides what it matches, and removing by state', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const r = s.reporters;
      await r.record(seen('i1', 'one', { version: '0.0.1' }), T0);
      await r.record(seen('i2', 'two', { version: '0.0.2', source: '203.0.113.55' }), T0);
      await rec('rules (none)', r.listIgnores());
      await rec('add version rule', r.addIgnore('version', '0.0.1', T0 + 1));
      await rec('add it again (kept once)', r.addIgnore('version', '0.0.1', T0 + 2));
      await rec('add address rule', r.addIgnore('address', '203.0.113.55', T0 + 3));
      await rec('add bad rule', r.addIgnore('key', '   ', T0 + 4));
      await rec('rules', r.listIgnores());
      await rec('ignored by version', r.ignoredBy({ key: 'x', source: null, version: '0.0.1' }));
      await rec('ignored by address', r.ignoredBy({ key: 'x', source: '203.0.113.55', version: '9' }));
      await rec('ignored by other key', r.ignoredBy({ key: 'x', otherKeys: ['i2'], source: null, version: '9' }));
      await rec('not ignored', r.ignoredBy({ key: 'x', source: null, version: '9' }));
      await rec('list after rules hid them', r.keys({}, T0 + 5));
      await rec('remove rule', r.removeIgnore(1));
      await rec('remove rule again', r.removeIgnore(1));
      await rec('rules (after)', r.listIgnores());
      await r.record(seen('i3', 'three'), T0);
      await rec('remove by state', r.removeState('restart', T0 + 5));
      await rec('remove by state (reporting)', r.removeState('reporting', T0 + 6));
    });
    expect((t.get('rules') as unknown[]).length).toBe(2);
  });

  it('agrees on every adapter for the forget setting and for forgetting reporters not heard from', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const r = s.reporters;
      await rec('setting (fresh)', r.forgetSetting());
      await rec('set days too low', r.setForgetSetting({ days: 0 }));
      await rec('set days fractional', r.setForgetSetting({ days: 1.5 }));
      await rec('set days too high', r.setForgetSetting({ days: 3651 }));
      await rec('setting (refused)', r.forgetSetting());
      await r.record(seen('f-old', 'old'), T0);
      await r.record(seen('f-new', 'new'), T0 + 40 * DAY);
      await rec('forget (off)', r.forgetStale(T0 + 41 * DAY));
      await rec('set days only', r.setForgetSetting({ days: 30 }));
      await rec('setting (days kept while off)', r.forgetSetting());
      await rec('set on', r.setForgetSetting({ enabled: true }));
      await rec('forget', r.forgetStale(T0 + 41 * DAY));
      await rec('left', r.keys({}, T0 + 41 * DAY));
      await rec('setting (on)', r.forgetSetting());
    });
    expect(t.get('forget (off)')).toBe(0);
  });

  onEachAdapter(o, 'rejects a report whose number no column can read back, and keeps reading the sessions already stored (#1007)', async (s) => {
    const good = validateReport(loadFixture());
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    await ingestReport(s, good.report, T0);
    const id = good.report.session.id;
    const before = await s.fleet.getSession(id);
    expect(before).toBeDefined();

    const bad = loadFixture() as { session: { id: string; tokens: { input: number } } };
    bad.session.id = 'too-big';
    bad.session.tokens.input = 1e16;
    expect(validateReport(bad)).toMatchObject({ ok: false, path: '$.session.tokens.input' });

    // the biggest the validator takes is stored and read back, on this adapter as on the other
    const big = loadFixture() as { session: { id: string; tokens: { input: number } } };
    big.session.id = 'the-biggest';
    big.session.tokens.input = MAX_REPORT_NUMBER;
    const ok = validateReport(big);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    await ingestReport(s, ok.report, T0 + 1);

    expect(await s.fleet.getSession(id)).toEqual(before);
    expect((await s.fleet.getSession('the-biggest'))?.tok_in).toBe(MAX_REPORT_NUMBER);
    expect((await s.fleet.liveCandidates(0)).map((r) => r.id).sort()).toEqual([id, 'the-biggest'].sort());
  });
}
