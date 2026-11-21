import { describe, expect, it } from 'vitest';
import { keepOwnerSettings, personEndRewrite, personFirstDay } from './peerOwnerIds.js';
import { threadWithId, flagScopeWithId, type PersonIndex } from './chatRows.js';

describe('the upgrade of a person\'s end of a link to an id (#1284)', () => {
  const people: PersonIndex = new Map([['ed', { id: 5, createdAt: 1000 }], ['42', { id: 9, createdAt: 1000 }], ['gone:x', { id: 11, createdAt: 2000 }]]);
  it('turns a name into the id for a row since the person was made and into a gone key for an older row (#1292), a name no person has into a gone key for every row, and leaves the Admin\'s key and other keys as they are', () => {
    expect(personEndRewrite('person:ed', people)).toEqual({ to: 'person:5', earlier: 'person:gone:ed', since: 1000 });
    expect(personEndRewrite('person:nobody', people)).toEqual({ to: 'person:gone:nobody', earlier: 'person:gone:nobody', since: 0 });
    expect(personEndRewrite('rk-abc', people)).toBeNull();
  });
  it('reads a name that begins gone: as a name, so a person called gone:x is not taken for a key already rewritten (#1292)', () => {
    expect(personEndRewrite('person:gone:x', people)).toEqual({ to: 'person:11', earlier: 'person:gone:gone:x', since: 2000 });
    expect(personEndRewrite('person:gone:y', people)).toEqual({ to: 'person:gone:gone:y', earlier: 'person:gone:gone:y', since: 0 });
    expect(threadWithId('dm:person:gone:x|sa', people)).toBe('dm:person:11|sa');
    expect(threadWithId('dm:person:gone:y|sa', people)).toBe('dm:person:gone:gone:y|sa');
  });
  it('keeps an owner\'s defaults only for a person who owns a row and has none older under the name (#1292)', () => {
    expect(keepOwnerSettings('ed', people, new Set([5]), new Set())).toBe(5);
    expect(keepOwnerSettings('ed', people, new Set([5]), new Set(['ed']))).toBeNull();
    expect(keepOwnerSettings('ed', people, new Set(), new Set())).toBeNull();
    expect(keepOwnerSettings('nobody', people, new Set([5]), new Set())).toBeNull();
  });
  it('reads an all-digit name as a name, as the Chat upgrade does', () => {
    expect(personEndRewrite('person:42', people)?.to).toBe('person:9');
    const only: PersonIndex = new Map([['42', { id: 9, createdAt: 1000 }]]);
    expect(threadWithId('group:42', only)).toBe('group:9');
    expect(threadWithId('dm:person:42|sa', only)).toBe('dm:person:9|sa');
    expect(flagScopeWithId('public:person:42', only)).toBe('public:person:9');
    expect(flagScopeWithId('channel:dev:person:42', only)).toBe('channel:dev:person:9');
  });
  it('first lets a person own a daily row on the day the person was made', () => {
    expect(personFirstDay(new Date(2026, 9, 1, 12).getTime())).toBe('2026-10-01');
  });
});
