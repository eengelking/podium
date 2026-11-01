// Contract cases for the fleet, people and reporter methods the first cases do not reach (#890): spend and its split, samples and
// retention, sessions that were cleared or dropped, the People tab's deletes and lookups, and the reporter ignore and forget rules.
// Each runs one scenario over the adapter and over the reference (`sameOnBoth`).
import { it, expect } from 'vitest';
import { sameOnBoth, type Openers } from './contractSame.js';
import { session } from './contract.js';
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
  prompt_excerpt: null, answer_excerpt: null, failure_json: null, ...over,
});
const seen = (id: string, name: string | null, over: Partial<ReporterSeen> = {}): ReporterSeen => ({
  kind: 'mod', machineId: id, machineName: name, source: `10.0.0.${id.length}`, owner: 'ed', credential: 'person', version: '0.1.0', engineVersion: null,
  sessionId: `s-${id}`, os: 'macOS', peers: true, ...over,
});

export function fleetCases(o: Openers): void {
  it('matches the reference for the spend queries: totals, the split by owner, ties in the order, and the group of an owner', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
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

  it('matches the reference for sessions that were cleared, dropped, deleted or ended, and for the reporter versions they carry', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
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

  it('matches the reference for agent texts, aborting open agents, compactions and samples written once', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
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

  it('matches the reference for the fleet-wide rates and for what retention deletes', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
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
}

export function peopleCases(o: Openers): void {
  it('matches the reference for looking a person up by key id or administrator token, and for the group they are in', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
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

  it('matches the reference for the last-administrator rule, restoring a revoked person and deleting several at once', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
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
  it('matches the reference for the keys a sender is known by, the filtered key list, removing, and the refused-report list', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
      const r = s.reporters;
      await rec('keys (new)', r.keysFor({ kind: 'mod', machineId: 'mk', source: '1.1.1.1', sessionId: 'sk', owner: 'ed' }));
      const k1 = await rec('record', r.record(seen('mk', 'kay'), T0));
      await r.record(seen('m2', 'bee', { owner: 'bob' }), T0 + 1);
      await r.record(seen('m3', 'cee', { kind: 'hooks', machineId: null, source: '2.2.2.2', sessionId: 's3' }), T0 + 2);
      await rec('keys (known session)', r.keysFor({ kind: 'mod', machineId: null, source: '9.9.9.9', sessionId: 's-mk', owner: 'ed' }));
      await rec('keys', r.keys({}, T0 + 3));
      await rec('keys (query)', r.keys({ q: 'bee' }, T0 + 3));
      await rec('keys (state)', r.keys({ state: 'reporting' }, T0 + 3));
      await rec('get', r.get(k1, T0 + 3));
      await rec('get unknown', r.get('nope', T0 + 3));
      await rec('rejected', r.rejected('7.7.7.7', 'bad token', T0 + 4));
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

  it('matches the reference for ignore rules: first match wins, a rule hides what it matches, and removing by state', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
      const r = s.reporters;
      await r.record(seen('i1', 'one', { version: '0.0.1' }), T0);
      await r.record(seen('i2', 'two', { version: '0.0.2', source: '5.5.5.5' }), T0);
      await rec('rules (none)', r.listIgnores());
      await rec('add version rule', r.addIgnore('version', '0.0.1', T0 + 1));
      await rec('add it again (kept once)', r.addIgnore('version', '0.0.1', T0 + 2));
      await rec('add address rule', r.addIgnore('address', '5.5.5.5', T0 + 3));
      await rec('add bad rule', r.addIgnore('key', '   ', T0 + 4));
      await rec('rules', r.listIgnores());
      await rec('ignored by version', r.ignoredBy({ key: 'x', source: null, version: '0.0.1' }));
      await rec('ignored by address', r.ignoredBy({ key: 'x', source: '5.5.5.5', version: '9' }));
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

  it('matches the reference for the forget setting and for forgetting reporters not heard from', async () => {
    const t = await sameOnBoth(o, async (s, rec) => {
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
}
