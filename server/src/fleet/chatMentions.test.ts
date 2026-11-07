import { describe, it, expect } from 'vitest';
import { parseMentions } from './chatMentions.js';

describe('parseMentions (#1034)', () => {
  it('reads name@location after an @, and keeps what was typed', () => {
    expect(parseMentions('@Tester@ci-runner-01 run the tests')).toEqual([{ kind: 'address', name: 'Tester', location: 'ci-runner-01', id: null, typed: 'Tester@ci-runner-01' }]);
  });

  it('drops the full stop or dash that ends a sentence', () => {
    expect(parseMentions('thanks @Tester@ci-runner-01.')[0]).toMatchObject({ location: 'ci-runner-01', typed: 'Tester@ci-runner-01' });
    expect(parseMentions('see @a.b@box-1, then')[0]).toMatchObject({ name: 'a.b', location: 'box-1' });
  });

  it('does not take an email address, or an @ inside a word, for a mention', () => {
    expect(parseMentions('mail ed@example.com or x@@y or a@b@c')).toEqual([]);
  });

  it('reads @group and @everyone, in any case', () => {
    expect(parseMentions('@group and @Everyone, hello')).toEqual([{ kind: 'group', typed: 'group' }, { kind: 'everyone', typed: 'everyone' }]);
  });

  it('reads a plain @Name as a name with no location', () => {
    expect(parseMentions('hey @Upper please')).toEqual([{ kind: 'plain', name: 'Upper', typed: 'Upper' }]);
  });

  it('reads an id after the location, to tell same-named agents apart', () => {
    expect(parseMentions('@Tester@ci-runner-01#ab12cd')[0]).toMatchObject({ kind: 'address', location: 'ci-runner-01', id: 'ab12cd', typed: 'Tester@ci-runner-01#ab12cd' });
  });

  it('lists each mention once, in the order first typed, ignoring case', () => {
    const m = parseMentions('@Tester@Box @tester@box @group @GROUP @Bob');
    expect(m.map((x) => x.typed)).toEqual(['Tester@Box', 'group', 'Bob']);
  });

  it('finds nothing in text with no @', () => {
    expect(parseMentions('no mentions here')).toEqual([]);
    expect(parseMentions('')).toEqual([]);
  });

  it('trims the full stops and dashes a sentence ends on, in linear time on a long adversarial name', () => {
    expect(parseMentions('hi @dev.')).toEqual([{ kind: 'plain', name: 'dev', typed: 'dev' }]);
    expect(parseMentions('@dev@host-- ok')).toEqual([{ kind: 'address', name: 'dev', location: 'host', id: null, typed: 'dev@host' }]);
    const t0 = Date.now();
    parseMentions('@' + '.-'.repeat(25_000) + '!');
    parseMentions('@a@' + '-.'.repeat(25_000) + '!');
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
