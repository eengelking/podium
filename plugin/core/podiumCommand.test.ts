import { describe, test, expect } from 'claude-code/testing';
import { connectionLine, contextArgs, nameArg } from './podiumCommand.ts';

describe('/podium words', () => {
  test('takes the text after name, trimmed and cut to 80, and nothing for another word', () => {
    expect(nameArg('NAME Silverbolt ')).toBe('Silverbolt');
    expect(nameArg('name ' + 'y'.repeat(100))).toBe('y'.repeat(80));
    expect(nameArg('name')).toBeNull();
    expect(nameArg('rename x')).toBeNull();
  });
  test('takes the arguments after context only for that word', () => {
    expect(contextArgs('context')).toBe('');
    expect(contextArgs(' context use work ')).toBe(' use work');
    expect(contextArgs('contexts')).toBeNull();
    expect(contextArgs('name context')).toBeNull();
  });
  test('says how the reporter signs in without a secret', () => {
    expect(connectionLine({ configPath: '/h/.podium/a.pem', tokenSet: true })).toBe('Sign-in: reporter config file /h/.podium/a.pem (mTLS)');
    expect(connectionLine({ configPath: null, tokenSet: true })).toContain('a plain token');
    expect(connectionLine({ configPath: null, tokenSet: false })).toContain('none');
  });
});
