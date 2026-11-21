import { describe, expect, it } from 'vitest';
import { personEndKey, personFirstDay } from './peerOwnerIds.js';
import { threadWithId, flagScopeWithId, type PersonIndex } from './chatRows.js';

describe('the upgrade of a person\'s end of a link to an id (#1284)', () => {
  const ids = new Map([['ed', 5], ['42', 9]]);
  it('turns a name into the id, a name no person has into a gone key, and leaves the Admin\'s key and a gone key as they are', () => {
    expect(personEndKey('person:ed', ids)).toBe('person:5');
    expect(personEndKey('person:nobody', ids)).toBe('person:gone:nobody');
    expect(personEndKey('person:gone:nobody', ids)).toBe('person:gone:nobody');
    expect(personEndKey('rk-abc', ids)).toBe('rk-abc');
  });
  it('reads an all-digit name as a name, as the Chat upgrade does', () => {
    expect(personEndKey('person:42', ids)).toBe('person:9');
    const people: PersonIndex = new Map([['42', { id: 9, createdAt: 1000 }]]);
    expect(threadWithId('group:42', people)).toBe('group:9');
    expect(threadWithId('dm:person:42|sa', people)).toBe('dm:person:9|sa');
    expect(flagScopeWithId('public:person:42', people)).toBe('public:person:9');
    expect(flagScopeWithId('channel:dev:person:42', people)).toBe('channel:dev:person:9');
  });
  it('first lets a person own a daily row on the day the person was made', () => {
    expect(personFirstDay(new Date(2026, 9, 1, 12).getTime())).toBe('2026-10-01');
  });
});
