// Contract cases for the Chat page's stores (#1034): the group channel (`group_messages`), General (`public_messages`) and the per-person,
// per-thread read state. Each runs one scenario over every adapter (`sameOnAll`) and states the values it expects. The rule they hold:
// a channel's text is never kept with, copied into or returned with a direct message's (`peer_messages`), and the reverse.
import { expect, it } from 'vitest';
import { onEachAdapter, sameOnAll, type Openers } from './contractSame.js';
import type { ChannelMessage, ChannelPage, ChannelPostInput } from './types.js';
import { setUp } from './contractPeers.js';

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const ED = { name: 'ed', admin: false };

const G = { owner: 'ed', groupId: 'g1' };
const input = (text: string, over: Partial<ChannelPostInput> = {}): ChannelPostInput => ({ authorKind: 'person', authorRef: 'ed', authorName: 'Ed', text, ...over });
const texts = (p: ChannelPage): string[] => p.messages.map((m) => m.text);

export function chatCases(o: Openers): void {
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
      for (const text of ['a', 'b', 'c']) await rec(`post ${text}`, pub.post(input(text)));
      clock.now += DAY;
      await rec('post d', pub.post(input('d', { authorKind: 'reporter', authorRef: 'k-a', authorName: 'box-a', mentions: [{ sessionId: 'sa', peerKey: 'k-a', typed: 'alpha@box-a' }] })));
      const p1 = await rec('page 1', pub.page({ limit: 3 }));
      await rec('page 2', pub.page({ before: p1.older, limit: 3 }));
      await rec('page (bad cursor)', pub.page({ before: '12.x', limit: 3 }));
      await rec('count', pub.count());
      const d = (await pub.page({ limit: 1 })).messages[0]!;
      await rec('mention: done', pub.setMention(d.id, 0, { state: 'done' }));
      await rec('mention: no such message', pub.setMention('pub_00000000_000000000000000000000000', 0, { state: 'done' }));
      await rec('purge (older than a day)', pub.purge(T0 + DAY));
      await rec('page (after purge)', pub.page({ limit: 10 }));
      await rec('clear', pub.clear());
      await rec('count (cleared)', pub.count());
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
      await rec('forget the thread', rs.forget('public'));
      await rec('list (after forget)', rs.list('ed'));
      await rec('list (another person, after forget)', rs.list('eve'));
    });
    expect(t.get('get (never seen)')).toEqual({ person: 'ed', thread: 'public', lastRead: null, unread: 0, mentions: 0, updatedAt: 0 });
    expect(t.get('bump (a mention)')).toEqual({ person: 'ed', thread: 'public', lastRead: null, unread: 3, mentions: 1, updatedAt: T0 + 1 });
    expect((t.get('list') as { thread: string }[]).map((r) => r.thread)).toEqual(['group:g1', 'public']);
    expect(t.get('get (read)')).toEqual({ person: 'ed', thread: 'public', lastRead: '1800000000005.7', unread: 0, mentions: 0, updatedAt: T0 + 2 });
    expect((t.get('list (after)') as { thread: string }[]).map((r) => r.thread)).toEqual(['dm:a|b', 'group:g1', 'public']);
    expect(t.get('forget the thread')).toBe(2);
    expect((t.get('list (after forget)') as { thread: string }[]).map((r) => r.thread)).toEqual(['dm:a|b', 'group:g1']);
    expect(t.get('list (another person, after forget)')).toEqual([]);
  });

  onEachAdapter(o, 'mints the server scope once and keeps it, and puts it in every channel message id', async (s) => {
    const chat = s.chat({ now: () => T0 });
    const scope = await chat.serverScope();
    expect(scope).toMatch(/^[0-9a-f]{8}$/);
    expect(await chat.serverScope()).toBe(scope);
    expect(await s.chat({ now: () => T0 + 1 }).serverScope()).toBe(scope);
    const g = await chat.group.post(G, input('x'));
    const p = await chat.public.post(input('y'));
    expect(g.id).toMatch(new RegExp(`^grp_${scope}_[0-9a-f]{24}$`));
    expect(p.id).toMatch(new RegExp(`^pub_${scope}_[0-9a-f]{24}$`));
    expect(new Set([g.id, (await chat.group.post(G, input('z'))).id]).size).toBe(2);
  });

  // The hard rule of the Chat page: three tables, one per audience, so a missed filter cannot leak one audience's text to another.
  onEachAdapter(o, 'never returns a direct message from a channel read, nor a channel message from a direct message read', async (s) => {
    const clock = { now: T0 };
    const { peers, a, b } = await setUp(s, clock);
    for (const [from, to] of [[a, b], [b, a]] as const) await peers.rights.setRight('ed', from, to, 'send', ED);
    const dm = 'DIRECT-ONLY-TEXT';
    await peers.messages.send('sa', 'beta@box-b', dm);
    await peers.messages.sendFromPerson({ owner: 'ed', person: 'Ed', toSession: 'sb', withSession: 'sa', text: `${dm} from the person` });
    const chat = s.chat({ now: () => clock.now });
    await chat.group.post(G, input('GROUP-ONLY-TEXT'));
    await chat.public.post(input('PUBLIC-ONLY-TEXT'));
    await chat.readState.bump('ed', 'public', true);
    const channelReads = JSON.stringify([
      await chat.group.page(G, { limit: 100 }), await chat.group.count(G), await chat.public.page({ limit: 100 }), await chat.public.count(),
      await chat.readState.list('ed'),
    ]);
    expect(channelReads).not.toContain(dm);
    expect(channelReads).toContain('GROUP-ONLY-TEXT');
    expect(channelReads).toContain('PUBLIC-ONLY-TEXT');
    const dmReads = JSON.stringify([
      await peers.messages.page('ed', 'sa', 'sb', { limit: 100 }), await peers.messages.conversation('sa', 'sb'), await peers.messages.ownerConversations('ed'),
      await peers.messages.conversations({}),
    ]);
    expect(dmReads).toContain(dm);
    expect(dmReads).not.toContain('GROUP-ONLY-TEXT');
    expect(dmReads).not.toContain('PUBLIC-ONLY-TEXT');
    // Clearing a channel leaves the direct messages alone, and deleting a conversation leaves the channels alone.
    await chat.group.clear(G);
    await chat.public.clear();
    expect((await peers.messages.conversation('sa', 'sb')).map((m) => m.text)).toEqual([dm, `${dm} from the person`]);
    await chat.group.post(G, input('kept'));
    await peers.messages.deleteConversation('ed', 'sa', 'sb');
    expect(texts(await chat.group.page(G, { limit: 10 }))).toEqual(['kept']);
  });
}
