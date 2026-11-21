// The contract case for a database that already holds data when it is upgraded (#892). The cases in contract.ts open a fresh database, so no
// migration ever runs on rows that exist. Here an adapter builds a database at the schema before a row-rewriting migration, loads the same rows,
// and opens it as a Storage (which migrates it); what comes back through the interface is written out below and must be the same in every adapter.
import { it, expect } from 'vitest';
import type { Actor } from '../fleet/peerTypes.js';
import type { Storage } from './types.js';

/** A peer request as an older database stores it, before it had an insertion number. */
export interface LegacyRequest {
  id: string;
  owner: string;
  kind: 'proposal' | 'access';
  fromKey: string;
  toKey: string;
  level: 'see' | 'send';
  reason: string | null;
  by: string;
  fromSession: string | null;
  createdAt: number;
  closedAt: number | null;
  outcome: string | null;
}

/** A reporter as an older database stores it, before a row named the reporter that sent it (#849). */
export interface LegacyReporter {
  key: string;
  kind: 'mod' | 'hooks';
  machineId: string | null;
  machineName: string | null;
  owner: string | null;
  version: string;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Sessions this reporter already carries a link to. */
  sessionIds?: string[];
  /** Set to store the row as a database holds it after a row named its owner and before it was bound to the owner's id (#1284); `person` is a person of that name the older database holds too (made once, however many rows name it), so the upgrade can match it. */
  bound?: { person?: string };
}

/** A right between a person and another person's agent as an older database stores it, before it kept who paused it (#1034). */
export interface LegacyRight {
  fromKey: string;
  toKey: string;
  owner: string;
  level: 'send' | 'none';
  paused: boolean;
}

/** An Admin's read record as an older database stores it, before a record had a kind (#1034). */
export interface LegacyAdminRead {
  thread: string;
  adminKey: string;
  admin: string;
  startedAt: number;
  lastSeenAt: number;
  /** Set when the record was made after it was kept who it is owed to (#1051) and before `chat_admin_owed` (#1061): the two lists, as the record kept them. */
  lists?: { kind: string; people: string[]; seen: string[] };
}

/** A session as an older database stores it, before a session named its harness (#851). */
export interface LegacySession {
  id: string;
  name: string;
  model: string | null;
  costUsd: number | null;
  startedAt: number;
  /** The id of an agent the session had, stored before an agent had a model label (#945). */
  agent?: string;
  /** The owner's name the row holds, with `bound`: the row as a database holds it after a row named its owner and before it was bound to the owner's id (#1284). `person` is a person of that name the older database holds too, so the upgrade can match it. */
  owner?: string | null;
  bound?: { person?: string };
}

/** A peer message as an older database stores it, before a row said who wrote it (#1034). */
export interface LegacyMessage {
  id: string;
  owner: string;
  fromSession: string;
  toSession: string;
  text: string;
  sentAt: number;
  /** The insertion number the older schema already had. */
  seq: number;
  /**
   * Set to store the row as a database holds it after a row said who wrote it (#1034) and before it kept its author's id (#1269): who wrote it, under what name, in what state, and (once, however many rows name it)
   * the person of that name the older database holds, so the upgrade can give the row that person's id. Without it the row is an agent's, `delivered`, from `alpha`, as before.
   */
  written?: { author: 'agent' | 'person'; fromName: string; state: string; person?: string };
}

/** A public message as an older database stores it, before a message was kept in a channel (#1035): in General's table, with its insertion number. */
export interface LegacyPublicMessage {
  id: string;
  authorKind: string;
  authorRef: string;
  authorName: string;
  text: string;
  createdAt: number;
  mentionsJson: string;
  seq: number;
  /** Set to put the row in the group channel's table (`group_messages`) of this owner and group instead of General's, as the same older database holds both. */
  group?: { owner: string; groupId: string };
  /** Set to have a person of this name in the older database too (made once, however many rows name it), so the upgrade can give the rows that person's id. */
  person?: string;
}

/** A daily row as an older database stores it, before the row was bound to its owner's id (#1284): named by the owner's name only. `person` is a person of that name the older database holds too (made once, however many rows name it), so the upgrade can match it. */
export interface LegacyDaily {
  table: 'usage_daily' | 'failures_daily' | 'person_sessions_daily' | 'skills_daily' | 'person_places_daily';
  day: string;
  owner: string;
  group: string;
  person?: string;
}

/** The statement and values that write a `LegacyDaily` at the schema before it had an owner id: every other column is filled with one fixed value. */
export function legacyDailyInsert(r: LegacyDaily): { sql: string; args: (string | number)[] } {
  switch (r.table) {
    case 'usage_daily':
      return { sql: 'INSERT INTO usage_daily (day, owner, group_name, model, project, sessions, agents, cost_usd, unpriced_sessions, tok_in, tok_out, tok_cr, tok_cw) VALUES (?, ?, ?, \'m\', \'p\', 1, 0, 2, 0, 0, 0, 0, 0)', args: [r.day, r.owner, r.group] };
    case 'failures_daily':
      return { sql: 'INSERT INTO failures_daily (day, owner, class, tool, count) VALUES (?, ?, \'c\', \'t\', 1)', args: [r.day, r.owner] };
    case 'person_sessions_daily':
      return { sql: 'INSERT INTO person_sessions_daily (day, owner, group_name, harness, sessions) VALUES (?, ?, ?, \'h\', 1)', args: [r.day, r.owner, r.group] };
    case 'skills_daily':
      return { sql: 'INSERT INTO skills_daily (day, owner, harness, skill, sessions) VALUES (?, ?, \'h\', \'s\', 1)', args: [r.day, r.owner] };
    case 'person_places_daily':
      return { sql: 'INSERT INTO person_places_daily (day, owner, group_name, harness, project, branch, sessions) VALUES (?, ?, ?, \'h\', \'p\', \'b\', 1)', args: [r.day, r.owner, r.group] };
  }
}

/** What an adapter provides: a Storage over a database built at the schema before the request insertion number, the reporter name and the session harness, holding `rows`, `reporters` and `sessions` inserted in the order given. */
export interface UpgradeOpeners {
  openUpgraded(rows: LegacyRequest[], reporters?: LegacyReporter[], sessions?: LegacySession[], messages?: LegacyMessage[], rights?: LegacyRight[], adminReads?: LegacyAdminRead[], publicMessages?: LegacyPublicMessage[], daily?: LegacyDaily[]): Promise<Storage>;
}

const T0 = 1_800_000_000_000;
const ED: Actor = { name: 'ed', admin: false };

const req = (id: string, createdAt: number, over: Partial<LegacyRequest> = {}): LegacyRequest => ({
  id, owner: 'ed', kind: 'access', fromKey: 'k1', toKey: 'k2', level: 'see', reason: `why-${id}`, by: 'alpha', fromSession: 's1', createdAt, closedAt: null, outcome: null, ...over,
});

// Inserted out of time order. `prq_a` and `prq_c` share a time and are inserted out of id order (`prq_c` first). Rows made before
// the insertion number have no true insertion order in every adapter, so each numbers such a tie by id (#916).
const FIXTURE: LegacyRequest[] = [
  req('prq_c', T0 + 5000),
  req('prq_a', T0 + 5000),
  req('prq_b', T0 + 4000, { fromSession: null }),
  req('prq_z', T0 + 1000, { owner: 'eve' }),
  req('prq_done', T0 + 3000, { closedAt: T0 + 9000, outcome: 'declined' }),
  req('prq_prop', T0 + 6000, { kind: 'proposal', level: 'send', reason: null, by: 'Admin' }),
];

export function upgradeCases(o: UpgradeOpeners): void {
  it('keeps every session and its cost as a Claude Code session with Podium\'s own estimate when a database made before sessions had a harness is upgraded (#851)', async () => {
    const legacy: LegacySession[] = [
      { id: 'old1', name: 'first', model: 'claude-opus-4-5', costUsd: 1.5, startedAt: T0, agent: 'old-agent' },
      { id: 'old2', name: 'second', model: null, costUsd: null, startedAt: T0 + 1 },
    ];
    const s = await o.openUpgraded([], [], legacy);
    try {
      const a = (await s.fleet.getSession('old1'))!;
      expect(a).toMatchObject({ name: 'first', model: 'claude-opus-4-5', cost_usd: 1.5, started_at: T0, harness: 'claude-code', cost_source: null });
      expect(await s.fleet.getSession('old2')).toMatchObject({ cost_usd: null, harness: 'claude-code', cost_source: null });
      // Nothing was declared before the columns existed (#940), so both read as not declared.
      for (const id of ['old1', 'old2']) expect(await s.fleet.getSession(id)).toMatchObject({ capabilities_json: null, model_label: null, model_provider: null });
      // Nor had a session a resume window (#1113), so one stored before reads as unknown: its chat follows the grace period, and a later report sets it.
      for (const id of ['old1', 'old2']) expect(await s.fleet.getSession(id)).toMatchObject({ resume_window_days: null });
      await s.fleet.upsertSession({ ...(await s.fleet.getSession('old1'))!, resume_window_days: 14 });
      expect(await s.fleet.getSession('old1')).toMatchObject({ resume_window_days: 14 });
      // Nor did an agent have a label or provider (#945), so one stored before reads as not declared, and a later write sets them.
      expect(await s.fleet.getAgents('old1')).toMatchObject([{ id: 'old-agent', model_label: null, model_provider: null }]);
    } finally {
      await s.close();
    }
  });

  it('keeps every reporter, its key and its values as a Claude Code reporter when a database made before reporters had a name is upgraded (#849)', async () => {
    const legacy: LegacyReporter[] = [
      { key: 'ma', kind: 'mod', machineId: 'ma', machineName: 'box-a', owner: 'ed', version: '1.2.0', firstSeenAt: T0, lastSeenAt: T0 + 10 },
      { key: 'ma#eve', kind: 'mod', machineId: 'ma', machineName: 'box-a', owner: 'eve', version: '1.3.0', firstSeenAt: T0 + 1, lastSeenAt: T0 + 20 },
      { key: 'hooks:10.0.0.9', kind: 'hooks', machineId: null, machineName: null, owner: null, version: 'hooks', firstSeenAt: T0 + 2, lastSeenAt: T0 + 30 },
    ];
    const s = await o.openUpgraded([], legacy);
    try {
      const { rows } = await s.reporters.list({ sort: 'last', dir: 1 }, T0 + 40);
      expect(rows.map((r) => [r.key, r.reporterName, r.version, r.firstSeenAt, r.lastSeenAt, r.who])).toEqual([
        ['ma', 'podium-reporter-claudecode', '1.2.0', T0, T0 + 10, 'ed'],
        ['ma#eve', 'podium-reporter-claudecode', '1.3.0', T0 + 1, T0 + 20, 'eve'],
        ['hooks:10.0.0.9', 'podium-reporter-claudecode', 'hooks', T0 + 2, T0 + 30, 'Unassigned'],
      ]);
      // A report from the same machine by the same reporter lands on the row it already had; another reporter gets a row of its own.
      const same = await s.reporters.record({ kind: 'mod', machineId: 'ma', machineName: 'box-a', source: '127.0.0.1', owner: 'ed', credential: 'person', version: '1.4.0', engineVersion: null, sessionId: 'x1' }, T0 + 50);
      expect(same).toBe('ma');
      // The Claude Code reporter's new wire name lands on the same row as the legacy one, with the same key (#967).
      const renamed = await s.reporters.record({ kind: 'mod', reporterName: 'podium-reporter-claudecode', machineId: 'ma', machineName: 'box-a', source: '127.0.0.1', owner: 'ed', credential: 'person', version: '1.4.0', engineVersion: null, sessionId: 'x3' }, T0 + 52);
      expect(renamed).toBe('ma');
      const other = await s.reporters.record({ kind: 'mod', reporterName: 'podium-reporter-opencode', machineId: 'ma', machineName: 'box-a', source: '127.0.0.1', owner: 'ed', credential: 'person', version: '2.0.0', engineVersion: null, sessionId: 'x2' }, T0 + 51);
      expect(other).toBe('ma@podium-reporter-opencode');
      expect((await s.reporters.list({}, T0 + 60)).rows).toHaveLength(4);
    } finally {
      await s.close();
    }
  });

  it('finds the row that already holds a session by its key prefix in the same way whatever the case, on every adapter (#943)', async () => {
    // The oldest row of each pair has the prefix in another case (and `hooksX…` is not the prefix at all). A byte comparison skips them; a case-folding LIKE would pick the first.
    const row = (key: string, kind: 'mod' | 'hooks', at: number): LegacyReporter => ({ key, kind, machineId: null, machineName: null, owner: null, version: '1.0.0', firstSeenAt: at, lastSeenAt: at, sessionIds: ['sx'] });
    const s = await o.openUpgraded([], [
      row('hooksX10.0.0.5', 'hooks', T0 - 1), row('HOOKS:10.0.0.9', 'hooks', T0), row('hooks:10.0.0.9', 'hooks', T0 + 1),
      row('Addr:10.0.0.8', 'mod', T0 + 2), row('addr:10.0.0.8', 'mod', T0 + 3),
    ]);
    try {
      const keys = (kind: 'mod' | 'hooks') => s.reporters.keysFor({ kind, machineId: null, source: '192.0.2.77', sessionId: 'sx', owner: null });
      expect(await keys('hooks')).toEqual(['hooks:192.0.2.77', 'hooks:10.0.0.9']);
      expect(await keys('mod')).toEqual(['addr:192.0.2.77', 'addr:10.0.0.8']);
    } finally {
      await s.close();
    }
  });

  it('keeps every peer request, its values and its order when a database made before their insertion number is upgraded', async () => {
    const s = await o.openUpgraded(FIXTURE);
    try {
      const open = await s.peers({ now: () => T0 + 10_000, flagOn: () => true, startedAt: T0 }).rights.openRequests('ed');
      expect(open.map((r) => r.id)).toEqual(['prq_b', 'prq_a', 'prq_c', 'prq_prop']);
      expect(open.find((r) => r.id === 'prq_b')).toEqual({
        id: 'prq_b', owner: 'ed', kind: 'access', fromKey: 'k1', toKey: 'k2', level: 'see', reason: 'why-prq_b', by: 'alpha', fromSession: null,
        messageId: null, createdAt: T0 + 4000, closedAt: null, outcome: null,
      });
      expect(open.find((r) => r.id === 'prq_prop')).toMatchObject({ kind: 'proposal', level: 'send', reason: null, by: 'Admin', createdAt: T0 + 6000 });
      expect((await s.peers({ now: () => T0, flagOn: () => true, startedAt: T0 }).rights.openRequests('eve')).map((r) => r.id)).toEqual(['prq_z']);
    } finally {
      await s.close();
    }
  });

  it('numbers a request made after the upgrade after every request already there', async () => {
    const s = await o.openUpgraded(FIXTURE);
    try {
      const peers = s.peers({ now: () => T0 + 5000, flagOn: () => true, startedAt: T0 });
      const a = await s.reporters.record({ kind: 'mod', machineId: 'ma', machineName: 'box-a', source: '127.0.0.1', owner: 'ed', credential: 'person', version: '1.2.0', engineVersion: null, sessionId: 'sa', os: 'macOS', peers: true }, T0);
      const b = await s.reporters.record({ kind: 'mod', machineId: 'mb', machineName: 'box-b', source: '127.0.0.1', owner: 'ed', credential: 'person', version: '1.2.0', engineVersion: null, sessionId: 'sb', os: 'macOS', peers: true }, T0);
      const made = await peers.rights.propose(a, b, 'see', ED);
      expect(made).toMatchObject({ ok: true });
      // The same time as prq_a and prq_c: only the number the migration left decides that the new one comes last.
      const ids = (await peers.rights.openRequests('ed')).map((r) => r.id);
      expect(ids.slice(0, 3)).toEqual(['prq_b', 'prq_a', 'prq_c']);
      expect(ids).toHaveLength(5);
      expect(ids[3]).toBe((made as { request: { id: string } }).request.id);
    } finally {
      await s.close();
    }
  });

  it('keeps every peer message and its order, as one an agent wrote and none hidden, when a database made before a message had an author is upgraded (#1034)', async () => {
    const msg = (id: string, from: string, to: string, text: string, sentAt: number, seq: number, owner = 'ed'): LegacyMessage => ({ id, owner, fromSession: from, toSession: to, text, sentAt, seq });
    // Inserted out of time order, and two share a moment: the insertion number the old schema had still decides.
    const s = await o.openUpgraded([], [], [], [
      msg('dlv_3', 's2', 's1', 'three', T0 + 9, 3),
      msg('dlv_1', 's1', 's2', 'one', T0 + 1, 1),
      msg('dlv_2', 's2', 's1', 'two', T0 + 1, 2),
      msg('dlv_x', 's3', 's4', 'someone else', T0, 4, 'eve'),
    ]);
    try {
      const peers = s.peers({ now: () => T0 + 20, flagOn: () => true, startedAt: T0 });
      const thread = await peers.messages.conversation('s1', 's2');
      expect(thread.map((m) => [m.text, m.author])).toEqual([['one', 'agent'], ['two', 'agent'], ['three', 'agent']]);
      const page = await peers.messages.page('ed', 's1', 's2', { limit: 2 });
      expect(page.messages.map((m) => m.text)).toEqual(['two', 'three']);
      expect((await peers.messages.page('ed', 's1', 's2', { before: page.older, limit: 2 })).messages.map((m) => m.text)).toEqual(['one']);
      expect(await peers.messages.page('ed', 's3', 's4', { limit: 5 })).toEqual({ messages: [], older: null });
      const mine = await peers.messages.ownerConversations('ed');
      expect(mine.map((c) => [c.messages, c.hiddenAt])).toEqual([[3, null]]);
      expect(await peers.messages.purgeHidden(T0 + 1e9, 0)).toBe(0);
      expect(await peers.messages.deleteConversation('ed', 's1', 's2')).toBe(3);
      expect(await peers.messages.conversation('s3', 's4')).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it('keeps a paused link between a person and another person\'s agent paused, with no pauser known, so either owner may resume it, when a database made before a link kept its pauser is upgraded (#1034)', async () => {
    const reporter: LegacyReporter = { key: 'rk-a', kind: 'mod', machineId: 'ma', machineName: 'box-a', owner: 'ed', version: '1.0.0', firstSeenAt: T0, lastSeenAt: T0, sessionIds: ['sa'] };
    const right = (paused: boolean): LegacyRight => ({ fromKey: 'person:eve', toKey: 'rk-a', owner: 'ed', level: 'send', paused });
    const s = await o.openUpgraded([], [reporter], [], [], [right(true), { ...right(false), fromKey: 'person:zoe' }]);
    try {
      const peers = s.peers({ now: () => T0 + 20, flagOn: () => true, startedAt: T0 });
      const paused = await peers.rights.personLink('person:eve', 'rk-a');
      expect(paused).toMatchObject({ level: 'send', paused: true });
      expect(paused).not.toHaveProperty('pausedBy');
      expect(await peers.rights.personLink('person:zoe', 'rk-a')).toMatchObject({ level: 'send', paused: false });
      // A pause made now keeps its pauser; a resume clears it.
      expect(await peers.setPersonLink('person:zoe', 'rk-a', 'pause', ED, 'owner')).toMatchObject({ ok: true, right: { paused: true, pausedBy: 'owner' } });
      expect(await peers.setPersonLink('person:eve', 'rk-a', 'resume', ED)).toMatchObject({ ok: true, right: { paused: false } });
      expect(await peers.rights.personLink('person:zoe', 'rk-a')).toMatchObject({ paused: true, pausedBy: 'owner' });
    } finally {
      await s.close();
    }
  });
  it('takes a record of a read of a person\'s session beside the records an older database holds, owed to the person and kept apart by thread, when the database is upgraded (#1073, #1074)', async () => {
    const MIN = 60_000;
    const old: LegacyAdminRead = { thread: 'group:ed', adminKey: 'root', admin: 'Root', startedAt: T0 - MIN, lastSeenAt: T0 - MIN };
    const s = await o.openUpgraded([], [], [], [], [], [old]);
    try {
      const reads = s.chat({ now: () => T0 + MIN }).adminReads;
      expect(await reads.touch('ask:sa', 'Root', 30 * MIN, ['ed'])).toMatchObject({ started: true, record: { startedAt: T0 + MIN, kind: 'read' } });
      expect(await reads.touch('activity:sa:a1', 'Root', 30 * MIN, ['ed'])).toMatchObject({ started: true });
      expect(await reads.threads('ask:')).toEqual(['ask:sa']);
      expect(await reads.threads('activity:sa:')).toEqual(['activity:sa:a1']);
      expect(await reads.list('group:ed')).toEqual([{ admin: 'Root', startedAt: T0 - MIN, lastSeenAt: T0 - MIN, kind: 'read' }]);
      // The new records are owed to the person, the older one owes nothing.
      expect((await reads.unseenFor('ed')).map((r) => r.thread).sort((a, b) => a.localeCompare(b))).toEqual(['activity:sa:a1', 'ask:sa']);
      expect(await reads.seen('ask:sa', 'ed')).toBe(1);
      expect(await reads.forget('activity:sa:a1')).toBe(0);
      expect(await reads.forget('ask:sa')).toBe(1);
    } finally {
      await s.close();
    }
  });
  it('reads an Admin\'s record made before a record had a kind as a reading, in order, that live and touch treat as a reading, when the database is upgraded (#1034)', async () => {
    const MIN = 60_000;
    const read = (adminKey: string, admin: string, startedAt: number, lastSeenAt: number, thread = 'group:ed'): LegacyAdminRead => ({ thread, adminKey, admin, startedAt, lastSeenAt });
    const s = await o.openUpgraded([], [], [], [], [], [read('zoe', 'Zoe', T0 + MIN, T0 + 2 * MIN), read('root', 'Root', T0, T0 + 5 * MIN), read('root', 'Root', T0 - 90 * MIN, T0 - 80 * MIN, 'dm:a|b')]);
    try {
      const reads = s.chat({ now: () => T0 + 6 * MIN }).adminReads;
      expect(await reads.list('group:ed')).toEqual([
        { admin: 'Root', startedAt: T0, lastSeenAt: T0 + 5 * MIN, kind: 'read' },
        { admin: 'Zoe', startedAt: T0 + MIN, lastSeenAt: T0 + 2 * MIN, kind: 'read' },
      ]);
      expect(await reads.list('dm:a|b')).toEqual([{ admin: 'Root', startedAt: T0 - 90 * MIN, lastSeenAt: T0 - 80 * MIN, kind: 'read' }]);
      // Live counts them as readings.
      expect(await reads.live(['group:ed', 'dm:a|b'], T0 + MIN)).toEqual([
        { thread: 'group:ed', admin: 'Root', startedAt: T0, lastSeenAt: T0 + 5 * MIN, kind: 'read' },
        { thread: 'group:ed', admin: 'Zoe', startedAt: T0 + MIN, lastSeenAt: T0 + 2 * MIN, kind: 'read' },
      ]);
      // A touch within the gap continues the old record rather than starting a new one.
      expect(await reads.touch('group:ed', 'Root', 30 * MIN)).toMatchObject({ started: false, previousSeenAt: T0 + 5 * MIN, record: { startedAt: T0, lastSeenAt: T0 + 6 * MIN, kind: 'read' } });
      expect((await reads.list('group:ed')).map((r) => r.kind)).toEqual(['read', 'read']);
      // A record made before it was kept who it is owed to owes nothing, so retention and forgetting take it as they did (#1051).
      expect(await reads.purge(T0 - 70 * MIN)).toBe(1);
      expect(await reads.forget('group:ed')).toBe(2);
      expect(await reads.list('dm:a|b')).toEqual([]);
    } finally {
      await s.close();
    }
  });
  it('owes a person the records an older database kept in its lists, and not the ones the person had seen, when the database is upgraded (#1061)', async () => {
    const MIN = 60_000;
    const list = (adminKey: string, thread: string, startedAt: number, people: string[], seen: string[]): LegacyAdminRead => ({
      thread, adminKey, admin: adminKey, startedAt, lastSeenAt: startedAt, lists: { kind: 'read', people, seen },
    });
    const s = await o.openUpgraded([], [], [], [], [], [
      list('root', 'dm:a|b', T0, ['ed', 'eve'], ['eve']),
      list('zoe', 'dm:a|b', T0 + MIN, ['ed'], []),
      list('root', 'group:eve', T0 + 2 * MIN, ['eve'], ['eve']),
      list('root', 'dm:none', T0 + 3 * MIN, [], []),
    ]);
    try {
      const reads = s.chat({ now: () => T0 + 10 * MIN }).adminReads;
      const brief = (l: { thread: string; admin: string }[]) => l.map((r) => `${r.thread}:${r.admin}`);
      expect(brief(await reads.unseenFor('Ed'))).toEqual(['dm:a|b:zoe', 'dm:a|b:root']);
      expect(brief(await reads.unseenFor('eve'))).toEqual([]);
      expect(brief(await reads.unseenFor('nobody'))).toEqual([]);
      // It is filled once: a second look, and a record made now, add to it and do not repeat it.
      await reads.mark('dm:a|b', 'Root', 'paused', ['ed']);
      expect(await s.chat({ now: () => T0 + 11 * MIN }).adminReads.unseenFor('ed')).toHaveLength(3);
      expect(await reads.seen('dm:a|b', 'ed')).toBe(3);
      // Nobody is owed the first two now; the one that names nobody goes by retention alone.
      expect(await reads.forget('dm:a|b')).toBe(3);
      expect(await reads.purge(T0 + 4 * MIN)).toBe(2);
    } finally {
      await s.close();
    }
  });
  it('puts every public message an older database holds in General, in order and with its mentions, and lets a channel be opened beside it, when the database is upgraded (#1035)', async () => {
    const old = (id: string, createdAt: number, seq: number, text: string, mentionsJson = '[]'): LegacyPublicMessage => ({ id, authorKind: 'person', authorRef: 'ed', authorName: 'Ed', text, createdAt, mentionsJson, seq });
    const held = JSON.stringify([{ sessionId: 'sa', peerKey: 'k', typed: 'alpha@box', state: 'held', why: null, stateAt: T0 }]);
    const s = await o.openUpgraded([], [], [], [], [], [], [old('pub_00000000_a', T0, 1, 'first'), old('pub_00000000_c', T0 + 5, 3, 'third', held), old('pub_00000000_b', T0, 2, 'second')]);
    try {
      const chat = s.chat({ now: () => T0 + 10 });
      const page = await chat.public.page('general', { limit: 10 });
      expect(page.messages.map((m) => [m.text, m.channel])).toEqual([['first', 'general'], ['second', 'general'], ['third', 'general']]);
      expect(page.messages[2]!.mentions[0]).toMatchObject({ sessionId: 'sa', state: 'held' });
      expect(await chat.public.count('general')).toBe(3);
      expect((await chat.public.heldMentions('general', {})).map((m) => m.text)).toEqual(['third']);
      expect(await chat.channels.list()).toEqual([]);
      // A channel beside General has none of them, and a new General post follows the old ones.
      expect(await chat.channels.create({ name: 'new', createdBy: 'ed' }, T0 + 10)).toMatchObject({ ok: true });
      expect(await chat.public.count('new')).toBe(0);
      await chat.public.post('new', { authorKind: 'person', authorRef: 'ed', authorName: 'Ed', text: 'in new' });
      await chat.public.post('general', { authorKind: 'person', authorRef: 'ed', authorName: 'Ed', text: 'fourth' });
      expect((await chat.public.page('general', { limit: 10 })).messages.map((m) => m.text)).toEqual(['first', 'second', 'third', 'fourth']);
      expect((await chat.public.page('new', { limit: 10 })).messages.map((m) => m.text)).toEqual(['in new']);
      expect(await chat.public.purge(T0 + 1)).toBe(2);
    } finally {
      await s.close();
    }
  });
  it('reads the group and public messages an older database holds as never edited and never deleted, gives a person\'s the id of the person their author name matches, and lets only that person edit and delete them, when the database is upgraded (#1269)', async () => {
    const old = (id: string, createdAt: number, seq: number, text: string, over: Partial<LegacyPublicMessage> = {}): LegacyPublicMessage => ({
      id, authorKind: 'person', authorRef: 'ed', authorName: 'Ed', text, createdAt, mentionsJson: '[]', seq, ...over,
    });
    const g = { owner: 'ed', groupId: 'g1' };
    const s = await o.openUpgraded([], [], [], [], [], [], [
      old('pub_00000000_a', T0, 1, 'public one', { person: 'Ed' }),
      // The name differs from the person's in case and in the spaces between its words, and folds to it.
      old('pub_00000000_b', T0 + 1, 2, 'public two', { authorRef: 'ED   Smith', authorName: 'ED   Smith', person: 'Ed Smith' }),
      old('pub_00000000_c', T0 + 2, 3, 'public three', { authorRef: 'ghost', authorName: 'Ghost' }),
      old('pub_00000000_d', T0 + 3, 4, 'public four', { authorKind: 'orchestrator', authorRef: 'ed', authorName: 'alpha' }),
      old('grp_00000000_a', T0, 1, 'group one', { group: g }),
      old('grp_00000000_b', T0 + 1, 2, 'group two', { group: g, authorRef: 'ghost', authorName: 'Ghost' }),
    ]);
    try {
      const chat = s.chat({ now: () => T0 + 10 });
      const ed = (await s.people.findByName('ed'))!.id;
      const smith = (await s.people.findByName('ed smith'))!.id;
      expect(ed).not.toBe(smith);
      const publicPage = await chat.public.page('general', { limit: 10 });
      const groupPage = await chat.group.page(g, { limit: 10 });
      expect(publicPage.messages.map((m) => [m.text, m.editedAt, m.deletedAt, m.authorId])).toEqual([['public one', null, null, ed], ['public two', null, null, smith], ['public three', null, null, null], ['public four', null, null, null]]);
      expect(groupPage.messages.map((m) => [m.text, m.editedAt, m.deletedAt, m.authorId])).toEqual([['group one', null, null, ed], ['group two', null, null, null]]);
      // A message whose author matches nobody, and an agent's, are nobody's to change.
      for (const who of [ed, smith, 0, 999]) {
        expect(await chat.public.editMessage('general', 'pub_00000000_c', { author: who, text: 'x', now: T0 + 10 })).toEqual({ ok: false, reason: 'not-yours' });
        expect(await chat.public.deleteMessage('general', 'pub_00000000_d', { author: who, now: T0 + 10 })).toEqual({ ok: false, reason: 'not-yours' });
        expect(await chat.group.editMessage(g, 'grp_00000000_b', { author: who, text: 'x', now: T0 + 10 })).toEqual({ ok: false, reason: 'not-yours' });
      }
      expect(await chat.public.editMessage('general', 'pub_00000000_a', { author: smith, text: 'x', now: T0 + 10 })).toEqual({ ok: false, reason: 'not-yours' });
      expect(await chat.public.editMessage('general', 'pub_00000000_a', { author: ed, text: 'public one edited', now: T0 + 10 })).toMatchObject({ ok: true, message: { text: 'public one edited', editedAt: T0 + 10, createdAt: T0, authorId: ed } });
      expect(await chat.public.deleteMessage('general', 'pub_00000000_b', { author: smith, now: T0 + 11 })).toMatchObject({ ok: true, message: { text: '', mentions: [], deletedAt: T0 + 11, authorId: smith } });
      expect(await chat.group.editMessage(g, 'grp_00000000_a', { author: ed, text: 'group one edited', now: T0 + 10 })).toMatchObject({ ok: true, message: { text: 'group one edited', editedAt: T0 + 10 } });
      expect(await chat.group.deleteMessage(g, 'grp_00000000_a', { author: ed, now: T0 + 12 })).toMatchObject({ ok: true, message: { text: '', deletedAt: T0 + 12 } });
      expect((await chat.public.page('general', { limit: 10 })).messages.map((m) => m.text)).toEqual(['public one edited', '', 'public three', 'public four']);
      expect(await chat.public.count('general')).toBe(4);
    } finally {
      await s.close();
    }
  });
  it('reads the direct messages an older database holds as never edited and never deleted, gives a person\'s the id of the person its sender or owner names, and lets only that person edit and delete it and the row it is merged with, when the database is upgraded (#1269)', async () => {
    const wrote = (id: string, seq: number, owner: string, from: string, to: string, text: string, written: NonNullable<LegacyMessage['written']>): LegacyMessage => ({ id, owner, fromSession: from, toSession: to, text, sentAt: T0 + seq, seq, written });
    const ed = (over: Partial<NonNullable<LegacyMessage['written']>> = {}): NonNullable<LegacyMessage['written']> => ({ author: 'person', fromName: 'Ed', state: 'ready', person: 'Ed', ...over });
    const s = await o.openUpgraded([], [], [], [
      // An agent's message, stored the old way, and one the older database already said an agent wrote.
      { id: 'dlv_old', owner: 'ed', fromSession: 'sa', toSession: 'sb', text: 'agent, old', sentAt: T0, seq: 1 },
      wrote('dlv_agent', 2, 'ed', 'sa', 'sb', 'agent, written', { author: 'agent', fromName: 'alpha', state: 'delivered' }),
      // The person with one of their own agents: the sender names them, and the name differs from theirs in case and in the spaces between words.
      wrote('dlv_own', 3, 'ed', 'person:ed', 'sb', 'in my conversation', ed()),
      // A person writing to another person's agent: held for approval.
      wrote('dlv_across', 4, 'ed', 'person:eve smith', 'sb', 'across', ed({ fromName: 'Eve Smith', person: 'Eve Smith', state: 'approval' })),
      // A person adding to a conversation between two agents is two rows, one per agent, owned by the person, with an agent as the sender.
      wrote('dlv_two_a', 5, 'ED', 'sa', 'sb', 'to both', ed()),
      wrote('dlv_two_b', 6, 'ED', 'sb', 'sa', 'to both', ed()),
      // A person nobody is called, in a conversation of their own, and between two other agents.
      wrote('dlv_ghost', 7, 'ghost', 'person:ghost', 'sc', 'nobody', ed({ fromName: 'Ghost', person: undefined })),
      wrote('dlv_nobody', 8, 'Nobody', 'sc', 'sd', 'no one at all', ed({ fromName: 'Nobody', person: undefined })),
    ]);
    try {
      const m = s.peers({ now: () => T0 + 100, flagOn: () => true, startedAt: T0 }).messages;
      const edId = (await s.people.findByName('ed'))!.id;
      const eve = (await s.people.findByName('eve smith'))!.id;
      expect(edId).not.toBe(eve);
      const all = [...(await m.conversation('sa', 'sb')), ...(await m.conversation('person:ed', 'sb')), ...(await m.conversation('person:eve smith', 'sb')), ...(await m.conversation('person:ghost', 'sc')), ...(await m.conversation('sc', 'sd'))];
      expect(all.map((x) => [x.id, x.author, x.authorId, x.editedAt, x.deletedAt, x.text === '' ? null : x.state])).toEqual([
        ['dlv_old', 'agent', null, null, null, 'delivered'],
        ['dlv_agent', 'agent', null, null, null, 'delivered'],
        ['dlv_two_a', 'person', edId, null, null, 'ready'],
        ['dlv_two_b', 'person', edId, null, null, 'ready'],
        ['dlv_own', 'person', edId, null, null, 'ready'],
        ['dlv_across', 'person', eve, null, null, 'approval'],
        ['dlv_ghost', 'person', null, null, null, 'ready'],
        ['dlv_nobody', 'person', null, null, null, 'ready'],
      ]);
      // Nobody changes an agent's message, or a person's that no person matches.
      for (const who of [edId, eve, 0, 999]) {
        for (const id of ['dlv_old', 'dlv_agent', 'dlv_ghost', 'dlv_nobody']) {
          expect(await m.editMessage(id, { author: who, text: 'x', now: T0 + 100 }), `${id} edited by ${who}`).toEqual({ ok: false, reason: 'not-yours' });
          expect(await m.deleteMessage(id, { author: who, now: T0 + 100 }), `${id} deleted by ${who}`).toEqual({ ok: false, reason: 'not-yours' });
        }
      }
      // The person whose name matches changes theirs, and nobody else's.
      expect(await m.editMessage('dlv_own', { author: eve, text: 'x', now: T0 + 100 })).toEqual({ ok: false, reason: 'not-yours' });
      expect(await m.editMessage('dlv_own', { author: edId, text: 'in my conversation, edited', now: T0 + 100 })).toMatchObject({ ok: true, message: { text: 'in my conversation, edited', editedAt: T0 + 100, state: 'ready', authorId: edId } });
      expect(await m.deleteMessage('dlv_across', { author: edId, now: T0 + 101 })).toEqual({ ok: false, reason: 'not-yours' });
      expect(await m.deleteMessage('dlv_across', { author: eve, now: T0 + 101 })).toMatchObject({ ok: true, message: { text: '', deletedAt: T0 + 101, state: 'dropped', why: 'deleted' } });
      // The two rows of one message to two agents change together, whichever row is asked for.
      expect(await m.editMessage('dlv_two_b', { author: edId, text: 'to both, edited', now: T0 + 102 })).toMatchObject({ ok: true, message: { id: 'dlv_two_b', text: 'to both, edited' } });
      expect((await m.conversation('sa', 'sb')).filter((x) => x.author === 'person').map((x) => [x.id, x.text, x.editedAt])).toEqual([['dlv_two_a', 'to both, edited', T0 + 102], ['dlv_two_b', 'to both, edited', T0 + 102]]);
      expect(await m.deleteMessage('dlv_two_a', { author: edId, now: T0 + 103 })).toMatchObject({ ok: true });
      expect((await m.conversation('sa', 'sb')).map((x) => [x.id, x.text, x.deletedAt])).toEqual([['dlv_old', 'agent, old', null], ['dlv_agent', 'agent, written', null], ['dlv_two_a', '', T0 + 103], ['dlv_two_b', '', T0 + 103]]);
    } finally {
      await s.close();
    }
  });
  it('gives the sessions an older database holds agent ids in the order they started, binds its messages to them, and leaves a message whose session is gone with none (#1284)', async () => {
    const s = await o.openUpgraded([], [], [
      // Started in the other order from how they are listed, so the ids follow the start and not the row order.
      { id: 'sb', name: 'beta', startedAt: T0 + 20, model: 'm', costUsd: 0 },
      { id: 'sa', name: 'alpha', startedAt: T0 + 10, model: 'm', costUsd: 0 },
    ], [
      { id: 'dlv_ab', owner: 'ed', fromSession: 'sa', toSession: 'sb', text: 'a to b', sentAt: T0, seq: 1 },
      { id: 'dlv_gone', owner: 'ed', fromSession: 'sa', toSession: 'sgone', text: 'to a deleted session', sentAt: T0 + 1, seq: 2 },
      { id: 'dlv_person', owner: 'ed', fromSession: 'person:ed', toSession: 'sb', text: 'from a person', sentAt: T0 + 2, seq: 3 },
    ]);
    try {
      const m = s.peers({ now: () => T0 + 100, flagOn: () => true, startedAt: T0 }).messages;
      const rows = [...(await m.conversation('sa', 'sb')), ...(await m.conversation('sa', 'sgone')), ...(await m.conversation('person:ed', 'sb'))];
      expect(rows.map((x) => [x.id, x.fromAgent, x.toAgent])).toEqual([['dlv_ab', 1, 2], ['dlv_gone', 1, null], ['dlv_person', null, 2]]);
    } finally {
      await s.close();
    }
  });
  it('gives every session and reporter an older database holds the id of the person its owner name matches, leaves one that matches nobody with none, and lets no newcomer who takes the name own it, when the database is upgraded (#1284)', async () => {
    const reporter = (key: string, owner: string | null, person?: string): LegacyReporter => ({ key, kind: 'mod', machineId: key, machineName: `box-${key}`, owner, version: '1.0.0', firstSeenAt: T0, lastSeenAt: T0, bound: person ? { person } : {} });
    const owned = (id: string, owner: string | null, startedAt: number, person?: string): LegacySession => ({ id, name: id, model: null, costUsd: null, startedAt, owner, bound: person ? { person } : {} });
    const s = await o.openUpgraded([], [
      // The owner differs from the person's name in case and in the spaces between its words, and folds to it.
      reporter('r-ed', 'ED   Smith', 'Ed Smith'),
      reporter('r-ann', 'ann', 'Ann'),
      reporter('r-ghost', 'ghost'),
      reporter('r-admin', 'Admin'),
      reporter('r-none', null),
    ], [
      owned('s-ed', 'ed smith', T0, 'Ed Smith'),
      owned('s-ann', 'Ann', T0 + 1, 'Ann'),
      owned('s-ghost', 'ghost', T0 + 2),
      owned('s-admin', 'Admin', T0 + 3),
      owned('s-none', null, T0 + 4),
    ]);
    try {
      const ed = (await s.people.findByName('ed smith'))!.id;
      const ann = (await s.people.findByName('ann'))!.id;
      expect(ed).not.toBe(ann);
      const sessions = async () => Object.fromEntries(await Promise.all(['s-ed', 's-ann', 's-ghost', 's-admin', 's-none'].map(async (id) => [id, (await s.fleet.getSession(id))!.owner_id])));
      // The owner's id is set where a person matches the name, and the name stays as the text it was.
      expect(await sessions()).toEqual({ 's-ed': ed, 's-ann': ann, 's-ghost': null, 's-admin': null, 's-none': null });
      expect((await s.fleet.getSession('s-ed'))!.owner).toBe('ed smith');
      expect((await s.fleet.getSession('s-ghost'))!.owner).toBe('ghost');
      const lookup = s.reporters.peerLookup();
      expect((await lookup.ofOwner(ed)).map((r) => r.key)).toEqual(['r-ed']);
      expect((await lookup.ofOwner(ann)).map((r) => r.key)).toEqual(['r-ann']);
      expect(await Promise.all(['r-ed', 'r-ann', 'r-ghost', 'r-admin', 'r-none'].map(async (k) => (await lookup.get(k))!.ownerId))).toEqual([ed, ann, null, null, null]);
      expect(await lookup.ofOwner(null)).toEqual([]);
      // Deleting the person detaches what they own, and a new person who takes the name owns none of it: ids are never reused.
      expect((await s.people.deleteMany([ed])).map((p) => p.name)).toEqual(['Ed Smith']);
      const again = (await s.people.createPerson('Ed Smith', null, T0 + 10)).person.id;
      expect(again).not.toBe(ed);
      expect(await sessions()).toEqual({ 's-ed': null, 's-ann': ann, 's-ghost': null, 's-admin': null, 's-none': null });
      expect((await s.fleet.getSession('s-ed'))!.owner).toBe('ed smith');
      expect(await lookup.ofOwner(ed)).toEqual([]);
      expect(await lookup.ofOwner(again)).toEqual([]);
      expect((await lookup.ofOwner(ann)).map((r) => r.key)).toEqual(['r-ann']);
      expect(await lookup.get('r-ed')).toMatchObject({ owner: 'ED   Smith', ownerId: null });
    } finally {
      await s.close();
    }
  });
  it('gives the daily rows an older database holds the id of the person their owner name matches, leaves the others with none and no group, and keeps a newcomer of the same name apart from them, when the database is upgraded (#1284)', async () => {
    const D1 = '2026-10-01';
    const D2 = '2026-10-02';
    const row = (table: LegacyDaily['table'], day: string, owner: string, group: string, person?: string): LegacyDaily => ({ table, day, owner, group, ...(person ? { person } : {}) });
    const s = await o.openUpgraded([], [], [], [], [], [], [], [
      // The owner differs from the person's name in case and folds to it.
      row('usage_daily', D1, 'ANN', 'Crew', 'Ann'),
      row('usage_daily', D2, 'Ann', 'Crew', 'Ann'),
      row('usage_daily', D1, 'ghost', 'Crew'),
      row('usage_daily', D1, 'Admin', ''),
      row('failures_daily', D1, 'ann', '', 'Ann'),
      row('failures_daily', D1, 'ghost', ''),
      row('person_sessions_daily', D1, 'Ann', 'Crew', 'Ann'),
      row('person_sessions_daily', D1, 'ghost', 'Crew'),
      row('skills_daily', D1, 'Ann', '', 'Ann'),
      row('skills_daily', D1, 'ghost', ''),
      row('person_places_daily', D1, 'Ann', 'Crew', 'Ann'),
      row('person_places_daily', D1, 'ghost', 'Crew'),
    ]);
    try {
      const ann = (await s.people.findByName('ann'))!.id;
      const read = async (table: LegacyDaily['table']) => (await s.fleet.rollupRows(table, D1, D2)).map((r) => [r.day, r.owner, Number(r.owner_id), r.group_name ?? null]);
      // The rows of a person that exists have the person's id and keep their group; the others have 0 and no group; the owner stays as the text it was, and no total changes.
      expect(await read('usage_daily')).toEqual([[D1, 'Admin', 0, ''], [D1, 'ghost', 0, ''], [D1, 'ANN', ann, 'Crew'], [D2, 'Ann', ann, 'Crew']]);
      expect(await read('failures_daily')).toEqual([[D1, 'ghost', 0, null], [D1, 'ann', ann, null]]);
      expect(await read('person_sessions_daily')).toEqual([[D1, 'ghost', 0, ''], [D1, 'Ann', ann, 'Crew']]);
      expect(await read('skills_daily')).toEqual([[D1, 'ghost', 0, null], [D1, 'Ann', ann, null]]);
      expect(await read('person_places_daily')).toEqual([[D1, 'ghost', 0, ''], [D1, 'Ann', ann, 'Crew']]);
      expect((await s.fleet.rollupRows('usage_daily', D1, D2)).reduce((n, r) => n + Number(r.cost_usd), 0)).toBe(8);
      // Deleting the person keeps the rows under the id, which no newcomer gets, and takes the group off them.
      expect((await s.people.deleteMany([ann])).map((p) => p.name)).toEqual(['Ann']);
      const again = (await s.people.createPerson('Ann', null, T0)).person.id;
      expect(again).not.toBe(ann);
      expect(await read('usage_daily')).toEqual([[D1, 'Admin', 0, ''], [D1, 'ghost', 0, ''], [D1, 'ANN', ann, ''], [D2, 'Ann', ann, '']]);
      expect((await s.fleet.rollupRows('usage_daily', D1, D2)).filter((r) => Number(r.owner_id) === again)).toEqual([]);
      // The same name, day, model and project under two ids is two rows, not a clash of keys.
      const usage = (ownerId: number, costUsd: number) => ({ day: D1, ownerId, owner: 'Ann', group: '', model: 'm', project: 'p', sessions: 1, agents: 0, costUsd, unpricedSessions: 0, tokIn: 0, tokOut: 0, tokCr: 0, tokCw: 0 });
      await s.fleet.insertUsage([usage(ann, 1), usage(again, 2), usage(0, 4)]);
      expect((await s.fleet.rollupRows('usage_daily', D1, D1)).filter((r) => r.owner === 'Ann').map((r) => Number(r.cost_usd))).toEqual([4, 1, 2]);
    } finally {
      await s.close();
    }
  });
}
