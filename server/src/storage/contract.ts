// A contract any Storage adapter must meet (#313): the same calls through the async interface return what the
// synchronous stores return. Run it from an adapter's test with a function that opens a fresh Storage and one that builds
// the synchronous reference stores over a fresh database of its own.
//
// It also states what the app relies on from any database, with expected values written out and not compared with a
// reference: the JavaScript type of every field of the main rows, how names are compared, and the order lists come back in.
// An adapter whose database hands back bigints, 0/1 for flags, undefined for NULL, or sorts text with another collation,
// fails here and not in a screen.
import { describe, it, expect } from 'vitest';
import type { MessageRow, PeerReporterLookup } from '../fleet/peerTypes.js';
import { ACTIVITY_HISTORY_DEFAULTS } from '../fleet/activityHistoryTypes.js';
import { MAIN_LOOP, RECORDING_DEFAULTS, type ActivityEntry, type RecordingAdminRow, type RecordingBatch, type Report } from '../fleet/protocol.js';
import { fixtureReport } from '../fleet/testing.js';
import { PeopleError, nameKey } from './rows.js';
import { settingsCases } from './contractSettings.js';
import { activityCases } from './contractActivity.js';
import { peerCases } from './contractPeers.js';
import { fleetCases, peopleCases, reporterCases } from './contractFleet.js';
import type { StoredSessionRow } from '../fleet/activityHistoryTypes.js';
import type { AgentRow, BlowoutRow, EventRow, GroupListRow, PersonListRow, PersonRow, ReporterRow, ReporterSeen, SampleRow, SessionRow } from './rows.js';
import type { FleetStoreApi, PeopleStoreApi, ReporterStoreApi, Storage } from './types.js';

/** An async interface with its methods returning their results at once, which is what the synchronous stores do. */
type Sync<T> = { [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => R : T[K] };

/** The synchronous stores an adapter's async ones are compared with, each over its own fresh database. */
export interface ContractReference {
  people: Sync<Pick<PeopleStoreApi, 'adminReportingAllowed' | 'setAdminReporting' | 'createGroup' | 'log' | 'listLog' | 'allGroups'>>;
  fleet: Sync<Pick<FleetStoreApi, 'upsertSession' | 'getSession' | 'liveCandidates'>>;
  /** A fresh reference storage, which gives the reference answers for the stores that have no synchronous class to compare with (#890). */
  storage: () => Storage | Promise<Storage>;
  reporters: Sync<Pick<ReporterStoreApi, 'record' | 'list'>> & { peerLookup(): PeerReporterLookup };
}

export function session(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 's1', name: 'one', status: 'running', wait_reason: null, wait_note: null, end_reason: null, resume_id: null,
    started_at: 1000, last_seen_at: 2000, ended_at: null, dropped_at: null, cwd: '/w', project_root: null, repo_name: null,
    git_json: null, model: 'm', effort: null, context_tokens: null, context_window: null, context_percent: null,
    cost_usd: 1.5, tok_in: 1, tok_out: 2, tok_cr: 3, tok_cw: 4, rate_limits_json: null, blowouts: 0, plan_json: null,
    reporter_version: null, engine_version: null, loop_json: null, files_json: null, background_json: null,
    usage_json: null, attached: null, detached_at: null, owner: 'ed', machine_json: null, cleared_from: null,
    ...over,
  };
}

const seen: ReporterSeen = {
  kind: 'mod', machineId: 'm1', machineName: 'box', source: '127.0.0.1', owner: 'ed', credential: 'person',
  version: '0.1.0', engineVersion: null, sessionId: 's1',
};


/** What a field holds in JavaScript. A `?` kind is also allowed to be `null`; no kind is ever `undefined`. */
type Kind = 'int' | 'real' | 'text' | 'bool' | 'int?' | 'real?' | 'text?' | 'bool?' | 'texts';
type Shape<T> = { [K in keyof T]-?: Kind };

/** Fails when a field of `row` is missing, undefined, a bigint, a 0/1 for a flag, a string for a number or the like; names the field. */
const byText = (a: string, b: string): number => a.localeCompare(b);

function expectShape<T extends object>(what: string, row: T, shape: Shape<T>): void {
  expect(Object.keys(row).sort(byText), `${what}: the fields`).toEqual(Object.keys(shape).sort(byText));
  for (const [field, kind] of Object.entries(shape) as [string, Kind][]) {
    const v = (row as Record<string, unknown>)[field];
    const at = `${what}.${field}`;
    if (kind.endsWith('?') && v === null) continue;
    expect(v, `${at} is not undefined`).not.toBeUndefined();
    switch (kind.replace('?', '')) {
      case 'int': expect(typeof v, `${at} is a number`).toBe('number'); expect(Number.isInteger(v), `${at} is whole`).toBe(true); break;
      case 'real': expect(typeof v, `${at} is a number`).toBe('number'); expect(Number.isFinite(v), `${at} is finite`).toBe(true); break;
      case 'text': expect(typeof v, `${at} is a string`).toBe('string'); break;
      case 'bool': expect(typeof v, `${at} is a boolean`).toBe('boolean'); break;
      default: expect(Array.isArray(v) && v.every((x) => typeof x === 'string'), `${at} is a list of strings`).toBe(true);
    }
  }
}

const T0 = 1_800_000_000_000;

const SESSION_SHAPE: Shape<SessionRow> = {
  id: 'text', name: 'text', status: 'text', wait_reason: 'text?', wait_note: 'text?', end_reason: 'text?', resume_id: 'text?',
  started_at: 'int', last_seen_at: 'int', ended_at: 'int?', dropped_at: 'int?', cwd: 'text', project_root: 'text?', repo_name: 'text?',
  git_json: 'text?', model: 'text?', effort: 'text?', context_tokens: 'int?', context_window: 'int?', context_percent: 'real?',
  cost_usd: 'real?', tok_in: 'int', tok_out: 'int', tok_cr: 'int', tok_cw: 'int', rate_limits_json: 'text?', blowouts: 'int',
  plan_json: 'text?', plan_kept_json: 'text?', reporter_version: 'text?', reporter_build: 'text?', engine_version: 'text?',
  loop_json: 'text?', files_json: 'text?', background_json: 'text?', usage_json: 'text?', attached: 'int?', detached_at: 'int?',
  owner: 'text?', machine_json: 'text?', cleared_from: 'text?',
};
const AGENT_SHAPE: Shape<AgentRow> = {
  session_id: 'text', id: 'text', parent_id: 'text?', kind: 'text', type: 'text', name: 'text?', description: 'text', model: 'text?',
  effort: 'text?', effort_source: 'text?', status: 'text', started_at: 'int', ended_at: 'int?', context_tokens: 'int?',
  context_window: 'int?', context_percent: 'real?', tok_in: 'int', tok_out: 'int', tok_cr: 'int', tok_cw: 'int', cost_usd_est: 'real?',
  skills_json: 'text?', last_tool: 'text?', tool_calls: 'int', tool_counts_json: 'text?', usage_json: 'text?', blowouts: 'int',
  steps_done: 'int?', steps_total: 'int?', prompt_excerpt: 'text?', answer_excerpt: 'text?', failure_json: 'text?',
  prompt_chars: 'int?', answer_chars: 'int?',
};
const EVENT_SHAPE: Shape<EventRow> = { id: 'text', session_id: 'text', agent_id: 'text?', t: 'int', kind: 'text', text: 'text', data_json: 'text?' };
const BLOWOUT_SHAPE: Shape<BlowoutRow> = { id: 'int', session_id: 'text', agent_id: 'text?', t: 'int', kind: 'text', tokens_before: 'int?', tokens_after: 'int?' };
const SAMPLE_SHAPE: Shape<SampleRow> = { session_id: 'text', t: 'int', tokens_total: 'int', tokens_delta: 'int', peak_context: 'int', running_agents: 'int', cost_usd: 'real?', usage_json: 'text?' };
const PERSON_SHAPE: Shape<PersonRow> = { id: 'int', name: 'text', keyId: 'text', tokenHash: 'text', groupId: 'int?', createdAt: 'int', rotatedAt: 'int?', revokedAt: 'int?', lastReportAt: 'int?' };
const PERSON_LIST_SHAPE: Shape<PersonListRow> = { id: 'int', name: 'text', groupId: 'int?', createdAt: 'int', rotatedAt: 'int?', revokedAt: 'int?', lastReportAt: 'int?', credential: 'text', groupName: 'text?', machines: 'texts' };
const GROUP_LIST_SHAPE: Shape<GroupListRow> = { id: 'int', name: 'text', createdAt: 'int', members: 'texts', builtIn: 'bool' };
const REPORTER_SHAPE: Shape<ReporterRow> = {
  key: 'text', state: 'text', name: 'text', named: 'bool', who: 'text', credential: 'text?', adminSecret: 'bool', version: 'text', compat: 'text',
  firstSeenAt: 'int', lastSeenAt: 'int', sessions: 'int', live: 'int', os: 'text?', peers: 'bool?',
};
const MESSAGE_SHAPE: Shape<MessageRow> = {
  id: 'text', owner: 'text', link: 'text', fromKey: 'text', toKey: 'text', fromSession: 'text', toSession: 'text', fromName: 'text', fromMachine: 'text',
  toName: 'text', toMachine: 'text', text: 'text', sentAt: 'int', state: 'text', stateAt: 'int', why: 'text?', approved: 'bool',
};
const RECORDING_SHAPE: Shape<RecordingAdminRow> = {
  sessionId: 'text', name: 'text', owner: 'text?', startedBy: 'text?', state: 'text', limit: 'text?', loops: 'int', label: 'text', bytes: 'int', keptUntil: 'int?',
};
const STORED_SHAPE: Shape<StoredSessionRow> = { sessionId: 'text', name: 'text', project: 'text?', owner: 'text?', live: 'bool', entries: 'int', bytes: 'int', oldestAt: 'int' };

const mkSeen = (id: string, name: string | null, over: Partial<ReporterSeen> = {}): ReporterSeen => ({
  kind: 'mod', machineId: id, machineName: name, source: '127.0.0.1', owner: 'ed', credential: 'person', version: '0.1.0', engineVersion: null,
  sessionId: `s-${id}`, os: 'macOS', peers: true, ...over,
});

export function runStorageContract(name: string, open: () => Storage | Promise<Storage>, reference: () => ContractReference): void {
  describe(`${name} storage contract`, () => {
    const against = { open, referenceStorage: () => reference().storage() };
    settingsCases(against);
    fleetCases(against);
    peopleCases(against);
    reporterCases(against);
    peerCases(against);
    activityCases(against);

    it('matches the synchronous stores for people, the admin log and settings', async () => {
      const store = await open();
      const { people } = reference();
      expect(await store.people.adminReportingAllowed()).toBe(people.adminReportingAllowed());
      await store.people.setAdminReporting(false);
      people.setAdminReporting(false);
      expect(await store.people.adminReportingAllowed()).toBe(false);
      expect(await store.people.createGroup('Crew', 5)).toEqual(people.createGroup('Crew', 5));
      await store.people.log('kind', 'detail', 'src', 10, 'me');
      people.log('kind', 'detail', 'src', 10, 'me');
      expect(await store.people.listLog({})).toEqual(people.listLog({}));
      expect(await store.people.allGroups()).toEqual(people.allGroups());
      await store.close();
    });

    it('matches the synchronous stores for sessions', async () => {
      const store = await open();
      const { fleet } = reference();
      await store.fleet.upsertSession(session());
      fleet.upsertSession(session());
      expect(await store.fleet.getSession('s1')).toEqual(fleet.getSession('s1'));
      expect(await store.fleet.getSession('nope')).toBeUndefined();
      expect(await store.fleet.liveCandidates(0)).toEqual(fleet.liveCandidates(0));
      await store.close();
    });

    it('matches the synchronous stores for reporters and the peer lookup', async () => {
      const store = await open();
      const { reporters } = reference();
      const key = await store.reporters.record(seen, 50);
      expect(key).toBe(reporters.record(seen, 50));
      expect(await store.reporters.hasAny()).toBe(true);
      expect(await store.reporters.list({}, 60)).toEqual(reporters.list({}, 60));
      const lookup = store.reporters.peerLookup();
      expect(await lookup.get(key)).toEqual(reporters.peerLookup().get(key));
      expect(await lookup.ofOwner('ED')).toEqual(reporters.peerLookup().ofOwner('ED'));
      expect(await lookup.ofOwnerSeen('ed', 60)).toEqual(reporters.peerLookup().ofOwnerSeen('ed', 60));
      expect(lookup.startedAt).toBe(reporters.peerLookup().startedAt);
      await store.close();
    });

    it('returns the fleet rows with the types the interfaces declare', async () => {
      const store = await open();
      const f = store.fleet;
      // a row with every nullable field empty, and one with every field filled
      await f.upsertSession(session({ id: 'bare' }));
      expectShape('session (empty)', (await f.getSession('bare'))!, SESSION_SHAPE);
      expect((await f.getSession('bare'))!.ended_at).toBeNull();
      const full = session({
        id: 'full', status: 'done', wait_reason: 'w', wait_note: 'n', end_reason: 'completed', resume_id: 'r', ended_at: T0 + 5, dropped_at: T0 + 6,
        project_root: '/p', repo_name: 'repo', git_json: '{}', model: 'm', effort: 'high', context_tokens: 10, context_window: 200, context_percent: 5.5,
        cost_usd: 0.25, rate_limits_json: '{}', blowouts: 2, plan_json: '{}', reporter_version: '1.0.0', engine_version: '2.0.0', loop_json: '{}',
        files_json: '{}', background_json: '{}', usage_json: '[]', attached: 1, detached_at: T0 + 7, machine_json: '{}', cleared_from: 'bare', started_at: T0, last_seen_at: T0 + 4,
      });
      await f.upsertSession(full);
      expectShape('session (full)', (await f.getSession('full'))!, SESSION_SHAPE);
      expectShape('session (live candidates)', (await f.liveCandidates(0))[0]!, SESSION_SHAPE);

      const agent = (id: string, over: Partial<AgentRow> = {}): AgentRow => ({
        session_id: 'bare', id, parent_id: null, kind: 'sub', type: 'Explore', name: null, description: 'look', model: null, effort: null, effort_source: null,
        status: 'running', started_at: T0, ended_at: null, context_tokens: null, context_window: null, context_percent: null, tok_in: 1, tok_out: 2, tok_cr: 3, tok_cw: 4,
        cost_usd_est: null, skills_json: null, last_tool: null, tool_calls: 0, tool_counts_json: null, usage_json: null, blowouts: 0, steps_done: null, steps_total: null,
        prompt_excerpt: null, answer_excerpt: null, failure_json: null, ...over,
      });
      await f.upsertAgent(agent('a1'));
      await f.upsertAgent(agent('a2', { parent_id: 'a1', name: 'n', model: 'm', effort: 'low', effort_source: 'report', status: 'done', ended_at: T0 + 9, context_tokens: 1, context_window: 2, context_percent: 0.5, cost_usd_est: 0.1, skills_json: '[]', last_tool: 'Read', tool_calls: 3, tool_counts_json: '{}', usage_json: '[]', steps_done: 1, steps_total: 2, prompt_excerpt: 'p', answer_excerpt: 'a', failure_json: '{}' }));
      for (const a of await f.getAgents('bare')) expectShape(`agent ${a.id}`, a, AGENT_SHAPE);
      await f.upsertAgentTexts('bare', 'a2', { prompt: 'full prompt', answer: 'full answer' });
      expect((await f.getAgents('bare')).find((a) => a.id === 'a2')!.prompt_chars).toBe('full prompt'.length);

      await f.insertEvent({ id: 'e-null', session_id: 'bare', agent_id: null, t: T0, kind: 'k', text: 't', data_json: null });
      await f.insertEvent({ id: 'e-full', session_id: 'bare', agent_id: 'a1', t: T0 + 1, kind: 'k', text: 't', data_json: '{}' });
      for (const e of await f.listEvents({ sessionId: 'bare', limit: 10 })) expectShape(`event ${e.id}`, e, EVENT_SHAPE);
      expect(await f.countEvents('bare')).toBe(2);

      await f.insertBlowout({ session_id: 'bare', agent_id: null, t: T0, kind: 'clear', tokens_before: null, tokens_after: null });
      await f.insertBlowout({ session_id: 'bare', agent_id: 'a1', t: T0 + 1, kind: 'compact', tokens_before: 900, tokens_after: 100 });
      for (const b of await f.getBlowouts('bare')) expectShape(`blowout ${b.id}`, b, BLOWOUT_SHAPE);
      expect(await f.countBlowouts('bare')).toBe(2);

      await f.upsertSample({ session_id: 'bare', t: 1_800_000_000, tokens_total: 10, tokens_delta: 1, peak_context: 5, running_agents: 0, cost_usd: null });
      await f.upsertSample({ session_id: 'bare', t: 1_800_000_001, tokens_total: 20, tokens_delta: 10, peak_context: 6, running_agents: 2, cost_usd: 0.5, usage_json: '[]' });
      for (const x of await f.samplesSince('bare', 0)) expectShape(`sample ${x.t}`, x, SAMPLE_SHAPE);
      expectShape('latest sample', (await f.latestSample('bare'))!, SAMPLE_SHAPE);
      expectShape('sample before', (await f.sampleBefore('bare', 1_800_000_001))!, SAMPLE_SHAPE);
      await store.close();
    });

    it('returns people, groups and the Admin log with the types the interfaces declare', async () => {
      const store = await open();
      const p = store.people;
      const group = await p.createGroup('Crew', T0);
      expect(Object.keys(group).sort(byText)).toEqual(['id', 'name']);
      expectShape('group', { id: group.id, name: group.name } as GroupListRow & object, { id: 'int', name: 'text' } as unknown as Shape<GroupListRow>);
      const { person } = await p.createPerson('Ed', group.id, T0);
      await p.createPerson('Una', null, T0);
      expectShape('person (created)', person, PERSON_SHAPE);
      expectShape('person (read)', (await p.getPerson(person.id))!, PERSON_SHAPE);
      expectShape('person (by name)', (await p.findByName('ed'))!, PERSON_SHAPE);
      await p.touch(person.id, '127.0.0.1', T0 + 1, { name: 'box', id: 'abcd1234' });
      await p.rotate(person.id, T0 + 2);
      const listed = await p.list({});
      expect(listed.rows.map((r) => r.name)).toEqual(['Ed', 'Una']);
      for (const r of listed.rows) expectShape(`person ${r.name} (listed)`, r, PERSON_LIST_SHAPE);
      expect(listed.rows[0]!.machines).toEqual(['box (abcd)']);
      for (const k of ['total', 'page', 'pageSize'] as const) expect(typeof listed[k], `list.${k}`).toBe('number');
      await p.revoke((await p.findByName('Una'))!.id, T0 + 3);
      expectShape('person (revoked)', (await p.findByName('Una'))!, PERSON_SHAPE);
      expect(typeof (await p.findByName('Una'))!.revokedAt).toBe('number');
      for (const g of (await p.listGroups({})).rows) expectShape(`group ${g.name} (listed)`, g, GROUP_LIST_SHAPE);
      expect(typeof (await p.allGroups())[0]!.builtIn).toBe('boolean');
      expect(typeof (await p.isAdministrator(person.id))).toBe('boolean');
      await p.log('kind', 'detail', 'src', T0, null);
      await p.log('kind', 'detail', 'src', T0, 'me');
      for (const l of (await p.listLog({})).rows) expectShape(`log ${l.id}`, l, { id: 'int', t: 'int', kind: 'text', detail: 'text', source: 'text', actor: 'text?' });
      await store.close();
    });

    it('returns reporter rows with the types the interfaces declare', async () => {
      const store = await open();
      await store.fleet.upsertSession(session({ id: 's-m1', owner: 'ed' }));
      const key = await store.reporters.record(mkSeen('m1', 'box'), T0);
      await store.reporters.record(mkSeen('m2', null, { kind: 'hooks', source: '127.0.0.2', credential: null, os: null, peers: null }), T0 + 1);
      const { rows, ...rest } = await store.reporters.list({}, T0 + 2);
      expect(rows.map((r) => r.key).sort(byText)).toEqual([key, 'm2'].sort(byText));
      for (const r of rows) expectShape(`reporter ${r.key}`, r, REPORTER_SHAPE);
      for (const k of ['total', 'page', 'pageSize', 'serverStartedAt', 'adminSecret'] as const) expect(typeof rest[k], `list.${k}`).toBe('number');
      const detail = (await store.reporters.get(key, T0 + 2))!;
      expectShape('reporter detail (as a row)', Object.fromEntries(Object.entries(detail).filter(([k]) => k in REPORTER_SHAPE)) as ReporterRow, REPORTER_SHAPE);
      for (const k of ['serverStartedAt', 'recentTotal', 'recentPage', 'recentPageSize'] as const) expect(typeof detail[k], `detail.${k}`).toBe('number');
      expect(typeof detail.recent[0]!.lastSeenAt).toBe('number');
      await store.close();
    });

    it('keeps people names unique whatever their case or spacing', async () => {
      const store = await open();
      const p = store.people;
      const { person } = await p.createPerson('Ed', null, T0);
      for (const again of ['ed', ' ED ', 'eD']) {
        expect(nameKey(again), again).toBe(nameKey('Ed'));
        await expect(p.createPerson(again, null, T0), again).rejects.toMatchObject({ code: 'duplicate' });
        await expect(p.createPerson(again, null, T0), again).rejects.toBeInstanceOf(PeopleError);
      }
      await p.createPerson('Ed  Two', null, T0);
      await expect(p.createPerson(' ed two', null, T0)).rejects.toMatchObject({ code: 'duplicate' });
      expect((await p.findByName('ED'))!.id).toBe(person.id);
      expect((await p.findByName('  eD '))!.id).toBe(person.id);
      expect((await p.findByName('Ed Two'))!.name).toBe('Ed Two');
      expect((await p.list({})).total).toBe(2);
      await store.close();
    });

    it('returns lists in the order the app relies on, ties included', async () => {
      const store = await open();
      const { fleet: f, people: p } = store;
      // Events: newest first; equal times by id, descending, as the bytes of the id compare (so 'b' > 'a' > 'B').
      for (const [id, t] of [['b', 100], ['B', 100], ['a', 100], ['c', 200], ['z', 50]] as const) await f.insertEvent({ id, session_id: 's1', agent_id: null, t, kind: 'k', text: id, data_json: null });
      expect((await f.listEvents({ sessionId: 's1', limit: 10 })).map((e) => e.id)).toEqual(['c', 'b', 'a', 'B', 'z']);
      expect((await f.listEvents({ sessionId: 's1', before: 100, limit: 10 })).map((e) => e.id)).toEqual(['z']);
      expect((await f.listEvents({ sessionId: 's1', limit: 2 })).map((e) => e.id)).toEqual(['c', 'b']);
      expect((await f.listEvents({ limit: 10 })).map((e) => e.id)).toEqual(['c', 'b', 'a', 'B', 'z']);
      // Agents: by start, then by id as bytes.
      await f.upsertSession(session({ id: 's1' }));
      const agent = (id: string, started: number): AgentRow => ({
        session_id: 's1', id, parent_id: null, kind: 'sub', type: 'Explore', name: null, description: '', model: null, effort: null, effort_source: null, status: 'done',
        started_at: started, ended_at: null, context_tokens: null, context_window: null, context_percent: null, tok_in: 0, tok_out: 0, tok_cr: 0, tok_cw: 0, cost_usd_est: null,
        skills_json: null, last_tool: null, tool_calls: 0, tool_counts_json: null, usage_json: null, blowouts: 0, steps_done: null, steps_total: null, prompt_excerpt: null,
        answer_excerpt: null, failure_json: null,
      });
      for (const [id, at] of [['b', 20], ['a', 20], ['A', 20], ['z', 10], ['y', 30]] as const) await f.upsertAgent(agent(id, at));
      expect((await f.getAgents('s1')).map((a) => a.id)).toEqual(['z', 'A', 'a', 'b', 'y']);
      // Samples and blowouts: by time. Blowouts with the same time come back in the order they were stored.
      for (const t of [30, 10, 20]) await f.upsertSample({ session_id: 's1', t, tokens_total: t, tokens_delta: 1, peak_context: 0, running_agents: 0, cost_usd: null });
      expect((await f.samplesSince('s1', 0)).map((x) => x.t)).toEqual([10, 20, 30]);
      expect((await f.samplesSince('s1', 20)).map((x) => x.t)).toEqual([20, 30]);
      expect((await f.latestSample('s1'))!.t).toBe(30);
      expect((await f.sampleBefore('s1', 30))!.t).toBe(20);
      for (const t of [300, 100, 200]) await f.insertBlowout({ session_id: 's1', agent_id: null, t, kind: 'compact', tokens_before: null, tokens_after: null });
      expect((await f.getBlowouts('s1')).map((b) => b.t)).toEqual([100, 200, 300]);
      for (const kind of ['tie-b', 'tie-a']) await f.insertBlowout({ session_id: 's1', agent_id: null, t: 150, kind, tokens_before: null, tokens_after: null });
      expect((await f.getBlowouts('s1')).filter((b) => b.t === 150).map((b) => b.kind)).toEqual(['tie-b', 'tie-a']);
      // Sessions: the live set and an ended range come back by start time.
      for (const [id, started] of [['s3', 3000], ['s2', 2000], ['s4', 4000]] as const) await f.upsertSession(session({ id, started_at: started, ended_at: started + 1, last_seen_at: started + 1 }));
      expect((await f.liveCandidates(0)).map((r) => r.id)).toEqual(['s1', 's2', 's3', 's4']);
      expect((await f.endedBetween(0, 10_000)).map((r) => r.id)).toEqual(['s2', 's3', 's4']);
      // The same start time: by id, as bytes.
      for (const id of ['t-b', 't-B', 't-a']) await f.upsertSession(session({ id, started_at: 5000, ended_at: 5001, last_seen_at: 5001 }));
      expect((await f.liveCandidates(4999)).map((r) => r.id)).toEqual(['s1', 't-B', 't-a', 't-b']);
      expect((await f.endedBetween(5000, 5002)).map((r) => r.id)).toEqual(['t-B', 't-a', 't-b']);

      // People and groups: by name, ignoring case.
      for (const n of ['bob', 'Alice', 'Carol', 'alice-2']) await p.createPerson(n, null, T0);
      expect((await p.list({})).rows.map((r) => r.name)).toEqual(['Alice', 'alice-2', 'bob', 'Carol']);
      for (const n of ['crew', 'Beta', 'alpha']) await p.createGroup(n, T0);
      expect((await p.allGroups()).map((g) => g.name)).toEqual(['Administrators', 'alpha', 'Beta', 'crew']);
      expect((await p.listGroups({})).rows.map((g) => g.name)).toEqual(['Administrators', 'alpha', 'Beta', 'crew']);
      // The Admin log: newest first, and rows written in the same millisecond newest-written first.
      for (const d of ['first', 'second', 'third']) await p.log('k', d, 's', T0);
      expect((await p.listLog({})).rows.map((l) => l.detail)).toEqual(['third', 'second', 'first']);

      // Reporters: by machine name ignoring case, then key; a reporter without a name sorts by its key.
      for (const [id, name] of [['m-c', 'Charlie'], ['m-a', 'alpha'], ['m-b', 'Bravo'], ['m-2', 'bravo']] as const) await store.reporters.record(mkSeen(id, name), T0);
      const owned = await store.reporters.peerLookup().ofOwner('ED');
      expect(owned.map((r) => r.key)).toEqual(['m-a', 'm-2', 'm-b', 'm-c']);
      expect((await store.reporters.list({ sort: 'name', dir: 1 }, T0)).rows.map((r) => r.key)).toEqual(['m-a', 'm-2', 'm-b', 'm-c']);
      // One rule for text (#822): bytes compare as they are, and a case-insensitive key folds ASCII letters only. So `zed` sorts before
      // `Émile`, which sorts before `émile`, whatever the database's locale.
      for (const [id, name] of [['m-e1', 'émile'], ['m-e2', 'Émile'], ['m-z', 'zed']] as const) await store.reporters.record(mkSeen(id, name), T0);
      expect((await store.reporters.list({ sort: 'name', dir: 1 }, T0)).rows.map((r) => r.key).slice(4)).toEqual(['m-z', 'm-e2', 'm-e1']);
      await store.close();
    });

    it('returns a person\'s certificates newest first, those issued in the same millisecond last-stored first', async () => {
      const store = await open();
      const { person } = await store.people.createPerson('cert-owner', null, T0);
      const cert = (n: number) => ({
        cert: `PEM${n}`, issuerFingerprint: n % 2 ? 'ca-a' : 'ca-b',
        info: { fingerprintSha256: `fp${n}`, serial: `0${n}`, notBefore: new Date(T0).toISOString(), notAfter: new Date(T0 + 86_400_000).toISOString() },
      }) as unknown as Parameters<Storage['personCerts']['add']>[1];
      for (const n of [1, 2]) await store.personCerts.add(person.id, cert(n), T0);
      await store.personCerts.add(person.id, cert(3), T0 - 1);
      expect((await store.personCerts.listFor(person.id)).map((c) => c.fingerprint)).toEqual(['fp2', 'fp1', 'fp3']);
      expect((await store.personCerts.current(person.id))!.fingerprint).toBe('fp2');
      const by = await store.personCerts.reportersByIssuer(T0 - 5);
      expect(by).toEqual({ total: 1, byIssuer: { 'ca-a': 1 } });
      await store.close();
    });

    it('returns the messages of a conversation in the order they were sent, ties included', async () => {
      const store = await open();
      let now = T0;
      const peers = store.peers({ now: () => now, flagOn: () => true, startedAt: T0 });
      const a = await store.reporters.record(mkSeen('a', 'box-a', { sessionId: 'sa' }), T0);
      const b = await store.reporters.record(mkSeen('b', 'box-b', { sessionId: 'sb' }), T0);
      await store.fleet.upsertSession(session({ id: 'sa', owner: 'ed' }));
      await store.fleet.upsertSession(session({ id: 'sb', owner: 'ed' }));
      const waiting = (name: string, machine: string): Report =>
        ({ session: { name, status: 'waiting', waitReason: 'input', peers: true, repoName: null, projectRoot: '~/dev' }, machine: { name: machine, os: 'macOS' } }) as unknown as Report;
      await peers.note('sa', a, 'ed', waiting('alpha', 'box-a'));
      await peers.note('sb', b, 'ed', waiting('beta', 'box-b'));
      const ed = { name: 'ed', admin: false };
      await peers.rights.setRight('ed', a, b, 'send', ed);
      await peers.rights.setRight('ed', b, a, 'send', ed);
      // the first two are sent in the same millisecond, one each way; the last a moment later
      for (const [from, to, text] of [['sa', 'beta@box-b', 'one'], ['sb', 'alpha@box-a', 'two']] as const) {
        const out = await peers.messages.send(from, to, text);
        expect(out.ok, text).toBe(true);
      }
      now += 5;
      expect((await peers.messages.send('sa', 'beta@box-b', 'three')).ok).toBe(true);
      const thread = await peers.messages.conversation('sb', 'sa');
      expect(thread.map((m) => m.text)).toEqual(['one', 'two', 'three']);
      expect((await peers.messages.conversation('sa', 'sb')).map((m) => m.text)).toEqual(['one', 'two', 'three']);
      expect(thread.map((m) => m.sentAt)).toEqual([T0, T0, T0 + 5]);
      for (const m of thread) expectShape(`message ${m.text}`, m, MESSAGE_SHAPE);
      const [summary] = await peers.messages.conversations({});
      expect(typeof summary!.messages).toBe('number');
      expect(typeof summary!.lastAt).toBe('number');
      expect(typeof summary!.paused).toBe('boolean');
      expect(summary!.messages).toBe(3);
      await store.close();
    });

    it('returns recordings and the Activity history with the types and order the interfaces declare', async () => {
      const store = await open();
      const memory = { now: T0, live: new Set(['B1', 'a1', 'c1']) };
      const act = store.activity({
        history: {
          now: () => memory.now, settings: () => ({ ...ACTIVITY_HISTORY_DEFAULTS, policy: 'all' }), isLive: (id) => memory.live.has(id), agentsOf: async () => [], authOn: true,
        },
        recordings: {
          now: () => memory.now, settings: () => ({ ...RECORDING_DEFAULTS }), flagOn: () => true, authOn: true, isLive: (id) => memory.live.has(id),
          loopsOf: async () => [{ loop: MAIN_LOOP, name: 'Orchestrator' }],
        },
      });
      const batch = (n: number): RecordingBatch => ({ v: 1, sentAt: T0, entries: [{ loop: MAIN_LOOP, seq: n, at: T0 + n, kind: 'tool', text: `text ${n}` }] });
      // Recordings: ids that differ in case, all started and last written at the same moment.
      for (const [id, owner] of [['a1', 'Ed'], ['B1', 'ann'], ['c1', null]] as const) {
        act.recordings.noteOption(id, true);
        expect(await act.recordings.start(id, [MAIN_LOOP], 'Ed', { name: `name ${id}`, project: owner === null ? null : 'acme/billing', owner }), id).toBe('ok');
        expect(await act.recordings.ingest(id, batch(1), { name: `name ${id}`, project: owner === null ? null : 'acme/billing', owner })).toBe(1);
      }
      const listed = await act.recordings.adminList({ page: 1, pageSize: 10 });
      expect(listed.rows.map((r) => r.sessionId)).toEqual(['B1', 'a1', 'c1']);
      for (const r of listed.rows) expectShape(`recording ${r.sessionId}`, r, RECORDING_SHAPE);
      for (const k of ['recordings', 'bytes', 'running'] as const) expect(typeof listed.totals[k], `totals.${k}`).toBe('number');
      const stored = await act.recordings.listStored({}, 1, 10);
      expect(stored.rows.map((r) => r.sessionId)).toEqual(['B1', 'a1', 'c1']);
      for (const r of stored.rows) expectShape(`stored recording ${r.sessionId}`, r, STORED_SHAPE);
      expect(await act.recordings.stateFor('a1')).toBe('recording');

      // Activity history: sessions with the same last entry time come back by id as bytes; the filter's choices likewise.
      const tool = (at: number): ActivityEntry => ({ at, kind: 'tool', text: `Read f${at}` });
      const report = (id: string): Report => {
        const r = fixtureReport();
        r.session.activityFeed = true;
        r.session.id = id;
        r.session.activity = [tool(T0)];
        r.agents[0]!.activity = [];
        return r;
      };
      await act.history.ingest(report('s-b'), 0, { name: 'n', project: 'Zeta', owner: 'ann' });
      await act.history.ingest(report('s-B'), 0, { name: 'n', project: 'alpha', owner: 'Bob' });
      await act.history.ingest(report('s-a'), 0, { name: 'n', project: null, owner: null });
      const hist = await act.history.list({}, 1, 10);
      expect(hist.rows.map((r) => r.sessionId)).toEqual(['s-B', 's-a', 's-b']);
      for (const r of hist.rows) expectShape(`stored session ${r.sessionId}`, r, STORED_SHAPE);
      expect(hist.owners).toEqual(['Bob', 'ann']);
      expect(hist.projects).toEqual(['Zeta', 'alpha']);
      for (const k of ['total', 'page', 'pageSize'] as const) expect(typeof hist[k], `list.${k}`).toBe('number');
      for (const k of ['entries', 'sessions', 'bytes', 'fileBytes'] as const) expect(typeof hist.totals[k], `totals.${k}`).toBe('number');
      await store.close();
    });
  });
}
