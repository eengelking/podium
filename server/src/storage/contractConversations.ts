// Contract cases for the conversations of people and agents (#1278, DECISIONS 74): `conversations`, `conversation_members` and `conversation_messages`. Each runs one scenario over
// every adapter (`sameOnAll`), so every value is the same on all of them, and states the values it expects. The rule they hold: a conversation's text is never kept with,
// copied into or returned with a channel's or a `peer_messages` row.
import { expect, it } from 'vitest';
import { onEachAdapter, sameOnAll, type Openers } from './contractSame.js';
import { counted } from './statementCount.js';
import type { Conversation, ConversationChange, ConversationMemberInput, ConversationMessage, ConversationPage } from './types.js';

const T0 = 1_800_000_000_000;
const ED: ConversationMemberInput = { kind: 'person', ref: '1', name: 'Ed' };
const MAYA: ConversationMemberInput = { kind: 'person', ref: '2', name: 'Maya Kim' };
const JO: ConversationMemberInput = { kind: 'person', ref: '3', name: 'Jo Okafor' };
const TESTER: ConversationMemberInput = { kind: 'agent', ref: 'sess-tester', name: 'Tester' };
const say = (m: ConversationMemberInput, text: string, over: Record<string, unknown> = {}): { authorKind: 'person' | 'agent'; authorRef: string; authorName: string; authorId: number | null; text: string } & Record<string, unknown> => ({
  authorKind: m.kind, authorRef: m.ref, authorName: m.name, authorId: m.kind === 'person' ? Number(m.ref) : null, text, ...over,
});
const texts = (p: ConversationPage): string[] => p.messages.map((m) => m.text);

export function conversationCases(o: Openers): void {
  it('agrees on every adapter for opening: one conversation for a set of members, in any order, and the refusals', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const c = s.chat({ now: () => T0 }).conversations;
      const a = await rec('open ed and maya', c.open({ members: [ED, MAYA], createdBy: 1 }, T0));
      await rec('open again, the other way round', c.open({ members: [MAYA, ED], createdBy: 2 }, T0 + 5));
      await rec('open with a name changed (the same people)', c.open({ members: [ED, { ...MAYA, name: 'M. Kim' }], createdBy: 1 }, T0 + 6));
      await rec('open three people', c.open({ members: [ED, MAYA, JO], createdBy: 1 }, T0 + 10));
      await rec('open two people and an agent', c.open({ members: [ED, MAYA, TESTER], createdBy: 1 }, T0 + 20));
      await rec('open a person and an agent', c.open({ members: [ED, TESTER], createdBy: 1 }, T0 + 30));
      await rec('open with a repeated member', c.open({ members: [ED, ED, JO], createdBy: 1 }, T0 + 40));
      await rec('open with one member', c.open({ members: [ED], createdBy: 1 }, T0 + 50));
      await rec('open with no person', c.open({ members: [TESTER, { kind: 'agent', ref: 'sess-b', name: 'b' }], createdBy: 1 }, T0 + 50));
      await rec('open with a bad kind', c.open({ members: [ED, { kind: 'robot' as never, ref: 'x', name: 'x' }], createdBy: 1 }, T0 + 50));
      await rec('open with a person who is not an id', c.open({ members: [ED, { kind: 'person', ref: 'maya', name: 'Maya' }], createdBy: 1 }, T0 + 50));
      await rec('open with an empty name', c.open({ members: [ED, { kind: 'person', ref: '9', name: ' ' }], createdBy: 1 }, T0 + 50));
      const many = Array.from({ length: 51 }, (_, i) => ({ kind: 'person' as const, ref: String(100 + i), name: `p${i}` }));
      await rec('open with 51 members', c.open({ members: many, createdBy: 1 }, T0 + 50));
      await rec('open with 50 members', c.open({ members: many.slice(0, 50), createdBy: 100 }, T0 + 60));
      await rec('get', c.get(a.conversation.id));
      await rec('get (no such conversation)', c.get('cnv_00000000_000000000000000000000000'));
    });
    const first = t.get('open ed and maya') as { conversation: Conversation; created: boolean };
    expect(first.created).toBe(true);
    expect(first.conversation.members.map((m) => [m.kind, m.ref, m.name, m.addedBy, m.joinedAt, m.leftAt])).toEqual([
      ['person', '1', 'Ed', null, T0, null],
      ['person', '2', 'Maya Kim', 1, T0, null],
    ]);
    expect(first.conversation).toMatchObject({ createdAt: T0, lastAt: T0, messages: 0 });
    expect(t.get('open again, the other way round')).toMatchObject({ created: false });
    expect(t.get('open with a name changed (the same people)')).toMatchObject({ created: false });
    expect(t.get('open three people')).toMatchObject({ created: true });
    expect(t.get('open two people and an agent')).toMatchObject({ created: true });
    expect(t.get('open with a repeated member')).toMatchObject({ created: true });
    expect(t.get('open with one member')).toEqual({ threw: 'A conversation has at least two members.' });
    expect(t.get('open with no person')).toEqual({ threw: 'A conversation has at least one person.' });
    expect(t.get('open with a bad kind')).toEqual({ threw: 'A member is a person or an agent.' });
    expect(t.get('open with a person who is not an id')).toEqual({ threw: 'A person is named by their id.' });
    expect(t.get('open with an empty name')).toEqual({ threw: 'A member needs a reference and a name.' });
    expect(t.get('open with 51 members')).toEqual({ threw: 'A conversation has at most 50 members.' });
    expect(t.get('open with 50 members')).toMatchObject({ created: true });
    expect(t.get('get (no such conversation)')).toBeNull();
  });

  it('agrees on every adapter for members: who is in a conversation, adding, leaving, coming back, and a conversation with no person left', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const c = s.chat({ now: () => T0 }).conversations;
      const { conversation: dm } = await c.open({ members: [ED, MAYA], createdBy: 1 }, T0);
      await rec('post (so the conversation has a time)', c.post(dm.id, say(ED, 'hi'), T0 + 100));
      const { conversation: other } = await c.open({ members: [ED, JO], createdBy: 1 }, T0 + 10);
      await rec('post (in the other)', c.post(other.id, say(JO, 'later'), T0 + 200));
      await rec('listFor ed (newest activity first)', c.listFor({ kind: 'person', ref: '1' }));
      await rec('listFor maya', c.listFor({ kind: 'person', ref: '2' }));
      await rec('listFor nobody', c.listFor({ kind: 'person', ref: '77' }));
      await rec('listFor an agent that is in none', c.listFor({ kind: 'agent', ref: 'sess-tester' }));
      await rec('add jo and the agent', c.addMembers(dm.id, [JO, TESTER], 1, T0 + 300));
      await rec('listFor the agent', c.listFor({ kind: 'agent', ref: 'sess-tester' }));
      await rec('open ed, maya, jo and the agent finds it', c.open({ members: [TESTER, JO, MAYA, ED], createdBy: 2 }, T0 + 310));
      await rec('add someone already in (nothing changes)', c.addMembers(dm.id, [JO], 2, T0 + 320));
      await rec('add to no such conversation', c.addMembers('cnv_00000000_000000000000000000000000', [JO], 1, T0 + 320));
      await rec('add a bad member', c.addMembers(dm.id, [{ kind: 'person', ref: 'x', name: 'x' }], 1, T0 + 320));
      const crowd = Array.from({ length: 50 }, (_, i) => ({ kind: 'person' as const, ref: String(200 + i), name: `p${i}` }));
      await rec('add past 50 members', c.addMembers(dm.id, crowd, 1, T0 + 330));
      await rec('maya leaves', c.leave(dm.id, { kind: 'person', ref: '2' }, T0 + 400));
      await rec('maya leaves again', c.leave(dm.id, { kind: 'person', ref: '2' }, T0 + 410));
      await rec('maya has no conversation', c.listFor({ kind: 'person', ref: '2' }));
      await rec('maya cannot post', c.post(dm.id, say(MAYA, 'still here?'), T0 + 420));
      await rec('maya is added back', c.addMembers(dm.id, [{ ...MAYA, name: 'Maya K.' }], 3, T0 + 500));
      await rec('the agent leaves', c.leave(dm.id, { kind: 'agent', ref: 'sess-tester' }, T0 + 510));
      await rec('someone who is not in it leaves', c.leave(dm.id, { kind: 'person', ref: '55' }, T0 + 520));
      await rec('leave a conversation that does not exist', c.leave('cnv_00000000_000000000000000000000000', { kind: 'person', ref: '1' }, T0 + 520));
      await rec('ed leaves', c.leave(dm.id, { kind: 'person', ref: '1' }, T0 + 600));
      await rec('maya leaves', c.leave(dm.id, { kind: 'person', ref: '2' }, T0 + 610));
      await rec('jo is the last person, and leaves', c.leave(dm.id, { kind: 'person', ref: '3' }, T0 + 620));
      await rec('get (deleted with no person left)', c.get(dm.id));
      await rec('page (deleted with no person left)', c.page(dm.id, { limit: 50 }));
    });
    const mine = t.get('listFor ed (newest activity first)') as Conversation[];
    expect(mine.map((x) => x.members.map((m) => m.name).join('+'))).toEqual(['Ed+Jo Okafor', 'Ed+Maya Kim']);
    expect(mine.map((x) => x.lastAt)).toEqual([T0 + 200, T0 + 100]);
    expect(t.get('listFor nobody')).toEqual([]);
    const added = t.get('add jo and the agent') as Conversation;
    expect(added.members).toHaveLength(4);
    expect(t.get('open ed, maya, jo and the agent finds it')).toMatchObject({ created: false });
    expect(t.get('add to no such conversation')).toBeNull();
    expect(t.get('add a bad member')).toEqual({ threw: 'A person is named by their id.' });
    expect(t.get('add past 50 members')).toEqual({ threw: 'A conversation has at most 50 members.' });
    expect(t.get('maya leaves')).toMatchObject({ deleted: false });
    expect(t.get('maya leaves again')).toBeNull();
    expect(t.get('maya has no conversation')).toEqual([]);
    expect(t.get('maya cannot post')).toBeNull();
    const back = (t.get('maya is added back') as Conversation).members.find((m) => m.ref === '2');
    expect(back).toMatchObject({ name: 'Maya K.', addedBy: 3, joinedAt: T0 + 500, leftAt: null });
    expect(t.get('someone who is not in it leaves')).toBeNull();
    expect(t.get('leave a conversation that does not exist')).toBeNull();
    expect(t.get('jo is the last person, and leaves')).toEqual({ conversation: null, deleted: true });
    expect(t.get('get (deleted with no person left)')).toBeNull();
    expect((t.get('page (deleted with no person left)') as ConversationPage).messages).toEqual([]);
  });

  it('agrees on every adapter for messages: posting, paging with a cursor, the author changing their own, and what a handed message cannot do', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const c = s.chat({ now: () => T0 }).conversations;
      const { conversation: dm } = await c.open({ members: [ED, MAYA, TESTER], createdBy: 1 }, T0);
      const { conversation: other } = await c.open({ members: [ED, JO], createdBy: 1 }, T0);
      for (const text of ['one', 'two', 'three']) await rec(`post ${text}`, c.post(dm.id, say(ED, text), T0 + 10));
      const four = await rec('post four (the agent)', c.post(dm.id, say(TESTER, 'four'), T0 + 20));
      await rec('post five (a reply)', c.post(dm.id, say(MAYA, 'five', { replyTo: (four as ConversationMessage).id }), T0 + 30));
      await rec('post by someone who is not in it', c.post(dm.id, say(JO, 'six'), T0 + 40));
      await rec('post to no such conversation', c.post('cnv_00000000_000000000000000000000000', say(ED, 'seven'), T0 + 40));
      await rec('post with a bad author kind', c.post(dm.id, say(ED, 'eight', { authorKind: 'robot' }) as never, T0 + 40));
      await rec('post in the other conversation', c.post(other.id, say(JO, 'elsewhere'), T0 + 50));
      const p1 = await rec('page 1', c.page(dm.id, { limit: 2 }));
      await rec('page 2', c.page(dm.id, { before: p1.older, limit: 2 }));
      const p2 = await c.page(dm.id, { before: p1.older, limit: 2 });
      await rec('page 3', c.page(dm.id, { before: p2.older, limit: 2 }));
      await rec('page (everything)', c.page(dm.id, { limit: 50 }));
      await rec('page (the other conversation)', c.page(other.id, { limit: 50 }));
      await rec('page (bad cursor)', c.page(dm.id, { before: 'junk', limit: 2 }));
      const all = (await c.page(dm.id, { limit: 50 })).messages;
      const one = all[0] as ConversationMessage;
      await rec('getMessage', c.getMessage(dm.id, one.id));
      await rec('getMessage (in another conversation)', c.getMessage(other.id, one.id));
      await rec('edit (not yours)', c.editMessage(dm.id, one.id, { author: 2, text: 'mine now', now: T0 + 100 }));
      await rec('edit (an agent wrote it)', c.editMessage(dm.id, (four as ConversationMessage).id, { author: 1, text: 'x', now: T0 + 100 }));
      await rec('edit (no such message)', c.editMessage(dm.id, 'cmg_00000000_000000000000000000000000', { author: 1, text: 'x', now: T0 + 100 }));
      await rec('edit (in another conversation)', c.editMessage(other.id, one.id, { author: 1, text: 'x', now: T0 + 100 }));
      await rec('edit', c.editMessage(dm.id, one.id, { author: 1, text: 'one, changed', now: T0 + 110 }));
      await rec('markHanded', c.markHanded(dm.id, one.id, T0 + 120));
      await rec('markHanded (again keeps the first time)', c.markHanded(dm.id, one.id, T0 + 130));
      await rec('markHanded (no such message)', c.markHanded(dm.id, 'cmg_00000000_000000000000000000000000', T0 + 130));
      await rec('edit (handed)', c.editMessage(dm.id, one.id, { author: 1, text: 'too late', now: T0 + 140 }));
      await rec('delete (handed)', c.deleteMessage(dm.id, one.id, { author: 1, now: T0 + 140 }));
      const two = all[1] as ConversationMessage;
      await rec('delete', c.deleteMessage(dm.id, two.id, { author: 1, now: T0 + 150 }));
      await rec('delete again', c.deleteMessage(dm.id, two.id, { author: 1, now: T0 + 160 }));
      await rec('edit (deleted)', c.editMessage(dm.id, two.id, { author: 1, text: 'x', now: T0 + 170 }));
      await rec('page after the changes', c.page(dm.id, { limit: 50 }));
      await rec('listFor shows the count and the last time', c.listFor({ kind: 'person', ref: '1' }));
      await rec('purge (nothing that old)', c.purge(T0));
      await rec('purge (the first three)', c.purge(T0 + 15));
      await rec('page after purge', c.page(dm.id, { limit: 50 }));
      await rec('get after purge (stays, empty of old messages)', c.get(dm.id));
    });
    expect(texts(t.get('page (everything)') as ConversationPage)).toEqual(['one', 'two', 'three', 'four', 'five']);
    expect(texts(t.get('page 1') as ConversationPage)).toEqual(['four', 'five']);
    expect(texts(t.get('page 2') as ConversationPage)).toEqual(['two', 'three']);
    expect(texts(t.get('page 3') as ConversationPage)).toEqual(['one']);
    expect((t.get('page 3') as ConversationPage).older).toBeNull();
    expect(texts(t.get('page (the other conversation)') as ConversationPage)).toEqual(['elsewhere']);
    expect(t.get('page (bad cursor)')).toEqual({ threw: 'The cursor is not one this server gave out.' });
    const msgs = (t.get('page (everything)') as ConversationPage).messages;
    expect(msgs[3]).toMatchObject({ authorKind: 'agent', authorRef: 'sess-tester', authorName: 'Tester', authorId: null, createdAt: T0 + 20, replyTo: null, editedAt: null, deletedAt: null, handedAt: null });
    expect(msgs[4]).toMatchObject({ authorKind: 'person', authorRef: '2', authorId: 2 });
    expect(msgs[0]).toMatchObject({ authorKind: 'person', authorRef: '1', authorId: 1, createdAt: T0 + 10 });
    expect(t.get('post by someone who is not in it')).toBeNull();
    expect(t.get('post to no such conversation')).toBeNull();
    expect(t.get('post with a bad author kind')).toEqual({ threw: 'A message is written by a person or an agent.' });
    expect(t.get('getMessage (in another conversation)')).toBeNull();
    expect(t.get('edit (not yours)')).toEqual({ ok: false, reason: 'not-yours' } satisfies ConversationChange);
    expect(t.get('edit (an agent wrote it)')).toEqual({ ok: false, reason: 'not-yours' });
    expect(t.get('edit (no such message)')).toEqual({ ok: false, reason: 'not-found' });
    expect(t.get('edit (in another conversation)')).toEqual({ ok: false, reason: 'not-found' });
    expect(t.get('edit')).toMatchObject({ ok: true, message: { text: 'one, changed', editedAt: T0 + 110, updatedAt: T0 + 110, createdAt: T0 + 10 } });
    expect(t.get('markHanded')).toMatchObject({ handedAt: T0 + 120 });
    expect(t.get('markHanded (again keeps the first time)')).toMatchObject({ handedAt: T0 + 120 });
    expect(t.get('markHanded (no such message)')).toBeNull();
    expect(t.get('edit (handed)')).toEqual({ ok: false, reason: 'locked' });
    expect(t.get('delete (handed)')).toEqual({ ok: false, reason: 'locked' });
    expect(t.get('delete')).toMatchObject({ ok: true, message: { text: '', deletedAt: T0 + 150, updatedAt: T0 + 150 } });
    expect(t.get('delete again')).toEqual({ ok: false, reason: 'deleted' });
    expect(t.get('edit (deleted)')).toEqual({ ok: false, reason: 'deleted' });
    expect(texts(t.get('page after the changes') as ConversationPage)).toEqual(['one, changed', '', 'three', 'four', 'five']);
    expect((t.get('listFor shows the count and the last time') as Conversation[]).map((x) => [x.messages, x.lastAt])).toEqual([[1, T0 + 50], [5, T0 + 30]].sort((a, b) => (b[1] as number) - (a[1] as number)));
    expect(t.get('purge (nothing that old)')).toBe(0);
    expect(t.get('purge (the first three)')).toBe(3);
    expect(texts(t.get('page after purge') as ConversationPage)).toEqual(['four', 'five']);
    expect(t.get('get after purge (stays, empty of old messages)')).not.toBeNull();
  });

  it('agrees on every adapter for who a message was for (#1282): the members it named, what became of it for each agent, and what removing takes with it', async () => {
    const HAIKU: ConversationMemberInput = { kind: 'agent', ref: 'sess-notes', name: 'infra-notes' };
    const t = await sameOnAll(o, async (s, rec) => {
      const c = s.chat({ now: () => T0 }).conversations;
      const { conversation: dm } = await c.open({ members: [ED, MAYA, TESTER, HAIKU], createdBy: 1 }, T0);
      const target = (m: ConversationMemberInput, named: boolean) => ({ kind: m.kind, ref: m.ref, name: m.name, named });
      await rec('post to everyone', c.post(dm.id, say(ED, 'all', { targets: [target(HAIKU, false), target(TESTER, false)] }), T0 + 10));
      const one = await rec('post to one agent', c.post(dm.id, say(ED, 'one', { targets: [target(TESTER, true)] }), T0 + 20)) as ConversationMessage;
      const per = await rec('post to a person', c.post(dm.id, say(ED, 'person', { targets: [target(MAYA, true)] }), T0 + 30)) as ConversationMessage;
      await rec('post with no targets', c.post(dm.id, say(ED, 'plain'), T0 + 40));
      await rec('post to someone who is not a member', c.post(dm.id, say(ED, 'out', { targets: [target(JO, true)] }), T0 + 50));
      await rec('post to oneself', c.post(dm.id, say(ED, 'self', { targets: [target(ED, true)] }), T0 + 50));
      await rec('post to a bad kind', c.post(dm.id, say(ED, 'bad', { targets: [{ kind: 'robot' as never, ref: 'x', name: 'x', named: true }] }), T0 + 50));
      await rec('post to the same one twice', c.post(dm.id, say(ED, 'twice', { targets: [target(TESTER, true), target(TESTER, true)] }), T0 + 60));
      await rec('page shows who it was for', c.page(dm.id, { limit: 50 }));
      await rec('delivered', c.setDelivery(dm.id, one.id, { kind: 'agent', ref: 'sess-tester' }, 'delivered', T0 + 70));
      await rec('dropped after delivered stays delivered', c.setDelivery(dm.id, one.id, { kind: 'agent', ref: 'sess-tester' }, 'dropped', T0 + 80));
      await rec('queued cannot be set', c.setDelivery(dm.id, one.id, { kind: 'agent', ref: 'sess-tester' }, 'queued', T0 + 90));
      await rec('a person has no state to move', c.setDelivery(dm.id, per.id, { kind: 'person', ref: '2' }, 'delivered', T0 + 90));
      await rec('no such delivery', c.setDelivery(dm.id, one.id, { kind: 'agent', ref: 'sess-notes' }, 'delivered', T0 + 90));
      await rec('no such message', c.setDelivery(dm.id, 'cmg_00000000_000000000000000000000000', { kind: 'agent', ref: 'sess-tester' }, 'delivered', T0 + 90));
      await rec('dropped', c.setDelivery(dm.id, (await c.page(dm.id, { limit: 50 })).messages[0]!.id, { kind: 'agent', ref: 'sess-notes' }, 'dropped', T0 + 100));
      await rec('purge the oldest', c.purge(T0 + 15));
      await rec('page after purge', c.page(dm.id, { limit: 50 }));
      await rec('remove', c.remove(dm.id));
      await rec('post after remove', c.post(dm.id, say(ED, 'gone', { targets: [] }), T0 + 200));
    });
    const page = t.get('page shows who it was for') as ConversationPage;
    const by = Object.fromEntries(page.messages.map((m) => [m.text, m.deliveries]));
    expect(by['all']).toEqual([
      { kind: 'agent', ref: 'sess-tester', name: 'Tester', named: false, state: 'queued', stateAt: T0 + 10 },
      { kind: 'agent', ref: 'sess-notes', name: 'infra-notes', named: false, state: 'queued', stateAt: T0 + 10 },
    ]);
    expect(by['one']).toEqual([{ kind: 'agent', ref: 'sess-tester', name: 'Tester', named: true, state: 'queued', stateAt: T0 + 20 }]);
    expect(by['person']).toEqual([{ kind: 'person', ref: '2', name: 'Maya Kim', named: true, state: null, stateAt: null }]);
    expect(by['plain']).toEqual([]);
    expect(by['twice']).toHaveLength(1);
    expect(t.get('post to someone who is not a member')).toEqual({ threw: 'A target must be a member of the conversation.' });
    expect(t.get('post to oneself')).toEqual({ threw: 'A message cannot be for its own author.' });
    expect(t.get('post to a bad kind')).toEqual({ threw: 'A target is a person or an agent.' });
    expect((t.get('delivered') as ConversationMessage).deliveries[0]).toMatchObject({ state: 'delivered', stateAt: T0 + 70 });
    expect((t.get('dropped after delivered stays delivered') as ConversationMessage).deliveries[0]).toMatchObject({ state: 'delivered', stateAt: T0 + 70 });
    expect((t.get('queued cannot be set') as ConversationMessage).deliveries[0]).toMatchObject({ state: 'delivered' });
    expect((t.get('a person has no state to move') as ConversationMessage).deliveries[0]).toMatchObject({ kind: 'person', state: null });
    expect(t.get('no such delivery')).toBeNull();
    expect(t.get('no such message')).toBeNull();
    // The purge took the first message's deliveries with it; the rest stay.
    expect(texts(t.get('page after purge') as ConversationPage)).toEqual(['one', 'person', 'plain', 'twice']);
    expect(t.get('post after remove')).toBeNull();
  });

  it('agrees on every adapter for deliveries staying with their own conversation (#1296): a state is set through its own conversation only, and removing or purging one conversation leaves another\'s', async () => {
    const HAIKU: ConversationMemberInput = { kind: 'agent', ref: 'sess-notes', name: 'infra-notes' };
    const t = await sameOnAll(o, async (s, rec) => {
      const c = s.chat({ now: () => T0 }).conversations;
      const { conversation: a } = await c.open({ members: [ED, MAYA, TESTER], createdBy: 1 }, T0);
      const { conversation: b } = await c.open({ members: [ED, JO, HAIKU], createdBy: 1 }, T0 + 1);
      const { conversation: only } = await c.open({ members: [MAYA, HAIKU], createdBy: 2 }, T0 + 2);
      const one = await c.post(a.id, say(ED, 'in a', { targets: [{ kind: 'agent', ref: 'sess-tester', name: 'Tester', named: true }] }), T0 + 10) as ConversationMessage;
      const two = await c.post(b.id, say(ED, 'in b', { targets: [{ kind: 'agent', ref: 'sess-notes', name: 'infra-notes', named: true }] }), T0 + 20) as ConversationMessage;
      await c.post(only.id, say(MAYA, 'in only', { targets: [{ kind: 'agent', ref: 'sess-notes', name: 'infra-notes', named: true }] }), T0 + 30);
      await rec('b message through a', c.setDelivery(a.id, two.id, { kind: 'agent', ref: 'sess-notes' }, 'delivered', T0 + 40));
      await rec('a message through b', c.setDelivery(b.id, one.id, { kind: 'agent', ref: 'sess-tester' }, 'delivered', T0 + 40));
      await rec('a after the wrong calls', c.page(a.id, { limit: 50 }));
      await rec('b after the wrong calls', c.page(b.id, { limit: 50 }));
      await rec('remove a', c.remove(a.id));
      await rec('b after a is removed', c.page(b.id, { limit: 50 }));
      await rec('maya is deleted: only goes', c.removePerson(2));
      await rec('b after maya', c.page(b.id, { limit: 50 }));
      await rec('purge before b', c.purge(T0 + 15));
      await rec('b after an older purge', c.page(b.id, { limit: 50 }));
      await rec('purge past b', c.purge(T0 + 25));
      await rec('b after its purge', c.page(b.id, { limit: 50 }));
    });
    expect(t.get('b message through a')).toBeNull();
    expect(t.get('a message through b')).toBeNull();
    const queued = (text: string, ref: string, name: string) => [{ text, deliveries: [{ kind: 'agent', ref, name, named: true, state: 'queued', stateAt: text === 'in a' ? T0 + 10 : T0 + 20 }] }];
    const view = (key: string) => (t.get(key) as ConversationPage).messages.map((m) => ({ text: m.text, deliveries: m.deliveries }));
    expect(view('a after the wrong calls')).toEqual(queued('in a', 'sess-tester', 'Tester'));
    for (const key of ['b after the wrong calls', 'b after a is removed', 'b after maya', 'b after an older purge']) expect(view(key), key).toEqual(queued('in b', 'sess-notes', 'infra-notes'));
    expect(view('b after its purge')).toEqual([]);
    expect(t.get('remove a')).toEqual({ removed: true, messages: 1 });
    expect(t.get('maya is deleted: only goes')).toBe(1);
    expect(t.get('purge before b')).toBe(0);
    expect(t.get('purge past b')).toBe(1);
  });

  it('agrees on every adapter for the order of the deliveries of one message (#1296): by kind, then name, then reference, whatever order they were written or read in', async () => {
    const ALPHA: ConversationMemberInput = { kind: 'agent', ref: 'sess-b', name: 'Alpha' };
    const ZED: ConversationMemberInput = { kind: 'agent', ref: 'sess-a', name: 'Zed' };
    const t = await sameOnAll(o, async (s, rec) => {
      const c = s.chat({ now: () => T0 }).conversations;
      const { conversation: dm } = await c.open({ members: [ED, MAYA, TESTER, ALPHA, ZED], createdBy: 1 }, T0);
      const target = (m: ConversationMemberInput, named: boolean) => ({ kind: m.kind, ref: m.ref, name: m.name, named });
      // Written in the order Zed, Maya, Tester, Alpha, which is neither the order of the references (sess-a, sess-b, sess-tester, then the person) nor of the names.
      const sent = await c.post(dm.id, say(ED, 'to four', { targets: [target(ZED, true), target(MAYA, true), target(TESTER, false), target(ALPHA, false)] }), T0 + 10) as ConversationMessage;
      await rec('written', sent);
      await rec('Alpha delivered', c.setDelivery(dm.id, sent.id, { kind: 'agent', ref: 'sess-b' }, 'delivered', T0 + 20));
      await rec('Zed dropped', c.setDelivery(dm.id, sent.id, { kind: 'agent', ref: 'sess-a' }, 'dropped', T0 + 30));
      await rec('page', c.page(dm.id, { limit: 50 }));
      await rec('get', c.getMessage(dm.id, sent.id));
    });
    const expected = [
      { kind: 'agent', ref: 'sess-b', name: 'Alpha', named: false, state: 'delivered', stateAt: T0 + 20 },
      { kind: 'agent', ref: 'sess-tester', name: 'Tester', named: false, state: 'queued', stateAt: T0 + 10 },
      { kind: 'agent', ref: 'sess-a', name: 'Zed', named: true, state: 'dropped', stateAt: T0 + 30 },
      { kind: 'person', ref: '2', name: 'Maya Kim', named: true, state: null, stateAt: null },
    ];
    expect((t.get('written') as ConversationMessage).deliveries).toEqual(expected.map((d) => ({ ...d, state: d.kind === 'agent' ? 'queued' : null, stateAt: d.kind === 'agent' ? T0 + 10 : null })));
    expect((t.get('page') as ConversationPage).messages[0]!.deliveries).toEqual(expected);
    expect((t.get('get') as ConversationMessage).deliveries).toEqual(expected);
  });

  it('agrees on every adapter for removing: a conversation, and a person who is deleted', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const c = s.chat({ now: () => T0 }).conversations;
      const { conversation: dm } = await c.open({ members: [ED, MAYA], createdBy: 1 }, T0);
      const { conversation: trio } = await c.open({ members: [ED, MAYA, JO], createdBy: 1 }, T0 + 1);
      const { conversation: agent } = await c.open({ members: [MAYA, TESTER], createdBy: 2 }, T0 + 2);
      const { conversation: solo } = await c.open({ members: [JO, TESTER], createdBy: 3 }, T0 + 3);
      for (const x of [dm, trio, agent, solo]) await c.post(x.id, say(x.members[0] as ConversationMemberInput, 'hello'), T0 + 10);
      await rec('remove', c.remove(dm.id));
      await rec('remove again', c.remove(dm.id));
      await rec('get (removed)', c.get(dm.id));
      await rec('page (removed)', c.page(dm.id, { limit: 50 }));
      await rec('maya is deleted', c.removePerson(2));
      await rec('trio after maya', c.get(trio.id));
      await rec('maya and the agent: no person left, so it is gone', c.get(agent.id));
      await rec('jo is deleted', c.removePerson(3));
      await rec('trio after jo', c.get(trio.id));
      await rec('jo and the agent: gone', c.get(solo.id));
      await rec('page of a deleted conversation', c.page(solo.id, { limit: 50 }));
      await rec('a person in none', c.removePerson(99));
      await rec('ed is deleted: the last conversation goes', c.removePerson(1));
      await rec('trio after ed', c.get(trio.id));
    });
    expect(t.get('remove')).toEqual({ removed: true, messages: 1 });
    expect(t.get('remove again')).toEqual({ removed: false, messages: 0 });
    expect(t.get('get (removed)')).toBeNull();
    expect(t.get('maya is deleted')).toBe(1);
    expect((t.get('trio after maya') as Conversation).members.map((m) => m.name)).toEqual(['Ed', 'Jo Okafor']);
    expect(t.get('maya and the agent: no person left, so it is gone')).toBeNull();
    expect(t.get('jo is deleted')).toBe(1);
    expect((t.get('trio after jo') as Conversation).members.map((m) => m.name)).toEqual(['Ed']);
    expect(t.get('jo and the agent: gone')).toBeNull();
    expect(t.get('a person in none')).toBe(0);
    expect(t.get('ed is deleted: the last conversation goes')).toBe(1);
    expect(t.get('trio after ed')).toBeNull();
  });

  it('agrees on every adapter for an agent that leaves with the person who added it, and for the list of every conversation id', async () => {
    const t = await sameOnAll(o, async (s, rec) => {
      const c = s.chat({ now: () => T0 }).conversations;
      const { conversation: x } = await c.open({ members: [ED, MAYA], createdBy: 1 }, T0);
      const { conversation: y } = await c.open({ members: [ED, JO], createdBy: 1 }, T0 + 1);
      await rec('ids', c.ids());
      await rec('ed adds the agent', c.addMembers(x.id, [TESTER], 1, T0 + 10));
      await rec('maya adds her own agent', c.addMembers(x.id, [{ kind: 'agent', ref: 'sess-maya', name: 'maya-main' }], 2, T0 + 11));
      await rec('ed leaves: the agent he added leaves with him', c.leave(x.id, { kind: 'person', ref: '1' }, T0 + 20));
      await rec('the agent has no conversation', c.listFor({ kind: 'agent', ref: 'sess-tester' }));
      await rec('the agent maya added is still in', c.listFor({ kind: 'agent', ref: 'sess-maya' }));
      await rec('the agent cannot post', c.post(x.id, say(TESTER, 'still here'), T0 + 30));
      await rec('maya is deleted: her agent goes with her and the conversation with it', c.removePerson(2));
      await rec('get after', c.get(x.id));
      await rec('ids after', c.ids());
      await rec('the other conversation is untouched', c.get(y.id));
    });
    expect((t.get('ids') as string[]).length).toBe(2);
    expect((t.get('ed leaves: the agent he added leaves with him') as { conversation: Conversation }).conversation.members.filter((m) => m.leftAt === null).map((m) => m.name)).toEqual(['Maya Kim', 'maya-main']);
    expect(t.get('the agent has no conversation')).toEqual([]);
    expect((t.get('the agent maya added is still in') as Conversation[]).length).toBe(1);
    expect(t.get('the agent cannot post')).toBeNull();
    expect(t.get('maya is deleted: her agent goes with her and the conversation with it')).toBe(1);
    expect(t.get('get after')).toBeNull();
    expect((t.get('ids after') as string[]).length).toBe(1);
  });

  onEachAdapter(o, 'lists a member\'s conversations as `get` gives each, in a number of statements that does not grow with the conversations (#1309)', async (s) => {
    const c = s.chat({ now: () => T0 }).conversations;
    const ids: string[] = [];
    const withAgent: string[] = [];
    // Each conversation has a different set of people, some messages (ed's, then the other's) and a different last time; one is left by ed, one has an agent, one has no message.
    const make = async (n: number): Promise<void> => {
      for (let i = 0; i < n; i++) {
        const other: ConversationMemberInput = { kind: 'person', ref: String(1000 + ids.length), name: `P${ids.length}` };
        const { conversation } = await c.open({ members: i % 3 === 2 ? [ED, other, TESTER] : [ED, other], createdBy: 1 }, T0 + ids.length);
        ids.push(conversation.id);
        if (i % 3 === 2) withAgent.push(conversation.id);
        for (let k = 0; k < i % 4; k++) await c.post(conversation.id, say(k % 2 === 0 ? ED : other, `m${ids.length}-${k}`), T0 + 1000 + ids.length * 10 + k);
      }
    };
    const check = async (): Promise<number> => {
      const { value, statements } = await counted(() => c.listFor({ kind: 'person', ref: '1' }));
      const each = (await Promise.all(ids.map((id) => c.get(id)))).filter((x): x is Conversation => x !== null);
      expect(value).toEqual(each.sort((a, b) => b.lastAt - a.lastAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
      return statements;
    };
    await make(3);
    const small = await check();
    await make(27);
    await c.leave(ids[4]!, { kind: 'person', ref: '1' }, T0 + 5000);
    ids.splice(4, 1);
    const large = await check();
    // The agent sees only its own, with the same members as `get` gives.
    expect((await c.listFor({ kind: 'agent', ref: 'sess-tester' })).map((x) => x.id).sort()).toEqual([...withAgent].sort());
    expect(small).toBeLessThanOrEqual(3);
    expect(large).toBe(small);
  });

  onEachAdapter(o, 'keeps a conversation out of every other audience: a channel and a direct message never hold its text, and it never holds theirs', async (s) => {
    const chat = s.chat({ now: () => T0 });
    const { conversation } = await chat.conversations.open({ members: [ED, MAYA], createdBy: 1 }, T0);
    await chat.conversations.post(conversation.id, say(ED, 'only in the conversation'), T0 + 1);
    await chat.group.post({ ownerId: 11 }, { authorKind: 'person', authorRef: 'ed', authorName: 'Ed', text: 'only in the group' });
    await chat.public.post('general', { authorKind: 'person', authorRef: 'ed', authorName: 'Ed', text: 'only in general' });
    expect((await chat.group.page({ ownerId: 11 }, { limit: 50 })).messages.map((m) => m.text)).toEqual(['only in the group']);
    expect((await chat.public.page('general', { limit: 50 })).messages.map((m) => m.text)).toEqual(['only in general']);
    expect(texts(await chat.conversations.page(conversation.id, { limit: 50 }))).toEqual(['only in the conversation']);
  });
}
