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
}

/** What an adapter provides: a Storage over a database built at the schema before the request insertion number, the reporter name and the session harness, holding `rows`, `reporters` and `sessions` inserted in the order given. */
export interface UpgradeOpeners {
  openUpgraded(rows: LegacyRequest[], reporters?: LegacyReporter[], sessions?: LegacySession[], messages?: LegacyMessage[], rights?: LegacyRight[], adminReads?: LegacyAdminRead[]): Promise<Storage>;
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
      expect(await peers.messages.purgeHidden(T0 + 1e9)).toBe(0);
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
      expect((await reads.unseenFor('ed')).map((r) => r.thread).sort()).toEqual(['activity:sa:a1', 'ask:sa']);
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
}
