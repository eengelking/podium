// Contract cases for the Chat page's stores (#1034): the group channel (`group_messages`), General (`public_messages`) and the per-person,
// per-thread read state. Each runs one scenario over every adapter (`sameOnAll`) and states the values it expects. The rule they hold:
// a channel's text is never kept with, copied into or returned with a direct message's (`peer_messages`), and the reverse.
import { expect, it } from 'vitest';
import { onEachAdapter, sameOnAll, type Openers } from './contractSame.js';
import type { ChannelChange, ChannelMessage, ChannelPage, ChannelPostInput, ChatStoreApi, MentionState } from './types.js';
import { setUp } from './contractPeers.js';
import { personKeyOf } from '../fleet/peerTypes.js';

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const ED = { name: 'ed', admin: false };

const G = { owner: 'ed', groupId: 'g1' };
const input = (text: string, over: Partial<ChannelPostInput> = {}): ChannelPostInput => ({ authorKind: 'person', authorRef: 'ed', authorName: 'Ed', text, ...over });
const texts = (p: ChannelPage): string[] => p.messages.map((m) => m.text);

export function chatCases(o: Openers): void {
  chatChangeCases(o);
  it('agrees on every adapter for the group channel: posting, pages back with a cursor, mentions, scope, counting, clearing and retention', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const chat = s.chat({ now: () => clock.now });
      const g = chat.group;
      // Three at one moment (the insertion number decides), then two later.
      for (const text of ['one', 'two', 'three']) await rec(`post ${text}`, g.post(G, input(text)));
      clock.now += 5;
      const four = await rec('post four', g.post(G, input('four', { authorKind: 'orchestrator', authorRef: 'sa', authorName: 'alpha', issue: '#12', project: 'podium', milestone: 'v1.6' })));
      await rec('post five (a reply with a mention)', g.post(G, input('five', {
        authorKind: 'subagent', authorRef: 'sb', authorName: 'beta', replyTo: four.id,
        mentions: [{ sessionId: 'sb', peerKey: 'k-b', typed: 'beta@box-b' }, { sessionId: null, peerKey: null, typed: 'ghost@box-x', state: 'not-delivered', why: 'no such agent' }],
      })));
      const p1 = await rec('page 1', g.page(G, { limit: 2 }));
      await rec('page 2', g.page(G, { before: p1.older, limit: 2 }));
      const p2 = await g.page(G, { before: p1.older, limit: 2 });
      await rec('page 3', g.page(G, { before: p2.older, limit: 2 }));
      await rec('page (everything)', g.page(G, { limit: 50 }));
      await rec('page (ED, another case of the owner)', g.page({ owner: 'ED', groupId: 'g1' }, { limit: 50 }));
      await rec('page (another group)', g.page({ owner: 'ed', groupId: 'g2' }, { limit: 50 }));
      await rec('page (another owner, the same group id)', g.page({ owner: 'eve', groupId: 'g1' }, { limit: 50 }));
      await rec('page (bad cursor)', g.page(G, { before: 'junk', limit: 2 }));
      await rec('post (bad author kind)', g.post(G, input('x', { authorKind: 'robot' as never })));
      await rec('count', g.count(G));
      await rec('count (another group)', g.count({ owner: 'ed', groupId: 'g2' }));
      const five = (await g.page(G, { limit: 1 })).messages[0]!;
      clock.now += 7;
      await rec('mention: not delivered', g.setMention(G, five.id, 0, { state: 'not-delivered', why: 'the agent ended' }));
      await rec('mention: working', g.setMention(G, five.id, 0, { state: 'working' }));
      await rec('mention: no such index', g.setMention(G, five.id, 5, { state: 'done' }));
      await rec('mention: no such message', g.setMention(G, 'grp_00000000_000000000000000000000000', 0, { state: 'done' }));
      await rec('mention: another owner', g.setMention({ owner: 'eve', groupId: 'g1' }, five.id, 0, { state: 'done' }));
      await rec('page after mentions', g.page(G, { limit: 50 }));
      // A cursor whose row is gone: the three oldest are purged between the fetches.
      const early = await g.page(G, { limit: 3 });
      await rec('purge (nothing that old)', g.purge(T0 - 1));
      await rec('purge (the three oldest)', g.purge(T0 + 1));
      await rec('page back from a purged cursor', g.page(G, { before: early.older, limit: 3 }));
      await rec('count (after purge)', g.count(G));
      await rec('clear (another group)', g.clear({ owner: 'ed', groupId: 'g2' }));
      await rec('clear', g.clear(G));
      await rec('page (cleared)', g.page(G, { limit: 50 }));
    });
    const everything = t.get('page (everything)') as ChannelPage;
    expect(texts(everything)).toEqual(['one', 'two', 'three', 'four', 'five']);
    expect(everything.older).toBeNull();
    expect(texts(t.get('page 1') as ChannelPage)).toEqual(['four', 'five']);
    expect(texts(t.get('page 2') as ChannelPage)).toEqual(['two', 'three']);
    expect(texts(t.get('page 3') as ChannelPage)).toEqual(['one']);
    expect((t.get('page 3') as ChannelPage).older).toBeNull();
    expect(texts(t.get('page (ED, another case of the owner)') as ChannelPage)).toHaveLength(5);
    expect(texts(t.get('page (another group)') as ChannelPage)).toEqual([]);
    expect(texts(t.get('page (another owner, the same group id)') as ChannelPage)).toEqual([]);
    expect(t.get('page (bad cursor)')).toEqual({ threw: 'The cursor is not one this server gave out.' });
    expect(t.get('post (bad author kind)')).toEqual({ threw: 'The author kind is not one of person, orchestrator, subagent or reporter.' });
    expect(t.get('count')).toBe(5);
    expect(t.get('count (another group)')).toBe(0);
    const four = everything.messages[3] as ChannelMessage;
    expect(four).toMatchObject({ owner: 'ed', groupId: 'g1', authorKind: 'orchestrator', authorRef: 'sa', authorName: 'alpha', issue: '#12', project: 'podium', milestone: 'v1.6', replyTo: null, createdAt: T0 + 5, updatedAt: T0 + 5, mentions: [] });
    const five = everything.messages[4] as ChannelMessage;
    expect(five.mentions).toEqual([
      { sessionId: 'sb', peerKey: 'k-b', typed: 'beta@box-b', state: 'waiting', why: null, stateAt: T0 + 5 },
      { sessionId: null, peerKey: null, typed: 'ghost@box-x', state: 'not-delivered', why: 'no such agent', stateAt: T0 + 5 },
    ]);
    const after = t.get('page after mentions') as ChannelPage;
    expect(after.messages[4]!.mentions[0]).toEqual({ sessionId: 'sb', peerKey: 'k-b', typed: 'beta@box-b', state: 'working', why: null, stateAt: T0 + 12 });
    expect(after.messages[4]!.updatedAt).toBe(T0 + 12);
    expect(after.messages[3]!.updatedAt).toBe(T0 + 5);
    expect(t.get('mention: no such index')).toBeNull();
    expect(t.get('mention: no such message')).toBeNull();
    expect(t.get('mention: another owner')).toBeNull();
    expect(t.get('purge (nothing that old)')).toBe(0);
    expect(t.get('purge (the three oldest)')).toBe(3);
    expect(t.get('page back from a purged cursor')).toEqual({ messages: [], older: null });
    expect(t.get('count (after purge)')).toBe(2);
    expect(t.get('clear (another group)')).toBe(0);
    expect(t.get('clear')).toBe(2);
    expect(t.get('page (cleared)')).toEqual({ messages: [], older: null });
  });

  it('agrees on every adapter for General: the same shape and behavior as the group channel, with no owner or group in it', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const pub = s.chat({ now: () => clock.now }).public;
      for (const text of ['a', 'b', 'c']) await rec(`post ${text}`, pub.post('general', input(text)));
      clock.now += DAY;
      await rec('post d', pub.post('general', input('d', { authorKind: 'reporter', authorRef: 'k-a', authorName: 'box-a', mentions: [{ sessionId: 'sa', peerKey: 'k-a', typed: 'alpha@box-a' }] })));
      const p1 = await rec('page 1', pub.page('general', { limit: 3 }));
      await rec('page 2', pub.page('general', { before: p1.older, limit: 3 }));
      await rec('page (bad cursor)', pub.page('general', { before: '12.x', limit: 3 }));
      await rec('count', pub.count('general'));
      const d = (await pub.page('general', { limit: 1 })).messages[0]!;
      await rec('mention: done', pub.setMention('general', d.id, 0, { state: 'done' }));
      await rec('mention: no such message', pub.setMention('general', 'pub_00000000_000000000000000000000000', 0, { state: 'done' }));
      await rec('purge (older than a day)', pub.purge(T0 + DAY));
      await rec('page (after purge)', pub.page('general', { limit: 10 }));
      await rec('clear', pub.clear('general'));
      await rec('count (cleared)', pub.count('general'));
    });
    const p1 = t.get('page 1') as ChannelPage;
    expect(texts(p1)).toEqual(['b', 'c', 'd']);
    expect(texts(t.get('page 2') as ChannelPage)).toEqual(['a']);
    expect(p1.messages[2]).toMatchObject({ owner: null, groupId: null, authorKind: 'reporter', authorRef: 'k-a' });
    expect(t.get('page (bad cursor)')).toEqual({ threw: 'The cursor is not one this server gave out.' });
    expect(t.get('count')).toBe(4);
    expect(t.get('purge (older than a day)')).toBe(3);
    expect(texts(t.get('page (after purge)') as ChannelPage)).toEqual(['d']);
    expect((t.get('page (after purge)') as ChannelPage).messages[0]!.mentions[0]!.state).toBe('done');
    expect(t.get('clear')).toBe(1);
    expect(t.get('count (cleared)')).toBe(0);
  });

  it('agrees on every adapter for the held mentions of a channel (#1046): oldest first, only the held ones, narrowed to one session, scoped to the group', async () => {
    const held = (sessionId: string | null, state?: 'held' | 'working'): ChannelPostInput['mentions'] => [{ sessionId, peerKey: 'k', typed: 'x@box', ...(state ? { state } : {}) }];
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const chat = s.chat({ now: () => clock.now });
      const g = chat.group;
      const pub = chat.public;
      await g.post(G, input('plain'));
      const a = await g.post(G, input('held for sa', { mentions: held('sa', 'held') }));
      await g.post(G, input('working for sa', { mentions: held('sa', 'working') }));
      clock.now += 3;
      // Two at one moment: the insertion number decides the order. The second holds a mention for sa and another for sb.
      await g.post(G, input('held for sb', { mentions: held('sb', 'held') }));
      await g.post(G, input('held for both', { mentions: [...held('sa', 'held')!, ...held('sb', 'held')!] }));
      await g.post({ owner: 'ed', groupId: 'g2' }, input('another group', { mentions: held('sa', 'held') }));
      await g.post({ owner: 'eve', groupId: 'g1' }, input('another owner', { mentions: held('sa', 'held') }));
      await pub.post('general', input('general held', { mentions: held('sa', 'held') }));
      await pub.post('general', input('general held for sc', { mentions: held('sc', 'held') }));
      await rec('group: every held', g.heldMentions(G, {}));
      await rec('group: held for sa', g.heldMentions(G, { sessionId: 'sa' }));
      await rec('group: held for nobody', g.heldMentions(G, { sessionId: 'nobody' }));
      await rec('group: another group', g.heldMentions({ owner: 'ed', groupId: 'g2' }, {}));
      await rec('general: every held', pub.heldMentions('general', {}));
      await rec('general: held for sc', pub.heldMentions('general', { sessionId: 'sc' }));
      clock.now += 1;
      await g.setMention(G, a.id, 0, { state: 'done' });
      await rec('group: held for sa (one taken)', g.heldMentions(G, { sessionId: 'sa' }));
    });
    expect(texts({ messages: t.get('group: every held') as ChannelMessage[], older: null })).toEqual(['held for sa', 'held for sb', 'held for both']);
    expect(texts({ messages: t.get('group: held for sa') as ChannelMessage[], older: null })).toEqual(['held for sa', 'held for both']);
    expect(t.get('group: held for nobody')).toEqual([]);
    expect(texts({ messages: t.get('group: another group') as ChannelMessage[], older: null })).toEqual(['another group']);
    expect(texts({ messages: t.get('general: every held') as ChannelMessage[], older: null })).toEqual(['general held', 'general held for sc']);
    expect(texts({ messages: t.get('general: held for sc') as ChannelMessage[], older: null })).toEqual(['general held for sc']);
    expect(texts({ messages: t.get('group: held for sa (one taken)') as ChannelMessage[], older: null })).toEqual(['held for both']);
  });

  onEachAdapter(o, 'finds the held mentions of a channel without reading the pages of a large history (#1046)', async (s) => {
    const clock = { now: T0 };
    const pub = s.chat({ now: () => clock.now }).public;
    const held = (sessionId: string): ChannelPostInput['mentions'] => [{ sessionId, peerKey: 'k', typed: `${sessionId}@box`, state: 'held' }];
    const cost = async (): Promise<number> => {
      let best = Infinity;
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        for (let i = 0; i < 20; i++) await pub.heldMentions('general', { sessionId: 'sa' });
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    for (let i = 0; i < 100; i++) await pub.post('general', input(`old ${i}`));
    await pub.post('general', input('held early', { mentions: held('sa') }));
    const small = await cost();
    for (let i = 0; i < 3000; i++) await pub.post('general', input(`later ${i}`));
    await pub.post('general', input('held late', { mentions: held('sa') }));
    await pub.post('general', input('held for another', { mentions: held('sb') }));
    const large = await cost();
    // The early one is further back than the 1,000 messages the pages used to reach: it is found now.
    expect((await pub.heldMentions('general', { sessionId: 'sa' })).map((x) => x.text)).toEqual(['held early', 'held late']);
    expect((await pub.heldMentions('general', {})).length).toBe(3);
    expect(large).toBeLessThan(Math.max(small * 5, 250));
  }, 300_000);

  it('agrees on every adapter for the unread and mention counts and the last-read cursor of one person in one thread', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const rs = s.chat({ now: () => clock.now }).readState;
      await rec('get (never seen)', rs.get('ed', 'public'));
      await rec('bump', rs.bump('ed', 'public', false));
      clock.now += 1;
      await rec('bump (again)', rs.bump('ED', 'public', false));
      await rec('bump (a mention)', rs.bump('ed', 'public', true));
      await rec('bump (another thread)', rs.bump('ed', 'group:g1', true));
      await rec('bump (another person)', rs.bump('eve', 'public', false));
      await rec('list', rs.list('ed'));
      clock.now += 1;
      await rec('mark read', rs.markRead('ed', 'public', '1800000000005.7'));
      await rec('mark read (a thread never bumped)', rs.markRead('ed', 'dm:a|b', null));
      await rec('get (read)', rs.get('ed', 'public'));
      await rec('list (after)', rs.list('ed'));
      await rec('list (another person)', rs.list('eve'));
      await rec('threads that start with dm:', rs.threads('dm:'));
      await rec('threads that start with group:', rs.threads('group:'));
      await rec('threads that start with nothing there', rs.threads('zz'));
      await rec('forget the thread', rs.forget('public'));
      await rec('list (after forget)', rs.list('ed'));
      await rec('list (another person, after forget)', rs.list('eve'));
    });
    expect(t.get('threads that start with dm:')).toEqual(['dm:a|b']);
    expect(t.get('threads that start with group:')).toEqual(['group:g1']);
    expect(t.get('threads that start with nothing there')).toEqual([]);
    expect(t.get('get (never seen)')).toEqual({ person: 'ed', thread: 'public', lastRead: null, unread: 0, mentions: 0, updatedAt: 0 });
    expect(t.get('bump (a mention)')).toEqual({ person: 'ed', thread: 'public', lastRead: null, unread: 3, mentions: 1, updatedAt: T0 + 1 });
    expect((t.get('list') as { thread: string }[]).map((r) => r.thread)).toEqual(['group:g1', 'public']);
    expect(t.get('get (read)')).toEqual({ person: 'ed', thread: 'public', lastRead: '1800000000005.7', unread: 0, mentions: 0, updatedAt: T0 + 2 });
    expect((t.get('list (after)') as { thread: string }[]).map((r) => r.thread)).toEqual(['dm:a|b', 'group:g1', 'public']);
    expect(t.get('forget the thread')).toBe(2);
    expect((t.get('list (after forget)') as { thread: string }[]).map((r) => r.thread)).toEqual(['dm:a|b', 'group:g1']);
    expect(t.get('list (another person, after forget)')).toEqual([]);
  });

  it('agrees on every adapter for the chat settings and the pause and disconnect flags of a channel', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const cs = s.chat({ now: () => T0 }).settings;
      await rec('get (defaults)', cs.get());
      await rec('set', cs.set({ retainDays: 7, graceHours: 48, maxChars: 500, perMinute: 3 }));
      await rec('set (partial)', cs.set({ retainDays: 14 }));
      await rec('set (retainDays 0)', cs.set({ retainDays: 0 }));
      await rec('set (maxChars too big)', cs.set({ maxChars: 1_000_000 }));
      await rec('set (not a number)', cs.set({ perMinute: 'many' }));
      await rec('set (unknown key)', cs.set({ nope: 1 }));
      await rec('get (after)', cs.get());
      await rec('flags (never set)', cs.flags('group:ed'));
      await rec('set flags (pause)', cs.setFlags('group:ed', { paused: true }));
      await rec('set flags (disconnect)', cs.setFlags('group:ed', { disconnected: true }));
      await rec('set flags (resume)', cs.setFlags('group:ed', { paused: false }));
      await rec('set flags (another channel)', cs.setFlags('public:global', { paused: true }));
      await rec('flags (a channel)', cs.flags('group:ed'));
      await rec('all flags', cs.allFlags());
      await rec('set flags (both off)', cs.setFlags('group:ed', { disconnected: false }));
      await rec('all flags (after)', cs.allFlags());
      await rec('set flags (an Admin pauses)', cs.setFlags('group:eve', { paused: true, pausedByAdmin: 'Root' }));
      await rec('flags (an Admin\'s pause)', cs.flags('group:eve'));
      await rec('set flags (disconnect keeps the Admin)', cs.setFlags('group:eve', { disconnected: true }));
      await rec('all flags (an Admin\'s pause)', cs.allFlags());
      await rec('set flags (resume clears the Admin)', cs.setFlags('group:eve', { paused: false }));
      await rec('set flags (a name with a bar)', cs.setFlags('group:eve', { paused: true, pausedByAdmin: 'a|b' }));
      await rec('flags (a name with a bar)', cs.flags('group:eve'));
    });
    expect(t.get('get (defaults)')).toEqual({ retainDays: 30, graceHours: 24, maxChars: 4000, perMinute: 6 });
    expect(t.get('set')).toEqual({ ok: true, settings: { retainDays: 7, graceHours: 48, maxChars: 500, perMinute: 3 } });
    expect(t.get('set (partial)')).toEqual({ ok: true, settings: { retainDays: 14, graceHours: 48, maxChars: 500, perMinute: 3 } });
    for (const k of ['set (retainDays 0)', 'set (maxChars too big)', 'set (not a number)', 'set (unknown key)']) expect(t.get(k), k).toMatchObject({ ok: false });
    expect(t.get('get (after)')).toEqual({ retainDays: 14, graceHours: 48, maxChars: 500, perMinute: 3 });
    expect(t.get('flags (never set)')).toEqual({ paused: false, disconnected: false });
    expect(t.get('set flags (pause)')).toEqual({ paused: true, disconnected: false });
    expect(t.get('set flags (disconnect)')).toEqual({ paused: true, disconnected: true });
    expect(t.get('set flags (resume)')).toEqual({ paused: false, disconnected: true });
    expect(t.get('all flags')).toEqual({ 'group:ed': { paused: false, disconnected: true }, 'public:global': { paused: true, disconnected: false } });
    expect(t.get('all flags (after)')).toEqual({ 'public:global': { paused: true, disconnected: false } });
    expect(t.get('flags (an Admin\'s pause)')).toEqual({ paused: true, disconnected: false, pausedByAdmin: 'Root' });
    expect(t.get('set flags (disconnect keeps the Admin)')).toEqual({ paused: true, disconnected: true, pausedByAdmin: 'Root' });
    expect(t.get('set flags (resume clears the Admin)')).toEqual({ paused: false, disconnected: true });
    expect(t.get('flags (a name with a bar)')).toEqual({ paused: true, disconnected: true, pausedByAdmin: 'a|b' });
  });

  it('agrees on every adapter for the Admin read records of a person\'s session (#1073, #1074): an ask and each loop of the Activity are threads of their own, listed by prefix, live, owed and seen', async () => {
    const MIN = 60_000;
    const GAP = 30 * MIN;
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const reads = s.chat({ now: () => clock.now }).adminReads;
      // Session ids hold characters a prefix match must not treat as a pattern.
      await rec('touch (an ask)', reads.touch('ask:s_1', 'Root', GAP, ['ed']));
      await rec('touch (an ask of a session that only starts alike)', reads.touch('ask:s_10', 'Root', GAP, ['eve']));
      await rec('touch (an ask of a session with a wildcard)', reads.touch('ask:s%', 'Root', GAP, ['zoe']));
      await rec('touch (activity, one loop)', reads.touch('activity:s_1:@orchestrator', 'Root', GAP, ['ed']));
      await rec('touch (activity, another loop)', reads.touch('activity:s_1:a1', 'Zoe', GAP, ['ed']));
      clock.now += 10 * MIN;
      await rec('touch (the same ask, 10 minutes on: one record)', reads.touch('ask:s_1', 'root', GAP, ['ed']));
      await rec('list (the ask)', reads.list('ask:s_1'));
      await rec('threads (activity of one session)', reads.threads('activity:s_1:'));
      await rec('threads (ask prefix)', reads.threads('ask:s_1'));
      await rec('live (only what was read in the last 30 seconds)', reads.live(['ask:s_1', 'activity:s_1:a1', 'activity:s_1:@orchestrator'], clock.now - 30_000));
      await rec('unseen (Ed)', reads.unseenFor('ed').then((l) => l.map((r) => `${r.thread}|${r.admin}`)));
      await rec('seen (the ask, by Ed)', reads.seen('ask:s_1', 'ED'));
      await rec('unseen (Ed, after the ask)', reads.unseenFor('ed').then((l) => l.map((r) => `${r.thread}|${r.admin}`)));
      await rec('seen (the ask again)', reads.seen('ask:s_1', 'ed'));
      await rec('forget (the ask)', reads.forget('ask:s_1'));
      await rec('threads (after forgetting the ask)', reads.threads('ask:'));
    });
    expect(t.get('touch (an ask)')).toMatchObject({ started: true, record: { admin: 'Root', startedAt: T0, kind: 'read' } });
    expect(t.get('touch (the same ask, 10 minutes on: one record)')).toMatchObject({ started: false, previousSeenAt: T0 });
    expect(t.get('threads (activity of one session)')).toEqual(['activity:s_1:@orchestrator', 'activity:s_1:a1']);
    expect(t.get('threads (ask prefix)')).toEqual(['ask:s_1', 'ask:s_10']);
    expect(t.get('live (only what was read in the last 30 seconds)')).toMatchObject([{ thread: 'ask:s_1', admin: 'Root' }]);
    expect(t.get('unseen (Ed)')).toHaveLength(3);
    expect(t.get('seen (the ask, by Ed)')).toBe(1);
    expect(t.get('unseen (Ed, after the ask)')).toHaveLength(2);
    expect(t.get('seen (the ask again)')).toBe(0);
    expect(t.get('forget (the ask)')).toBe(1);
    expect(t.get('threads (after forgetting the ask)')).toEqual(['ask:s%', 'ask:s_10']);
  });

  it('agrees on every adapter for the Admin read records of an agent\'s whole text and live Activity (#1082): each agent is a thread of its own under its kind, listed by prefix and live', async () => {
    const GAP = 30 * 60_000;
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const reads = s.chat({ now: () => clock.now }).adminReads;
      await rec('touch (text, one agent)', reads.touch('text:s_1:a1', 'Root', GAP, ['ed']));
      await rec('touch (text, another agent)', reads.touch('text:s_1:a2', 'Root', GAP, ['ed']));
      await rec('touch (live, one agent)', reads.touch('live:s_1:a1', 'Zoe', GAP, ['ed']));
      await rec('touch (live, the orchestrator)', reads.touch('live:s_1:@orchestrator', 'Zoe', GAP, ['ed']));
      await rec('threads (text of one session)', reads.threads('text:s_1:'));
      await rec('threads (live of one session)', reads.threads('live:s_1:'));
      await rec('list (live, one agent)', reads.list('live:s_1:a1'));
      await rec('live (text of a1 only)', reads.live(['text:s_1:a1', 'live:s_1:a1'], clock.now - 30_000));
    });
    expect(t.get('threads (text of one session)')).toEqual(['text:s_1:a1', 'text:s_1:a2']);
    expect(t.get('threads (live of one session)')).toEqual(['live:s_1:@orchestrator', 'live:s_1:a1']);
    expect(t.get('list (live, one agent)')).toMatchObject([{ admin: 'Zoe' }]);
    expect(t.get('live (text of a1 only)')).toHaveLength(2);
  });

  it('agrees on every adapter for the Admin read records: one per reading session, the live window, forgetting a thread and retention', async () => {
    const MIN = 60_000;
    const GAP = 30 * MIN;
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const reads = s.chat({ now: () => clock.now }).adminReads;
      await rec('list (none)', reads.list('group:ed'));
      await rec('touch (first)', reads.touch('group:ed', 'Root', GAP));
      clock.now += 10 * MIN;
      await rec('touch (10 minutes on: the same session)', reads.touch('group:ed', 'root', GAP));
      await rec('touch (another Admin)', reads.touch('group:ed', 'Zoe', GAP));
      clock.now += 31 * MIN;
      await rec('touch (another thread)', reads.touch('dm:a|b', 'Root', GAP));
      await rec('touch (31 minutes after the last: a second session)', reads.touch('group:ed', 'Root', GAP));
      await rec('list', reads.list('group:ed'));
      await rec('live (just touched)', reads.live(['group:ed', 'dm:a|b'], clock.now - 30_000));
      clock.now += 30_000;
      await rec('live (30 seconds on)', reads.live(['group:ed', 'dm:a|b'], clock.now - 30_000));
      await rec('live (no threads)', reads.live([], clock.now - 30_000));
      await rec('threads', reads.threads('dm:'));
      await rec('purge (nothing that old)', reads.purge(T0));
      await rec('purge (the first session and the other Admin)', reads.purge(T0 + 11 * MIN));
      await rec('list (after purge)', reads.list('group:ed'));
      // An Admin's stop stays on the record: it is a line of its own, never a session or live, and it shares a millisecond with a read without losing either.
      await rec('mark (cleared)', reads.mark('group:ed', 'Zoe', 'cleared'));
      await rec('mark (paused, the same moment)', reads.mark('group:ed', 'zoe', 'paused'));
      await rec('mark (resumed, the same moment)', reads.mark('group:ed', 'zoe', 'resumed'));
      await rec('touch (a read the same moment as a stop)', reads.touch('group:ed', 'Zoe', GAP));
      await rec('list (with stops)', reads.list('group:ed'));
      await rec('live (a stop is never live)', reads.live(['group:ed'], clock.now - 30_000));
      await rec('threads (a stop only)', (async () => { await reads.mark('public', 'Root', 'paused'); return reads.threads('public'); })());
      await rec('purge (a stop is retained by its time like a read)', reads.purge(clock.now + 10));
      await rec('list (after the stops are purged)', reads.list('group:ed'));
      await rec('mark (disconnected and reconnected)', (async () => { await reads.mark('group:fay', 'Root', 'disconnected'); await reads.mark('group:fay', 'root', 'reconnected'); const l = await reads.list('group:fay'); await reads.forget('group:fay'); return l.map((r) => r.kind); })());
      await rec('mark (an Admin act on a person\'s things, owed to them, seen once)', (async () => {
        await reads.mark('act:ed', 'Root', 'recording_stopped', ['ed']);
        await reads.mark('act:ed', 'Root', 'reporter_removed', ['ed']);
        const owed = (await reads.unseenFor('Ed')).filter((r) => r.thread === 'act:ed').map((r) => r.kind);
        await reads.seen('act:ed', 'ed');
        const after = (await reads.unseenFor('Ed')).filter((r) => r.thread === 'act:ed').length;
        await reads.forget('act:ed');
        return { owed, after, left: (await reads.list('act:ed')).length };
      })());
      await rec('touch (the other thread again, so forgetting keeps it)', reads.touch('dm:a|b', 'Root', GAP));
      await rec('forget the thread', reads.forget('group:ed'));
      await rec('forget (nothing left)', reads.forget('group:ed'));
      await rec('list (after forget)', reads.list('group:ed'));
      await rec('list (the other thread is kept)', reads.list('dm:a|b'));
    });
    expect(t.get('touch (first)')).toEqual({ record: { admin: 'Root', startedAt: T0, lastSeenAt: T0, kind: 'read' }, started: true, previousSeenAt: null });
    expect(t.get('touch (10 minutes on: the same session)')).toEqual({ record: { admin: 'Root', startedAt: T0, lastSeenAt: T0 + 10 * MIN, kind: 'read' }, started: false, previousSeenAt: T0 });
    expect((t.get('touch (31 minutes after the last: a second session)') as { started: boolean }).started).toBe(true);
    expect(t.get('list')).toEqual([
      { admin: 'Root', startedAt: T0, lastSeenAt: T0 + 10 * MIN, kind: 'read' },
      { admin: 'Zoe', startedAt: T0 + 10 * MIN, lastSeenAt: T0 + 10 * MIN, kind: 'read' },
      { admin: 'Root', startedAt: T0 + 41 * MIN, lastSeenAt: T0 + 41 * MIN, kind: 'read' },
    ]);
    expect((t.get('live (just touched)') as { thread: string }[]).map((r) => r.thread)).toEqual(['dm:a|b', 'group:ed']);
    expect(t.get('live (30 seconds on)')).toEqual([]);
    expect(t.get('live (no threads)')).toEqual([]);
    expect(t.get('threads')).toEqual(['dm:a|b']);
    expect(t.get('purge (nothing that old)')).toBe(0);
    expect(t.get('purge (the first session and the other Admin)')).toBe(2);
    const at = T0 + 41 * MIN + 30_000;
    expect(t.get('mark (cleared)')).toEqual({ admin: 'Zoe', startedAt: at, lastSeenAt: at, kind: 'cleared' });
    expect(t.get('mark (paused, the same moment)')).toEqual({ admin: 'zoe', startedAt: at + 1, lastSeenAt: at + 1, kind: 'paused' });
    expect(t.get('mark (resumed, the same moment)')).toEqual({ admin: 'zoe', startedAt: at + 2, lastSeenAt: at + 2, kind: 'resumed' });
    expect(t.get('touch (a read the same moment as a stop)')).toMatchObject({ started: true, record: { kind: 'read', startedAt: at + 3 } });
    expect((t.get('list (with stops)') as { kind: string }[]).map((r) => r.kind)).toEqual(['read', 'cleared', 'paused', 'resumed', 'read']);
    expect(t.get('live (a stop is never live)')).toMatchObject([{ kind: 'read' }]);
    expect(t.get('threads (a stop only)')).toEqual(['public']);
    expect(t.get('purge (a stop is retained by its time like a read)')).toBe(7);
    expect(t.get('list (after the stops are purged)')).toEqual([]);
    expect(t.get('mark (disconnected and reconnected)')).toEqual(['disconnected', 'reconnected']);
    expect(t.get("mark (an Admin act on a person's things, owed to them, seen once)")).toEqual({ owed: ['reporter_removed', 'recording_stopped'], after: 0, left: 0 });
    expect(t.get('forget the thread')).toBe(0);
    expect(t.get('forget (nothing left)')).toBe(0);
    expect(t.get('list (after forget)')).toEqual([]);
    expect(t.get('list (the other thread is kept)')).toEqual([{ admin: 'Root', startedAt: at, lastSeenAt: at, kind: 'read' }]);
  });

  it('keeps an Admin record until each person it names has seen it, and lets the rest go by retention (#1051)', async () => {
    const MIN = 60_000;
    const GAP = 30 * MIN;
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const reads = s.chat({ now: () => clock.now }).adminReads;
      await reads.touch('group:ed', 'Root', GAP, ['Ed']);
      await reads.mark('dm:a|b', 'Root', 'paused', ['Ed', 'eve']);
      await reads.touch('list:ed', 'Root', GAP, ['ed']);
      await reads.mark('public', 'Root', 'cleared');
      clock.now += 2 * MIN;
      await reads.touch('group:zed', 'Zoe', GAP, ['zed']);
      await rec('recent (the last minute)', reads.recent(clock.now - MIN).then((l) => l.map((r) => r.thread)));
      await rec('recent (the last hour)', reads.recent(clock.now - 60 * MIN).then((l) => l.map((r) => `${r.thread}:${r.admin}:${r.kind}`)));
      clock.now += 60 * MIN;
      await rec('purge (only what nobody is owed)', reads.purge(clock.now));
      await rec('threads (the unseen are kept)', reads.threads(''));
      await rec('forget (unseen)', reads.forget('dm:a|b'));
      await rec('seen (a person it does not name)', reads.seen('dm:a|b', 'zed'));
      await rec('seen (Ed, folded)', reads.seen('dm:a|b', 'ED'));
      await rec('seen (Ed again)', reads.seen('dm:a|b', 'ed'));
      await rec('forget (Eve has not seen it)', reads.forget('dm:a|b'));
      await rec('seen (Eve)', reads.seen('dm:a|b', 'Eve'));
      await rec('forget (all have seen it)', reads.forget('dm:a|b'));
      await rec('seen (the group, Ed)', reads.seen('group:ed', 'Ed'));
      await rec('purge (seen now)', reads.purge(clock.now));
      await rec('threads (after)', reads.threads(''));
    });
    expect(t.get('recent (the last minute)')).toEqual(['group:zed']);
    expect(t.get('recent (the last hour)')).toEqual(['group:ed:Root:read', 'group:zed:Zoe:read', 'list:ed:Root:read']);
    // Only General's record owes nothing, so it alone goes.
    expect(t.get('purge (only what nobody is owed)')).toBe(1);
    expect(t.get('threads (the unseen are kept)')).toEqual(['dm:a|b', 'group:ed', 'group:zed', 'list:ed']);
    expect(t.get('forget (unseen)')).toBe(0);
    expect(t.get('seen (a person it does not name)')).toBe(0);
    expect(t.get('seen (Ed, folded)')).toBe(1);
    expect(t.get('seen (Ed again)')).toBe(0);
    expect(t.get('forget (Eve has not seen it)')).toBe(0);
    expect(t.get('seen (Eve)')).toBe(1);
    expect(t.get('forget (all have seen it)')).toBe(1);
    expect(t.get('seen (the group, Ed)')).toBe(1);
    expect(t.get('purge (seen now)')).toBe(1);
    expect(t.get('threads (after)')).toEqual(['group:zed', 'list:ed']);
  });

  it('lists the records a person has not seen, newest first, and stops listing a thread\'s once the person has seen it (#1051)', async () => {
    const MIN = 60_000;
    const GAP = 30 * MIN;
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const reads = s.chat({ now: () => clock.now }).adminReads;
      await reads.touch('dm:a|b', 'Root', GAP, ['Ed', 'eve']);
      clock.now += MIN;
      await reads.mark('dm:a|b', 'Zoe', 'cleared', ['ed']);
      clock.now += MIN;
      await reads.touch('group:ed', 'Root', GAP, ['ed']);
      await reads.touch('dm:c|d', 'Root', GAP, ['zed']);
      await reads.mark('public', 'Root', 'paused');
      await reads.touch('dm:old|older', 'Root', GAP);
      const brief = (l: { thread: string; admin: string; kind: string; startedAt: number }[]) => l.map((r) => `${r.thread}:${r.admin}:${r.kind}:${r.startedAt - T0}`);
      await rec('Ed, folded', reads.unseenFor('ED').then(brief));
      await rec('Eve', reads.unseenFor('Eve').then(brief));
      await rec('nobody', reads.unseenFor('nobody').then(brief));
      await rec('seen (Ed, the conversation)', reads.seen('dm:a|b', 'ed'));
      await rec('Ed after seeing it', reads.unseenFor('ed').then(brief));
      await rec('Eve after Ed saw it', reads.unseenFor('eve').then(brief));
    });
    expect(t.get('Ed, folded')).toEqual([`group:ed:Root:read:${2 * MIN}`, `dm:a|b:Zoe:cleared:${MIN}`, 'dm:a|b:Root:read:0']);
    expect(t.get('Eve')).toEqual(['dm:a|b:Root:read:0']);
    expect(t.get('nobody')).toEqual([]);
    expect(t.get('seen (Ed, the conversation)')).toBe(2);
    expect(t.get('Ed after seeing it')).toEqual([`group:ed:Root:read:${2 * MIN}`]);
    expect(t.get('Eve after Ed saw it')).toEqual(['dm:a|b:Root:read:0']);
  });

  it('finds each person\'s unseen records among 10,000 owed to 50 people, and clears them for that person alone (#1061)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const reads = s.chat({ now: () => clock.now }).adminReads;
      // Record i is owed to person i mod 50, and every fifth one to the next person as well.
      for (let i = 0; i < 10_000; i++) {
        clock.now += 1;
        const people = [`p${String(i % 50).padStart(2, '0')}`, ...(i % 5 === 0 ? [`p${String((i + 1) % 50).padStart(2, '0')}`] : [])];
        await reads.mark(`dm:t${String(i).padStart(5, '0')}`, 'Root', 'cleared', people);
      }
      const mine = await reads.unseenFor('P07');
      await rec('count (p07)', mine.length);
      await rec('newest three (p07)', mine.slice(0, 3).map((r) => r.thread));
      await rec('count (p06, owed the shared ones too)', reads.unseenFor('p06').then((l) => l.length));
      await rec('count (nobody)', reads.unseenFor('p99').then((l) => l.length));
      await rec('seen (p06, a conversation shared with p05)', reads.seen('dm:t00005', 'p06'));
      await rec('count (p06, after)', reads.unseenFor('p06').then((l) => l.length));
      await rec('count (p05, after p06 saw it)', reads.unseenFor('p05').then((l) => l.length));
      await rec('count (p07, after)', reads.unseenFor('p07').then((l) => l.length));
    });
    expect(t.get('count (p07)')).toBe(200);
    expect(t.get('newest three (p07)')).toEqual(['dm:t09957', 'dm:t09907', 'dm:t09857']);
    expect(t.get('count (p06, owed the shared ones too)')).toBe(400);
    expect(t.get('count (nobody)')).toBe(0);
    expect(t.get('seen (p06, a conversation shared with p05)')).toBe(1);
    expect(t.get('count (p06, after)')).toBe(399);
    expect(t.get('count (p05, after p06 saw it)')).toBe(200);
    expect(t.get('count (p07, after)')).toBe(200);
  }, 300_000);

  it('stops owing a record to a person who has not seen it in 90 days, and lets retention purge it then (#1061)', async () => {
    const DAYS = 86_400_000;
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const reads = s.chat({ now: () => clock.now }).adminReads;
      await reads.touch('group:ed', 'Root', 30 * 60_000, ['ed', 'eve']);
      await reads.touch('group:zed', 'Root', 30 * 60_000, ['zed']);
      await rec('Eve sees hers', reads.seen('group:ed', 'eve'));
      clock.now = T0 + 89 * DAYS;
      await rec('purge (89 days, retention passed)', reads.purge(clock.now));
      await rec('Ed (89 days)', reads.unseenFor('ed').then((l) => l.length));
      clock.now = T0 + 91 * DAYS;
      await rec('purge (91 days)', reads.purge(clock.now));
      await rec('Ed (91 days)', reads.unseenFor('ed').then((l) => l.length));
      await rec('Zed (91 days)', reads.unseenFor('zed').then((l) => l.length));
      await rec('threads', reads.threads(''));
    });
    expect(t.get('Eve sees hers')).toBe(1);
    expect(t.get('purge (89 days, retention passed)')).toBe(0);
    expect(t.get('Ed (89 days)')).toBe(1);
    expect(t.get('purge (91 days)')).toBe(2);
    expect(t.get('Ed (91 days)')).toBe(0);
    expect(t.get('Zed (91 days)')).toBe(0);
    expect(t.get('threads')).toEqual([]);
  });

  it('leaves a record owed to the owner for an Admin\'s read of a conversation between two agents, and none for the owner\'s own (#1072)', async () => {
    const MIN = 60_000;
    const GAP = 30 * MIN;
    const thread = 'dm:sess-dev|sess-tester';
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const reads = s.chat({ now: () => clock.now }).adminReads;
      await rec('list (before any read)', reads.list(thread));
      await rec('the Admin reads', reads.touch(thread, 'Admin secret', GAP, ['ed']));
      clock.now += MIN;
      await rec('the Admin reads again', reads.touch(thread, 'Admin secret', GAP, ['ed']));
      await rec('list', reads.list(thread));
      await rec('owed to the owner', reads.unseenFor('Ed').then((l) => l.map((r) => `${r.thread}:${r.admin}:${r.kind}`)));
      await rec('owed to someone else', reads.unseenFor('alex').then((l) => l.length));
      await rec('live', reads.live([thread], clock.now - 30_000).then((l) => l.map((r) => r.admin)));
    });
    expect(t.get('list (before any read)')).toEqual([]);
    expect((t.get('the Admin reads') as { started: boolean }).started).toBe(true);
    expect((t.get('the Admin reads again') as { started: boolean }).started).toBe(false);
    expect(t.get('list')).toEqual([{ admin: 'Admin secret', startedAt: T0, lastSeenAt: T0 + MIN, kind: 'read' }]);
    expect(t.get('owed to the owner')).toEqual([`${thread}:Admin secret:read`]);
    expect(t.get('owed to someone else')).toBe(0);
    expect(t.get('live')).toEqual(['Admin secret']);
  });

  it('removes the Admin records owed only to a deleted person, keeps those owed to others too, and leaves a record that names nobody (#1051)', async () => {
    const MIN = 60_000;
    const GAP = 30 * MIN;
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const reads = s.chat({ now: () => clock.now }).adminReads;
      const ed = (await s.people.createPerson('Ed', null, T0)).person;
      await s.people.createPerson('Eve', null, T0);
      await reads.touch('group:ed', 'Root', GAP, ['Ed']);
      await reads.touch('list:ed', 'Root', GAP, ['ed']);
      await reads.mark('dm:ed-only', 'Root', 'paused', ['ED']);
      await reads.touch('dm:a|b', 'Root', GAP, ['ed', 'eve']);
      await reads.mark('dm:a|b', 'Zoe', 'cleared', ['eve', 'Ed']);
      await reads.touch('group:eve', 'Root', GAP, ['eve']);
      // Made before people were kept, or about General: it names nobody and goes by retention alone.
      await reads.touch('dm:none', 'Root', GAP);
      await reads.mark('public', 'Root', 'paused');
      await rec('delete Ed', s.people.deleteMany([ed.id]).then((r) => r.length));
      await rec('threads', reads.threads(''));
      await rec('Ed is owed none', reads.unseenFor('ed').then((l) => l.length));
      await rec('Eve is owed', reads.unseenFor('eve').then((l) => l.map((r) => `${r.thread}:${r.kind}`)));
      await rec('Eve has seen the conversation', reads.seen('dm:a|b', 'eve'));
      await rec('purge (nobody is owed the shared ones now)', reads.purge(clock.now + MIN));
      await rec('threads (after)', reads.threads(''));
    });
    expect(t.get('delete Ed')).toBe(1);
    expect(t.get('threads')).toEqual(['dm:a|b', 'dm:none', 'group:eve', 'public']);
    expect(t.get('Ed is owed none')).toBe(0);
    expect(t.get('Eve is owed')).toEqual(['dm:a|b:read', 'dm:a|b:cleared', 'group:eve:read']);
    expect(t.get('Eve has seen the conversation')).toBe(2);
    expect(t.get('threads (after)')).toEqual(['group:eve']);
  });

  onEachAdapter(o, 'mints the server scope once and keeps it, and puts it in every channel message id', async (s) => {
    const chat = s.chat({ now: () => T0 });
    const scope = await chat.serverScope();
    expect(scope).toMatch(/^[0-9a-f]{8}$/);
    expect(await chat.serverScope()).toBe(scope);
    expect(await s.chat({ now: () => T0 + 1 }).serverScope()).toBe(scope);
    const g = await chat.group.post(G, input('x'));
    const p = await chat.public.post('general', input('y'));
    expect(g.id).toMatch(new RegExp(`^grp_${scope}_[0-9a-f]{24}$`));
    expect(p.id).toMatch(new RegExp(`^pub_${scope}_[0-9a-f]{24}$`));
    expect(new Set([g.id, (await chat.group.post(G, input('z'))).id]).size).toBe(2);
  });

  it('forgets a deleted person\'s Chat data, so a new person of the same name inherits none of it, and leaves everyone else\'s (#1051)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const ed = (await s.people.createPerson('Ed', null, T0)).person;
      const eveP = (await s.people.createPerson('Eve', null, T0)).person;
      const { peers, a, b, eve } = await setUp(s, clock, { ed: ed.id, eve: eveP.id });
      const chat = s.chat({ now: () => clock.now });
      const edKey = personKeyOf(ed.id);
      for (const [from, to] of [[a, b], [b, a]] as const) await peers.rights.setRight(ed.id, from, to, 'send', ED);
      await peers.messages.send('sa', 'beta@box-b', 'agent to agent');
      await peers.messages.sendFromPerson({ ownerId: ed.id, person: 'Ed', toSession: 'sb', text: 'from the person' });
      await peers.setPersonLink(edKey, eve, 'allow', ED);
      await chat.group.post(G, input('ED GROUP'));
      await chat.group.post({ owner: 'eve', groupId: 'g1' }, input('EVE GROUP', { authorRef: 'eve', authorName: 'Eve' }));
      await chat.readState.bump('ed', 'group:ed', true);
      await chat.readState.bump('eve', 'group:eve', false);
      await rec('before: person link', peers.rights.personLink(edKey, eve));
      await rec('delete the person', s.people.deleteMany([ed.id]).then((r) => r.length));
      await rec('group (Ed)', chat.group.page(G, { limit: 10 }).then(texts));
      await rec('group (Eve)', chat.group.page({ owner: 'eve', groupId: 'g1' }, { limit: 10 }).then(texts));
      await rec('read state (Ed)', chat.readState.list('ed'));
      await rec('read state (Eve)', chat.readState.list('eve').then((l) => l.length));
      await rec('person link', peers.rights.personLink(edKey, eve));
      await rec('agent conversation', peers.messages.conversation('sa', 'sb'));
      await rec('person conversation', peers.messages.conversation(edKey, 'sb'));
      await rec('Ed conversations', peers.messages.ownerConversations(ed.id));
    });
    expect(t.get('before: person link')).not.toBeNull();
    expect(t.get('group (Ed)')).toEqual([]);
    expect(t.get('group (Eve)')).toEqual(['EVE GROUP']);
    expect(t.get('read state (Ed)')).toEqual([]);
    expect(t.get('read state (Eve)')).toBe(1);
    expect(t.get('person link')).toBeNull();
    expect(t.get('agent conversation')).toEqual([]);
    expect(t.get('person conversation')).toEqual([]);
    expect(t.get('Ed conversations')).toEqual([]);
  });

  // The hard rule of the Chat page: three tables, one per audience, so a missed filter cannot leak one audience's text to another.
  onEachAdapter(o, 'never returns a direct message from a channel read, nor a channel message from a direct message read', async (s) => {
    const clock = { now: T0 };
    const { peers, a, b } = await setUp(s, clock);
    for (const [from, to] of [[a, b], [b, a]] as const) await peers.rights.setRight(ED_ID, from, to, 'send', ED);
    const dm = 'DIRECT-ONLY-TEXT';
    await peers.messages.send('sa', 'beta@box-b', dm);
    await peers.messages.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', withSession: 'sa', text: `${dm} from the person` });
    const chat = s.chat({ now: () => clock.now });
    await chat.group.post(G, input('GROUP-ONLY-TEXT'));
    await chat.public.post('general', input('PUBLIC-ONLY-TEXT'));
    await chat.readState.bump('ed', 'public', true);
    const channelReads = JSON.stringify([
      await chat.group.page(G, { limit: 100 }), await chat.group.count(G), await chat.public.page('general', { limit: 100 }), await chat.public.count('general'),
      await chat.readState.list('ed'),
    ]);
    expect(channelReads).not.toContain(dm);
    expect(channelReads).toContain('GROUP-ONLY-TEXT');
    expect(channelReads).toContain('PUBLIC-ONLY-TEXT');
    const dmReads = JSON.stringify([
      await peers.messages.page(ED_ID, 'sa', 'sb', { limit: 100 }), await peers.messages.conversation('sa', 'sb'), await peers.messages.ownerConversations(ED_ID),
      await peers.messages.conversations({}),
    ]);
    expect(dmReads).toContain(dm);
    expect(dmReads).not.toContain('GROUP-ONLY-TEXT');
    expect(dmReads).not.toContain('PUBLIC-ONLY-TEXT');
    // Clearing a channel leaves the direct messages alone, and deleting a conversation leaves the channels alone.
    await chat.group.clear(G);
    await chat.public.clear('general');
    expect((await peers.messages.conversation('sa', 'sb')).map((m) => m.text)).toEqual([dm, `${dm} from the person`]);
    await chat.group.post(G, input('kept'));
    await peers.messages.deleteConversation(ED_ID, 'sa', 'sb');
    expect(texts(await chat.group.page(G, { limit: 10 }))).toEqual(['kept']);
  });

  // Public channels (#1035): General is the built-in one with the fixed key `general`; the others are rows of `public_channels`, and their messages are in
  // `public_messages` keyed by the channel. The audience is still the table: there is no visibility column.
  it('agrees on every adapter for opening a public channel: the folded name, the description, the link, who opened it, and every refusal', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const ch = s.chat({ now: () => T0 }).channels;
      await rec('create', ch.create({ name: 'Podium-Dev', description: 'About Podium', createdBy: 'Ed  Engelking' }, T0));
      await rec('create (linked to an issue)', ch.create({ name: 'issue-1035', description: '', link: { kind: 'issue', ref: ' #1035 ' }, createdBy: 'Eve' }, T0 + 1));
      await rec('create (linked to a milestone)', ch.create({ name: 'v1-7', link: { kind: 'milestone', ref: 'v1.7' }, createdBy: 'ed' }, T0 + 2));
      await rec('create (linked to a project)', ch.create({ name: 'podium', link: { kind: 'project', ref: 'Podium' }, createdBy: 'ed' }, T0 + 3));
      await rec('refuse: name taken (another case)', ch.create({ name: 'PODIUM-DEV', createdBy: 'eve' }, T0 + 4));
      await rec('refuse: link taken (another case and spacing)', ch.create({ name: 'other', link: { kind: 'project', ref: ' PODIUM' }, createdBy: 'eve' }, T0 + 5));
      await rec('create (the same reference, another kind)', ch.create({ name: 'milestone-podium', link: { kind: 'milestone', ref: 'podium' }, createdBy: 'eve' }, T0 + 6));
      await rec('refuse: reserved general', ch.create({ name: 'general', createdBy: 'eve' }, T0 + 7));
      await rec('refuse: reserved group (any case)', ch.create({ name: 'Group', createdBy: 'eve' }, T0 + 8));
      for (const bad of ['', '-x', 'a b', 'a_b', 'x'.repeat(41), 'ünï']) await rec(`refuse: invalid name ${JSON.stringify(bad)}`, ch.create({ name: bad, createdBy: 'eve' }, T0 + 9));
      await rec('create (40 characters)', ch.create({ name: 'x'.repeat(40), createdBy: 'eve' }, T0 + 10));
      await rec('refuse: description too long', ch.create({ name: 'long', description: 'd'.repeat(281), createdBy: 'eve' }, T0 + 11));
      await rec('create (description at the limit)', ch.create({ name: 'long', description: 'd'.repeat(280), createdBy: 'eve' }, T0 + 12));
      await rec('refuse: bad link kind', ch.create({ name: 'bad-kind', link: { kind: 'repo' as never, ref: 'x' }, createdBy: 'eve' }, T0 + 13));
      await rec('refuse: empty link reference', ch.create({ name: 'bad-ref', link: { kind: 'issue', ref: '  ' }, createdBy: 'eve' }, T0 + 14));
      await rec('refuse: link reference too long', ch.create({ name: 'bad-ref', link: { kind: 'issue', ref: 'r'.repeat(101) }, createdBy: 'eve' }, T0 + 15));
      await rec('refuse: no opener', ch.create({ name: 'nobody', createdBy: ' ' }, T0 + 16));
      await rec('list', ch.list().then((l) => l.map((c) => c.name)));
      await rec('get (any case)', ch.get('PODIUM-dev'));
      await rec('get (general)', ch.get('general'));
      await rec('get (none)', ch.get('nope'));
      await rec('count', ch.count());
    });
    const made = (k: string): { ok: boolean; channel: Record<string, unknown> } => t.get(k) as never;
    expect(made('create').ok).toBe(true);
    expect(made('create').channel).toEqual({ name: 'podium-dev', description: 'About Podium', link: null, createdBy: 'ed engelking', createdByName: 'Ed  Engelking', createdAt: T0, updatedAt: T0 });
    expect(made('create (linked to an issue)').channel).toMatchObject({ name: 'issue-1035', link: { kind: 'issue', ref: '1035' }, createdBy: 'eve', createdByName: 'Eve' });
    expect(t.get('refuse: name taken (another case)')).toMatchObject({ ok: false, error: 'name-taken' });
    expect(t.get('refuse: link taken (another case and spacing)')).toMatchObject({ ok: false, error: 'link-taken' });
    expect(made('create (the same reference, another kind)').ok).toBe(true);
    expect(t.get('refuse: reserved general')).toMatchObject({ ok: false, error: 'reserved' });
    expect(t.get('refuse: reserved group (any case)')).toMatchObject({ ok: false, error: 'reserved' });
    for (const bad of ['', '-x', 'a b', 'a_b', 'x'.repeat(41), 'ünï']) expect(t.get(`refuse: invalid name ${JSON.stringify(bad)}`), bad).toMatchObject({ ok: false, error: 'invalid' });
    expect(made('create (40 characters)').ok).toBe(true);
    expect(t.get('refuse: description too long')).toMatchObject({ ok: false, error: 'invalid' });
    expect(made('create (description at the limit)').ok).toBe(true);
    for (const k of ['refuse: bad link kind', 'refuse: empty link reference', 'refuse: link reference too long', 'refuse: no opener']) expect(t.get(k), k).toMatchObject({ ok: false, error: 'invalid' });
    expect(t.get('list')).toEqual(['issue-1035', 'long', 'milestone-podium', 'podium', 'podium-dev', 'v1-7', 'x'.repeat(40)]);
    expect(t.get('get (any case)')).toMatchObject({ name: 'podium-dev' });
    expect(t.get('get (general)')).toBeNull();
    expect(t.get('get (none)')).toBeNull();
    expect(t.get('count')).toBe(7);
  });

  it('agrees on every adapter for changing a channel\'s description and removing a channel with its messages, leaving the others\' and General\'s', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const chat = s.chat({ now: () => clock.now });
      const ch = chat.channels;
      await ch.create({ name: 'one', description: 'first', link: { kind: 'issue', ref: '#1' }, createdBy: 'ed' }, T0);
      await ch.create({ name: 'two', createdBy: 'ed' }, T0);
      await chat.public.post('one', input('in one'));
      await chat.public.post('one', input('also in one'));
      await chat.public.post('two', input('in two'));
      await chat.public.post('general', input('in general'));
      clock.now += 10;
      await rec('describe', ch.updateDescription('ONE', 'changed', T0 + 10));
      await rec('describe (empty)', ch.updateDescription('two', '', T0 + 11));
      await rec('describe (too long)', ch.updateDescription('one', 'd'.repeat(281), T0 + 12));
      await rec('describe (no such channel)', ch.updateDescription('nope', 'x', T0 + 13));
      await rec('describe (general)', ch.updateDescription('general', 'x', T0 + 14));
      await rec('get one', ch.get('one'));
      await rec('count in one', chat.public.count('one'));
      await rec('remove one', ch.remove('One'));
      await rec('remove one again', ch.remove('one'));
      await rec('remove general', ch.remove('general'));
      await rec('list', ch.list().then((l) => l.map((c) => c.name)));
      await rec('messages of one', chat.public.page('one', { limit: 50 }).then(texts));
      await rec('messages of two', chat.public.page('two', { limit: 50 }).then(texts));
      await rec('messages of general', chat.public.page('general', { limit: 50 }).then(texts));
      await rec('the link is free again', ch.create({ name: 'one-again', link: { kind: 'issue', ref: '#1' }, createdBy: 'ed' }, T0 + 20));
      await rec('the name is free again', ch.create({ name: 'one', createdBy: 'ed' }, T0 + 21));
      await rec('post to a removed channel', chat.public.post('gone', input('x')));
      await rec('messages of the new one', chat.public.page('one', { limit: 50 }).then(texts));
    });
    expect(t.get('describe')).toMatchObject({ ok: true, channel: { name: 'one', description: 'changed', updatedAt: T0 + 10, createdAt: T0 } });
    expect(t.get('describe (empty)')).toMatchObject({ ok: true, channel: { description: '' } });
    expect(t.get('describe (too long)')).toMatchObject({ ok: false, error: 'invalid' });
    expect(t.get('describe (no such channel)')).toMatchObject({ ok: false, error: 'not-found' });
    expect(t.get('describe (general)')).toMatchObject({ ok: false, error: 'not-found' });
    expect(t.get('get one')).toMatchObject({ description: 'changed', link: { kind: 'issue', ref: '1' } });
    expect(t.get('count in one')).toBe(2);
    expect(t.get('remove one')).toEqual({ removed: true, messages: 2 });
    expect(t.get('remove one again')).toEqual({ removed: false, messages: 0 });
    expect(t.get('remove general')).toEqual({ removed: false, messages: 0 });
    expect(t.get('list')).toEqual(['two']);
    expect(t.get('messages of one')).toEqual([]);
    expect(t.get('messages of two')).toEqual(['in two']);
    expect(t.get('messages of general')).toEqual(['in general']);
    expect(t.get('the link is free again')).toMatchObject({ ok: true });
    expect(t.get('the name is free again')).toMatchObject({ ok: true });
    expect(t.get('post to a removed channel')).toEqual({ threw: 'There is no such public channel.' });
    expect(t.get('messages of the new one')).toEqual([]);
  });

  it('agrees on every adapter that each public channel has its own messages, pages, counts, mentions, clearing and retention, and General is unchanged', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const chat = s.chat({ now: () => clock.now });
      const pub = chat.public;
      await chat.channels.create({ name: 'alpha', createdBy: 'ed' }, T0);
      await chat.channels.create({ name: 'beta', createdBy: 'ed' }, T0);
      for (const text of ['g1', 'g2']) await pub.post('general', input(text));
      for (const text of ['a1', 'a2', 'a3']) await pub.post('alpha', input(text));
      clock.now += 5;
      const b1 = await rec('post to beta', pub.post('beta', input('b1', { mentions: [{ sessionId: 'sb', peerKey: 'k', typed: 'x@box', state: 'held' }] })));
      await pub.post('alpha', input('a4'));
      const p1 = await rec('alpha page 1', pub.page('alpha', { limit: 2 }));
      await rec('alpha page 2', pub.page('alpha', { before: p1.older, limit: 2 }));
      await rec('alpha (a cursor of another channel)', pub.page('beta', { before: p1.older, limit: 2 }));
      await rec('general page', pub.page('general', { limit: 50 }));
      await rec('beta page', pub.page('beta', { limit: 50 }));
      await rec('counts', Promise.all(['general', 'alpha', 'beta'].map((c) => pub.count(c))));
      await rec('held in beta', pub.heldMentions('beta', {}));
      await rec('held in alpha', pub.heldMentions('alpha', {}));
      await rec('mention in the wrong channel', pub.setMention('alpha', b1.id, 0, { state: 'done' }));
      await rec('mention in its channel', pub.setMention('beta', b1.id, 0, { state: 'done' }));
      await rec('clear alpha', pub.clear('alpha'));
      await rec('counts (alpha cleared)', Promise.all(['general', 'alpha', 'beta'].map((c) => pub.count(c))));
      await rec('purge (every channel)', pub.purge(T0 + 1));
      await rec('counts (purged)', Promise.all(['general', 'alpha', 'beta'].map((c) => pub.count(c))));
    });
    const p1 = t.get('alpha page 1') as ChannelPage;
    expect(texts(p1)).toEqual(['a3', 'a4']);
    expect(p1.messages[0]).toMatchObject({ channel: 'alpha', owner: null, groupId: null });
    expect(texts(t.get('alpha page 2') as ChannelPage)).toEqual(['a1', 'a2']);
    expect(texts(t.get('general page') as ChannelPage)).toEqual(['g1', 'g2']);
    expect((t.get('general page') as ChannelPage).messages[0]).toMatchObject({ channel: 'general' });
    expect(texts(t.get('beta page') as ChannelPage)).toEqual(['b1']);
    expect(t.get('counts')).toEqual([2, 4, 1]);
    expect(texts({ messages: t.get('held in beta') as ChannelMessage[], older: null })).toEqual(['b1']);
    expect(t.get('held in alpha')).toEqual([]);
    expect(t.get('mention in the wrong channel')).toBeNull();
    expect(t.get('mention in its channel')).toMatchObject({ id: expect.any(String) });
    expect(t.get('clear alpha')).toBe(4);
    expect(t.get('counts (alpha cleared)')).toEqual([2, 0, 1]);
    expect(t.get('counts (purged)')).toEqual([0, 0, 1]);
  });

  it('agrees on every adapter that one grouped query counts the messages of General and every public channel (#1213)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const chat = s.chat({ now: () => T0 });
      const pub = chat.public;
      for (const name of ['alpha', 'beta', 'empty']) await chat.channels.create({ name, createdBy: 'ed' }, T0);
      await rec('counts (nothing posted)', pub.counts());
      for (const text of ['g1', 'g2']) await pub.post('general', input(text));
      for (const text of ['a1', 'a2', 'a3']) await pub.post('alpha', input(text));
      await pub.post('beta', input('b1'));
      await rec('counts', pub.counts());
      await rec('clear alpha', pub.clear('alpha'));
      await rec('counts (alpha cleared)', pub.counts());
      await rec('remove beta', chat.channels.remove('beta'));
      await rec('counts (beta removed)', pub.counts());
      await rec('purge', pub.purge(T0 + 1));
      await rec('counts (purged)', pub.counts());
    });
    expect(t.get('counts (nothing posted)')).toEqual({});
    expect(t.get('counts')).toEqual({ general: 2, alpha: 3, beta: 1 });
    expect(t.get('counts (alpha cleared)')).toEqual({ general: 2, beta: 1 });
    expect(t.get('counts (beta removed)')).toEqual({ general: 2 });
    expect(t.get('counts (purged)')).toEqual({});
  });

  it('agrees on every adapter for the mentions of one session across General and every channel (#1213): oldest first, the asked states, only a person', async () => {
    const held = (sessionId: string, state: MentionState = 'held'): ChannelPostInput['mentions'] => [{ sessionId, peerKey: 'k', typed: `${sessionId}@box`, state }];
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const chat = s.chat({ now: () => clock.now });
      const pub = chat.public;
      await chat.channels.create({ name: 'alpha', createdBy: 'ed' }, T0);
      await chat.channels.create({ name: 'beta', createdBy: 'ed' }, T0);
      await pub.post('alpha', input('alpha first', { mentions: held('sa') }));
      clock.now += 3;
      await pub.post('general', input('general second', { mentions: held('sa') }));
      await pub.post('beta', input('beta same moment', { mentions: held('sa') }));
      clock.now += 3;
      await pub.post('alpha', input('another session', { mentions: held('sb') }));
      await pub.post('alpha', input('working', { mentions: held('sa', 'working') }));
      await pub.post('general', input('approval', { mentions: held('sa', 'approval') }));
      await pub.post('beta', input('waiting', { mentions: held('sa', 'waiting') }));
      await pub.post('beta', input('by an agent', { authorKind: 'orchestrator', authorRef: 'sx', authorName: 'x', mentions: held('sa') }));
      await pub.post('beta', input('plain'));
      await rec('held for sa', pub.mentionsAcross({ sessionId: 'sa', states: ['held'] }));
      await rec('held for sb', pub.mentionsAcross({ sessionId: 'sb', states: ['held'] }));
      await rec('held for nobody', pub.mentionsAcross({ sessionId: 'nobody', states: ['held'] }));
      await rec('approval or waiting for sa', pub.mentionsAcross({ sessionId: 'sa', states: ['approval', 'waiting'] }));
      await rec('dropped for sa', pub.mentionsAcross({ sessionId: 'sa', states: ['dropped'] }));
      await rec('no state', pub.mentionsAcross({ sessionId: 'sa', states: [] }));
    });
    const names = (k: string): string[] => (t.get(k) as ChannelMessage[]).map((m) => `${m.channel}:${m.text}`);
    expect(names('held for sa')).toEqual(['alpha:alpha first', 'general:general second', 'beta:beta same moment']);
    expect(names('held for sb')).toEqual(['alpha:another session']);
    expect(t.get('held for nobody')).toEqual([]);
    expect(names('approval or waiting for sa')).toEqual(['general:approval', 'beta:waiting']);
    expect(t.get('dropped for sa')).toEqual([]);
    expect(t.get('no state')).toEqual([]);
  });

  onEachAdapter(o, 'finds the mentions across channels without reading the pages of a large history (#1213)', async (s) => {
    const clock = { now: T0 };
    const chat = s.chat({ now: () => clock.now });
    const pub = chat.public;
    await chat.channels.create({ name: 'alpha', createdBy: 'ed' }, T0);
    const held = (sessionId: string): ChannelPostInput['mentions'] => [{ sessionId, peerKey: 'k', typed: `${sessionId}@box`, state: 'held' }];
    const cost = async (): Promise<number> => {
      let best = Infinity;
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        for (let i = 0; i < 20; i++) await pub.mentionsAcross({ sessionId: 'sa', states: ['held'] });
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    for (let i = 0; i < 100; i++) await pub.post('general', input(`old ${i}`));
    await pub.post('alpha', input('held early', { mentions: held('sa') }));
    const small = await cost();
    for (let i = 0; i < 3000; i++) await pub.post(i % 2 ? 'alpha' : 'general', input(`later ${i}`));
    await pub.post('general', input('held late', { mentions: held('sa') }));
    await pub.post('alpha', input('held for another', { mentions: held('sb') }));
    const large = await cost();
    expect((await pub.mentionsAcross({ sessionId: 'sa', states: ['held'] })).map((x) => x.text)).toEqual(['held early', 'held late']);
    expect((await pub.mentionsAcross({ sessionId: 'sb', states: ['held'] })).length).toBe(1);
    expect(large).toBeLessThan(Math.max(small * 5, 250));
  }, 300_000);

  it('refuses the 51st channel besides General, and lets only 50 of 60 opened at once in', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const ch = s.chat({ now: () => T0 }).channels;
      const names = Array.from({ length: 60 }, (_, i) => `c${String(i).padStart(2, '0')}`);
      const results = await Promise.all(names.map((name) => ch.create({ name, createdBy: 'ed' }, T0)));
      await rec('accepted', results.filter((r) => r.ok).length);
      await rec('refused', results.filter((r) => !r.ok).map((r) => (r.ok ? '' : r.error)));
      await rec('count', ch.count());
      const first = (await ch.list())[0]!;
      await rec('remove one', ch.remove(first.name));
      await rec('create after a removal', ch.create({ name: 'after', createdBy: 'ed' }, T0 + 1).then((r) => r.ok));
      await rec('create over the limit again', ch.create({ name: 'over', createdBy: 'ed' }, T0 + 2));
      await rec('count (after)', ch.count());
    });
    expect(t.get('accepted')).toBe(50);
    expect(t.get('refused')).toEqual(Array(10).fill('limit-reached'));
    expect(t.get('count')).toBe(50);
    expect(t.get('create after a removal')).toBe(true);
    expect(t.get('create over the limit again')).toMatchObject({ ok: false, error: 'limit-reached' });
    expect(t.get('count (after)')).toBe(50);
  });

  it('agrees on every adapter that an issue is one link however it is typed: with or without the #, with spaces; a milestone in another case is the same link', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const ch = s.chat({ now: () => T0 }).channels;
      await rec('first', ch.create({ name: 'one', link: { kind: 'issue', ref: '#1035' }, createdBy: 'ed' }, T0));
      await rec('without the hash', ch.create({ name: 'two', link: { kind: 'issue', ref: '1035' }, createdBy: 'ed' }, T0 + 1));
      await rec('with spaces', ch.create({ name: 'three', link: { kind: 'issue', ref: ' #1035 ' }, createdBy: 'ed' }, T0 + 2));
      await rec('hash and space inside', ch.create({ name: 'four', link: { kind: 'issue', ref: '# 1035' }, createdBy: 'ed' }, T0 + 3));
      await rec('hash alone', ch.create({ name: 'five', link: { kind: 'issue', ref: '#' }, createdBy: 'ed' }, T0 + 4));
      await rec('hash and spaces alone', ch.create({ name: 'six', link: { kind: 'issue', ref: ' # ' }, createdBy: 'ed' }, T0 + 5));
      await rec('milestone', ch.create({ name: 'seven', link: { kind: 'milestone', ref: 'v1.7' }, createdBy: 'ed' }, T0 + 6));
      await rec('milestone in another case', ch.create({ name: 'eight', link: { kind: 'milestone', ref: ' V1.7 ' }, createdBy: 'ed' }, T0 + 7));
      await rec('a second hash is part of the reference', ch.create({ name: 'nine', link: { kind: 'issue', ref: '##5' }, createdBy: 'ed' }, T0 + 8));
      await rec('count', ch.count());
    });
    expect(t.get('first')).toMatchObject({ ok: true, channel: { link: { kind: 'issue', ref: '1035' } } });
    for (const k of ['without the hash', 'with spaces', 'milestone in another case']) expect(t.get(k), k).toMatchObject({ ok: false, error: 'link-taken' });
    expect(t.get('hash and space inside')).toMatchObject({ ok: false, error: 'link-taken' });
    for (const k of ['hash alone', 'hash and spaces alone']) expect(t.get(k), k).toMatchObject({ ok: false, error: 'invalid' });
    expect(t.get('milestone')).toMatchObject({ ok: true });
    expect(t.get('a second hash is part of the reference')).toMatchObject({ ok: true, channel: { link: { kind: 'issue', ref: '#5' } } });
    expect(t.get('count')).toBe(3);
  });

  it('lets two channels with the same new link open at once with exactly one winner', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const ch = s.chat({ now: () => T0 }).channels;
      const rs = await Promise.all(['x1', 'x2', 'x3'].map((name) => ch.create({ name, link: { kind: 'issue', ref: '#9' }, createdBy: 'ed' }, T0)));
      await rec('ok', rs.filter((r) => r.ok).length);
      await rec('errors', rs.filter((r) => !r.ok).map((r) => (r.ok ? '' : r.error)));
      await rec('count', ch.count());
    });
    expect(t.get('ok')).toBe(1);
    expect(t.get('errors')).toEqual(['link-taken', 'link-taken']);
    expect(t.get('count')).toBe(1);
  });

  it('keeps the channels a deleted person opened and every public message, and clears who opened them so a new person of the same name does not inherit the right to edit them', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const chat = s.chat({ now: () => clock.now });
      const ed = (await s.people.createPerson('Ed', null, T0)).person;
      await s.people.createPerson('Eve', null, T0);
      await chat.channels.create({ name: 'eds', createdBy: 'Ed' }, T0);
      await chat.channels.create({ name: 'eves', createdBy: 'Eve' }, T0);
      await chat.public.post('eds', input('ED POST'));
      await chat.public.post('general', input('ED IN GENERAL'));
      await rec('delete the person', s.people.deleteMany([ed.id]).then((r) => r.length));
      await rec('channels', chat.channels.list().then((l) => l.map((c) => [c.name, c.createdBy, c.createdByName])));
      await rec('messages in the channel', chat.public.page('eds', { limit: 10 }).then(texts));
      await rec('messages in General', chat.public.page('general', { limit: 10 }).then(texts));
    });
    expect(t.get('channels')).toEqual([['eds', '', 'Ed'], ['eves', 'eve', 'Eve']]);
    expect(t.get('messages in the channel')).toEqual(['ED POST']);
    expect(t.get('messages in General')).toEqual(['ED IN GENERAL']);
  });

  // Decision 61 stays true with channels: the audience is the table, so no private text can be in a public channel.
  onEachAdapter(o, 'never shows a group message or a direct message in any public channel, and never puts a public channel\'s message in a group or a conversation', async (s) => {
    const clock = { now: T0 };
    const { peers, a, b } = await setUp(s, clock);
    for (const [from, to] of [[a, b], [b, a]] as const) await peers.rights.setRight(ED_ID, from, to, 'send', ED);
    const dm = 'DM-NEVER-PUBLIC';
    await peers.messages.send('sa', 'beta@box-b', dm);
    await peers.messages.sendFromPerson({ ownerId: ED_ID, person: 'Ed', toSession: 'sb', withSession: 'sa', text: `${dm} from the person` });
    const chat = s.chat({ now: () => clock.now });
    await chat.channels.create({ name: 'open', createdBy: 'ed' }, T0);
    await chat.group.post(G, input('GROUP-NEVER-PUBLIC'));
    await chat.group.post({ owner: 'eve', groupId: 'g1' }, input('EVE-GROUP-NEVER-PUBLIC'));
    await chat.public.post('open', input('PUBLIC-OPEN-ONLY'));
    await chat.public.post('general', input('PUBLIC-GENERAL-ONLY'));
    const publicReads = JSON.stringify([
      await chat.public.page('open', { limit: 100 }), await chat.public.page('general', { limit: 100 }), await chat.public.page('group', { limit: 100 }),
      await chat.public.heldMentions('open', {}), await chat.channels.list(), await chat.channels.get('open'),
    ]);
    expect(publicReads).toContain('PUBLIC-OPEN-ONLY');
    expect(publicReads).toContain('PUBLIC-GENERAL-ONLY');
    expect(publicReads).not.toContain('NEVER-PUBLIC');
    expect(await chat.public.count('group')).toBe(0);
    await expect(chat.public.post('group', input('x'))).rejects.toThrow('There is no such public channel.');
    const private1 = JSON.stringify([await chat.group.page(G, { limit: 100 }), await peers.messages.conversation('sa', 'sb')]);
    expect(private1).not.toContain('PUBLIC-');
    // Removing a channel leaves every private text alone.
    await chat.channels.remove('open');
    expect(texts(await chat.group.page(G, { limit: 10 }))).toEqual(['GROUP-NEVER-PUBLIC']);
    expect((await peers.messages.conversation('sa', 'sb')).map((m) => m.text)).toContain(dm);
  });
}

/** One channel under test, group or public, with a second scope of the same table (another group, another channel) whose ids must not be reachable from the first. */
interface Surface {
  label: string;
  post: (i: ChannelPostInput) => Promise<ChannelMessage>;
  postElsewhere: (i: ChannelPostInput) => Promise<ChannelMessage>;
  page: (o: { before?: string | null; limit: number }) => Promise<ChannelPage>;
  setMention: (id: string, index: number, p: { state: MentionState; why?: string | null; copyId?: string | null }) => Promise<ChannelMessage | null>;
  edit: (id: string, x: { author: number; text: string; now: number }) => Promise<ChannelChange>;
  del: (id: string, x: { author: number; now: number }) => Promise<ChannelChange>;
  held: () => Promise<ChannelMessage[]>;
  count: () => Promise<number>;
  getMessage: (id: string) => Promise<ChannelMessage | null>;
}

async function surfaces(chat: ChatStoreApi): Promise<Surface[]> {
  const g = chat.group;
  const other = { owner: 'ed', groupId: 'g2' };
  await chat.channels.create({ name: 'dev', createdBy: 'ed' }, T0);
  await chat.channels.create({ name: 'ops', createdBy: 'ed' }, T0);
  const p = chat.public;
  return [
    {
      label: 'group', post: (i) => g.post(G, i), postElsewhere: (i) => g.post(other, i), page: (o) => g.page(G, o), setMention: (id, n, x) => g.setMention(G, id, n, x),
      edit: (id, x) => g.editMessage(G, id, x), del: (id, x) => g.deleteMessage(G, id, x), held: () => g.heldMentions(G, {}), count: () => g.count(G), getMessage: (id) => g.getMessage(G, id),
    },
    {
      label: 'public', post: (i) => p.post('dev', i), postElsewhere: (i) => p.post('ops', i), page: (o) => p.page('dev', o), setMention: (id, n, x) => p.setMention('dev', id, n, x),
      edit: (id, x) => p.editMessage('dev', id, x), del: (id, x) => p.deleteMessage('dev', id, x), held: () => p.heldMentions('dev', {}), count: () => p.count('dev'), getMessage: (id) => p.getMessage('dev', id),
    },
  ];
}

const ED_ID = 11;
const EVE_ID = 12;
/** A message a person wrote, with the id of the person (`people.id`) that the server gives. */
const mine = (text: string, over: Partial<ChannelPostInput> = {}): ChannelPostInput => input(text, { authorId: ED_ID, ...over });

const mention = (sessionId: string | null, state: MentionState): NonNullable<ChannelPostInput['mentions']>[number] => ({ sessionId, peerKey: sessionId ? 'k' : null, typed: `${sessionId ?? 'zoe'}@box`, state });

function chatChangeCases(o: Openers): void {
  it('edits and deletes the author\'s own message in place on every adapter, keeping its place in the pages and the count, for the group channel and a public channel (#1269)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const chat = s.chat({ now: () => clock.now });
      for (const c of await surfaces(chat)) {
        const L = c.label;
        clock.now = T0;
        const m1 = await c.post(mine('one'));
        // The author is found by id: the name on the row is not the name the person has now.
        const m2 = await c.post(mine('two', { authorRef: 'Ed', authorName: 'Edward', mentions: [mention(null, 'done')] }));
        const m3 = await c.post(input('three', { authorRef: 'eve', authorName: 'Eve', authorId: EVE_ID }));
        const m4 = await c.post(input('four', { authorKind: 'orchestrator', authorRef: 'sa', authorName: 'alpha', authorId: ED_ID }));
        const m5 = await c.post(mine('five'));
        const elsewhere = await c.postElsewhere(mine('elsewhere'));
        const noId = await c.post(input('no id'));
        await rec(`${L}: post stores the author id`, c.page({ limit: 50 }));
        clock.now += 10;
        await rec(`${L}: edit two`, c.edit(m2.id, { author: ED_ID, text: 'two edited', now: clock.now }));
        await rec(`${L}: page after edit`, c.page({ limit: 50 }));
        clock.now += 10;
        await rec(`${L}: delete one`, c.del(m1.id, { author: ED_ID, now: clock.now }));
        await rec(`${L}: page after delete`, c.page({ limit: 50 }));
        const p1 = await rec(`${L}: cursor page 1`, c.page({ limit: 2 }));
        const p2 = await rec(`${L}: cursor page 2`, c.page({ before: p1.older, limit: 2 }));
        await rec(`${L}: cursor page 3`, c.page({ before: p2.older, limit: 2 }));
        await rec(`${L}: count`, c.count());
        await rec(`${L}: edit unknown id`, c.edit('grp_00000000_000000000000000000000000', { author: ED_ID, text: 'x', now: clock.now }));
        await rec(`${L}: delete unknown id`, c.del('pub_00000000_000000000000000000000000', { author: ED_ID, now: clock.now }));
        await rec(`${L}: edit an id of the other scope`, c.edit(elsewhere.id, { author: ED_ID, text: 'x', now: clock.now }));
        await rec(`${L}: delete an id of the other scope`, c.del(elsewhere.id, { author: ED_ID, now: clock.now }));
        await rec(`${L}: edit a person's message with no author id`, c.edit(noId.id, { author: ED_ID, text: 'x', now: clock.now }));
        await rec(`${L}: delete a person's message with no author id`, c.del(noId.id, { author: 0, now: clock.now }));
        await rec(`${L}: edit another person's message`, c.edit(m3.id, { author: ED_ID, text: 'x', now: clock.now }));
        await rec(`${L}: delete another person's message`, c.del(m3.id, { author: ED_ID, now: clock.now }));
        await rec(`${L}: edit an orchestrator's message`, c.edit(m4.id, { author: ED_ID, text: 'x', now: clock.now }));
        await rec(`${L}: delete an orchestrator's message`, c.del(m4.id, { author: 99, now: clock.now }));
        await rec(`${L}: edit a tombstone`, c.edit(m1.id, { author: ED_ID, text: 'x', now: clock.now }));
        await rec(`${L}: delete a tombstone`, c.del(m1.id, { author: ED_ID, now: clock.now }));
        await rec(`${L}: edit a tombstone of someone else`, c.edit(m1.id, { author: EVE_ID, text: 'x', now: clock.now }));
        clock.now += 10;
        await rec(`${L}: edit five twice (first)`, c.edit(m5.id, { author: ED_ID, text: 'five v2', now: clock.now }));
        clock.now += 10;
        await rec(`${L}: edit five twice (second)`, c.edit(m5.id, { author: ED_ID, text: 'five v3', now: clock.now }));
        await rec(`${L}: page at the end`, c.page({ limit: 50 }));
      }
    });
    for (const L of ['group', 'public']) {
      const edited = t.get(`${L}: edit two`) as { ok: boolean; message: ChannelMessage };
      expect(edited.ok).toBe(true);
      expect(edited.message).toMatchObject({ text: 'two edited', editedAt: T0 + 10, deletedAt: null, createdAt: T0, updatedAt: T0 + 10, authorRef: 'Ed', authorName: 'Edward', authorId: ED_ID });
      const posted = t.get(`${L}: post stores the author id`) as ChannelPage;
      expect(posted.messages.map((m) => [m.text, m.authorId])).toEqual([['one', ED_ID], ['two', ED_ID], ['three', EVE_ID], ['four', null], ['five', ED_ID], ['no id', null]]);
      expect(edited.message.mentions).toEqual([{ sessionId: null, peerKey: null, typed: 'zoe@box', state: 'done', why: null, stateAt: T0 }]);
      const after = t.get(`${L}: page after edit`) as ChannelPage;
      expect(texts(after)).toEqual(['one', 'two edited', 'three', 'four', 'five', 'no id']);
      expect(after.messages.map((m) => m.editedAt)).toEqual([null, T0 + 10, null, null, null, null]);
      const del = t.get(`${L}: page after delete`) as ChannelPage;
      expect(texts(del)).toEqual(['', 'two edited', 'three', 'four', 'five', 'no id']);
      expect(del.messages[0]).toMatchObject({ text: '', mentions: [], deletedAt: T0 + 20, editedAt: null, updatedAt: T0 + 20, createdAt: T0, authorKind: 'person', authorRef: 'ed', authorName: 'Ed', authorId: ED_ID });
      expect(texts(t.get(`${L}: cursor page 1`) as ChannelPage)).toEqual(['five', 'no id']);
      expect(texts(t.get(`${L}: cursor page 2`) as ChannelPage)).toEqual(['three', 'four']);
      const last = t.get(`${L}: cursor page 3`) as ChannelPage;
      expect(texts(last)).toEqual(['', 'two edited']);
      expect(last.older).toBeNull();
      expect(t.get(`${L}: count`)).toBe(6);
      expect(t.get(`${L}: edit a person's message with no author id`)).toEqual({ ok: false, reason: 'not-yours' });
      expect(t.get(`${L}: delete a person's message with no author id`)).toEqual({ ok: false, reason: 'not-yours' });
      expect(t.get(`${L}: edit unknown id`)).toEqual({ ok: false, reason: 'not-found' });
      expect(t.get(`${L}: delete unknown id`)).toEqual({ ok: false, reason: 'not-found' });
      expect(t.get(`${L}: edit an id of the other scope`)).toEqual({ ok: false, reason: 'not-found' });
      expect(t.get(`${L}: delete an id of the other scope`)).toEqual({ ok: false, reason: 'not-found' });
      expect(t.get(`${L}: edit another person's message`)).toEqual({ ok: false, reason: 'not-yours' });
      expect(t.get(`${L}: delete another person's message`)).toEqual({ ok: false, reason: 'not-yours' });
      expect(t.get(`${L}: edit an orchestrator's message`)).toEqual({ ok: false, reason: 'not-yours' });
      expect(t.get(`${L}: delete an orchestrator's message`)).toEqual({ ok: false, reason: 'not-yours' });
      expect(t.get(`${L}: edit a tombstone`)).toEqual({ ok: false, reason: 'deleted' });
      expect(t.get(`${L}: delete a tombstone`)).toEqual({ ok: false, reason: 'deleted' });
      expect(t.get(`${L}: edit a tombstone of someone else`)).toEqual({ ok: false, reason: 'not-yours' });
      expect((t.get(`${L}: edit five twice (second)`) as { message: ChannelMessage }).message).toMatchObject({ text: 'five v3', editedAt: T0 + 40, updatedAt: T0 + 40, createdAt: T0 });
      const end = t.get(`${L}: page at the end`) as ChannelPage;
      expect(texts(end)).toEqual(['', 'two edited', 'three', 'four', 'five v3', 'no id']);
      expect(end.messages[2]).toMatchObject({ text: 'three', editedAt: null, deletedAt: null });
    }
  });

  it('locks a message for the person once it has been sent to an agent (waiting, working or done), and only then, on every adapter (#1269)', async () => {
    const free: MentionState[] = ['held', 'approval', 'not-delivered', 'dropped'];
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const chat = s.chat({ now: () => clock.now });
      for (const c of await surfaces(chat)) {
        const L = c.label;
        clock.now = T0;
        const by = async (label: string, mentions: ChannelPostInput['mentions']): Promise<ChannelMessage> => rec(`${L}: post ${label}`, c.post(mine(label, { mentions })));
        const queued = await by('waiting', [mention('sa', 'waiting')]);
        const working = await by('working', [mention('sa', 'working')]);
        const done = await by('done', [mention('sa', 'done')]);
        const mixed = await by('mixed', [mention('sa', 'held'), mention('sb', 'waiting')]);
        const none = await by('none', undefined);
        const people = await by('people', [mention(null, 'done')]);
        const ids = new Map<string, string>();
        for (const st of free) ids.set(st, (await by(st, [mention('sa', st)])).id);
        clock.now += 5;
        for (const m of [queued, working, done, mixed]) {
          await rec(`${L}: edit ${m.text}`, c.edit(m.id, { author: ED_ID, text: 'changed', now: clock.now }));
          await rec(`${L}: delete ${m.text}`, c.del(m.id, { author: ED_ID, now: clock.now }));
        }
        await rec(`${L}: page after locked`, c.page({ limit: 50 }));
        await rec(`${L}: edit none`, c.edit(none.id, { author: ED_ID, text: 'changed', now: clock.now }));
        await rec(`${L}: edit people`, c.edit(people.id, { author: ED_ID, text: 'changed', now: clock.now }));
        await rec(`${L}: delete people`, c.del(people.id, { author: ED_ID, now: clock.now }));
        for (const st of free) {
          await rec(`${L}: edit ${st}`, c.edit(ids.get(st) as string, { author: ED_ID, text: `edited ${st}`, now: clock.now }));
          await rec(`${L}: delete ${st}`, c.del(ids.get(st) as string, { author: ED_ID, now: clock.now }));
        }
        await rec(`${L}: page at the end`, c.page({ limit: 50 }));
      }
    });
    for (const L of ['group', 'public']) {
      for (const w of ['waiting', 'working', 'done', 'mixed']) {
        expect(t.get(`${L}: edit ${w}`)).toEqual({ ok: false, reason: 'locked' });
        expect(t.get(`${L}: delete ${w}`)).toEqual({ ok: false, reason: 'locked' });
      }
      const locked = t.get(`${L}: page after locked`) as ChannelPage;
      expect(texts(locked).slice(0, 4)).toEqual(['waiting', 'working', 'done', 'mixed']);
      expect(locked.messages.slice(0, 4).map((m) => [m.editedAt, m.deletedAt, m.updatedAt])).toEqual([[null, null, T0], [null, null, T0], [null, null, T0], [null, null, T0]]);
      expect(t.get(`${L}: edit none`)).toMatchObject({ ok: true, message: { text: 'changed', editedAt: T0 + 5 } });
      expect(t.get(`${L}: edit people`)).toMatchObject({ ok: true, message: { text: 'changed' } });
      expect(t.get(`${L}: delete people`)).toMatchObject({ ok: true, message: { text: '', mentions: [] } });
      for (const st of free) {
        expect(t.get(`${L}: edit ${st}`)).toMatchObject({ ok: true, message: { text: `edited ${st}`, editedAt: T0 + 5 } });
        const gone = t.get(`${L}: delete ${st}`) as { ok: boolean; message: ChannelMessage };
        expect(gone).toMatchObject({ ok: true, message: { text: '', mentions: [], deletedAt: T0 + 5 } });
      }
      const end = t.get(`${L}: page at the end`) as ChannelPage;
      expect(texts(end)).toEqual(['waiting', 'working', 'done', 'mixed', 'changed', '', '', '', '', '']);
    }
  });

  it('names the author by id, so a new person with the name of a deleted one cannot change what that person wrote in a public channel, on every adapter (#1269)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const pub = s.chat({ now: () => clock.now }).public;
      const first = (await s.people.createPerson('Zed')).person;
      const msg = await pub.post('general', input('mine', { authorRef: 'Zed', authorName: 'Zed', authorId: first.id }));
      await rec('edit by the author', pub.editMessage('general', msg.id, { author: first.id, text: 'mine, edited', now: T0 + 1 }));
      await s.people.deleteMany([first.id]);
      const again = (await s.people.createPerson('Zed')).person;
      await rec('a new id', again.id > first.id);
      await rec('the message after the person is gone', pub.page('general', { limit: 5 }).then((p) => p.messages.map((m) => [m.text, m.authorId === first.id, m.authorName])));
      await rec('edit by the new person of the same name', pub.editMessage('general', msg.id, { author: again.id, text: 'taken', now: T0 + 2 }));
      await rec('delete by the new person of the same name', pub.deleteMessage('general', msg.id, { author: again.id, now: T0 + 2 }));
    });
    expect(t.get('edit by the author')).toMatchObject({ ok: true, message: { text: 'mine, edited' } });
    expect(t.get('a new id')).toBe(true);
    expect(t.get('the message after the person is gone')).toEqual([['mine, edited', true, 'Zed']]);
    expect(t.get('edit by the new person of the same name')).toEqual({ ok: false, reason: 'not-yours' });
    expect(t.get('delete by the new person of the same name')).toEqual({ ok: false, reason: 'not-yours' });
  });

  onEachAdapter(o, 'never leaves a tombstone with a live mention or a locked message with its text deleted when a delivery and a delete race (#1269)', async (s) => {
    const clock = { now: T0 };
    const chat = s.chat({ now: () => clock.now });
    for (const c of await surfaces(chat)) {
      for (let i = 0; i < 12; i++) {
        const m = await c.post(mine(`race ${i}`, { mentions: [mention('sa', 'held')] }));
        clock.now += 1;
        const change = (): Promise<ChannelChange> => c.del(m.id, { author: ED_ID, now: clock.now });
        const deliver = (): Promise<ChannelMessage | null> => c.setMention(m.id, 0, { state: 'waiting' });
        const [a, b] = i % 2 === 0 ? await Promise.all([deliver(), change()]) : await Promise.all([change(), deliver()]);
        const [set, del] = i % 2 === 0 ? [a as ChannelMessage | null, b as ChannelChange] : [b as ChannelMessage | null, a as ChannelChange];
        const row = (await c.page({ limit: 100 })).messages.find((x) => x.id === m.id) as ChannelMessage;
        if (del.ok) {
          expect(set).toBeNull();
          expect(row).toMatchObject({ text: '', mentions: [], deletedAt: expect.any(Number) });
        } else {
          expect(del).toEqual({ ok: false, reason: 'locked' });
          expect(set).not.toBeNull();
          expect(row).toMatchObject({ text: `race ${i}`, deletedAt: null });
          expect(row.mentions[0]!.state).toBe('waiting');
        }
      }
    }
  });

  it('never gives a tombstone back as a held mention and takes no mention state on it, on every adapter (#1269)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const chat = s.chat({ now: () => clock.now });
      for (const c of await surfaces(chat)) {
        const L = c.label;
        clock.now = T0;
        const m = await c.post(mine('held text', { mentions: [mention('sa', 'held')] }));
        await rec(`${L}: held before`, c.held());
        clock.now += 1;
        await rec(`${L}: delete`, c.del(m.id, { author: ED_ID, now: clock.now }));
        await rec(`${L}: held after`, c.held());
        await rec(`${L}: setMention on the tombstone`, c.setMention(m.id, 0, { state: 'working' }));
        await rec(`${L}: page`, c.page({ limit: 5 }));
      }
      const across = await chat.public.post('dev', mine('across', { mentions: [mention('sa', 'approval')] }));
      clock.now += 1;
      await chat.public.deleteMessage('dev', across.id, { author: ED_ID, now: clock.now });
      await rec('public: mentionsAcross after delete', chat.public.mentionsAcross({ sessionId: 'sa', states: ['waiting', 'held', 'working', 'done', 'approval'] }));
    });
    for (const L of ['group', 'public']) {
      expect(texts({ messages: t.get(`${L}: held before`) as ChannelMessage[], older: null })).toEqual(['held text']);
      expect(t.get(`${L}: held after`)).toEqual([]);
      expect(t.get(`${L}: setMention on the tombstone`)).toBeNull();
      expect((t.get(`${L}: page`) as ChannelPage).messages[0]).toMatchObject({ text: '', mentions: [], deletedAt: T0 + 1 });
    }
    expect(t.get('public: mentionsAcross after delete')).toEqual([]);
  });
  it('keeps the id of the copy a mention waits on across later state changes, reads one message by id in its scope, and shows no copy on a tombstone or an old row, on every adapter (#1269)', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const clock = { now: T0 };
      const chat = s.chat({ now: () => clock.now });
      for (const c of await surfaces(chat)) {
        const L = c.label;
        clock.now = T0;
        const old = await c.post(mine('an old row', { mentions: [{ ...mention('sa', 'approval') }] }));
        const m = await c.post(mine('with a copy', { mentions: [{ ...mention('sa', 'approval'), copyId: 'peer_copy_1' }, mention(null, 'done')] }));
        const elsewhere = await c.postElsewhere(mine('in another place'));
        await rec(`${L}: read`, c.page({ limit: 5 }));
        clock.now += 1;
        await rec(`${L}: patch sets the copy`, c.setMention(old.id, 0, { state: 'approval', why: 'Waiting for eve', copyId: 'peer_copy_0' }));
        await rec(`${L}: state change keeps it`, c.setMention(m.id, 0, { state: 'approval', why: 'still waiting' }));
        await rec(`${L}: another copy replaces it`, c.setMention(m.id, 0, { state: 'approval', copyId: 'peer_copy_2' }));
        await rec(`${L}: waiting keeps it`, c.setMention(m.id, 0, { state: 'waiting' }));
        await rec(`${L}: the other mention has none`, c.getMessage(m.id));
        await rec(`${L}: getMessage of another place`, c.getMessage(elsewhere.id));
        await rec(`${L}: getMessage of nothing`, c.getMessage('pub_00000000_000000000000000000000000'));
        clock.now += 1;
        const gone = await c.post(mine('to delete', { mentions: [{ ...mention('sb', 'approval'), copyId: 'peer_copy_3' }] }));
        await rec(`${L}: delete`, c.del(gone.id, { author: ED_ID, now: clock.now }));
        await rec(`${L}: getMessage of a tombstone`, c.getMessage(gone.id));
      }
    });
    for (const L of ['group', 'public']) {
      const read = (t.get(`${L}: read`) as ChannelPage).messages;
      expect(read[0]!.mentions[0]).not.toHaveProperty('copyId');
      expect(read[1]!.mentions[0]).toMatchObject({ state: 'approval', copyId: 'peer_copy_1' });
      expect(read[1]!.mentions[1]).not.toHaveProperty('copyId');
      expect((t.get(`${L}: patch sets the copy`) as ChannelMessage).mentions[0]).toMatchObject({ state: 'approval', why: 'Waiting for eve', copyId: 'peer_copy_0' });
      expect((t.get(`${L}: state change keeps it`) as ChannelMessage).mentions[0]).toMatchObject({ why: 'still waiting', copyId: 'peer_copy_1' });
      expect((t.get(`${L}: another copy replaces it`) as ChannelMessage).mentions[0]).toMatchObject({ copyId: 'peer_copy_2' });
      expect((t.get(`${L}: waiting keeps it`) as ChannelMessage).mentions[0]).toMatchObject({ state: 'waiting', copyId: 'peer_copy_2' });
      expect(t.get(`${L}: getMessage of another place`)).toBeNull();
      expect(t.get(`${L}: getMessage of nothing`)).toBeNull();
      expect(t.get(`${L}: getMessage of a tombstone`)).toMatchObject({ text: '', mentions: [], deletedAt: expect.any(Number) });
      expect(JSON.stringify(t.get(`${L}: getMessage of a tombstone`))).not.toContain('peer_copy_3');
      expect(t.get(`${L}: the other mention has none`)).toMatchObject({ text: 'with a copy' });
    }
  });

}
