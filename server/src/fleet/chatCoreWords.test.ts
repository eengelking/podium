// The words and rules Chat's audiences share (#1310): who a locked message names, whether a message can be changed, and what a refused change says.
import { describe, it, expect } from 'vitest';
import { changeRefusal, changeState, sentWords } from './chatCore.js';

describe('sentWords', () => {
  it('names no agent, one, two and three, in a list a person reads', () => {
    expect(sentWords([])).toBe('Podium has already sent this message to the agent, so it can no longer be changed.');
    expect(sentWords(['Tester'])).toBe('Podium has already sent this message to Tester, so it can no longer be changed.');
    expect(sentWords(['Tester', 'dev'])).toBe('Podium has already sent this message to Tester and dev, so it can no longer be changed.');
    expect(sentWords(['Tester', 'dev', 'review'])).toBe('Podium has already sent this message to Tester, dev and review, so it can no longer be changed.');
  });
});

describe('changeState', () => {
  it('says nothing to a viewer who is not the author, and says why to the author, the lock before the other reason', () => {
    expect(changeState(false, true, () => 'locked', 'waiting')).toEqual({ canChange: false, changeWhy: null });
    expect(changeState(true, false, () => 'locked')).toEqual({ canChange: true, changeWhy: null });
    expect(changeState(true, true, () => 'locked', 'waiting')).toEqual({ canChange: false, changeWhy: 'locked' });
    expect(changeState(true, false, () => 'locked', 'waiting')).toEqual({ canChange: false, changeWhy: 'waiting' });
  });
});

describe('changeRefusal', () => {
  const words = { notFound: 'gone', notYours: 'not yours', deleted: 'deleted already' };
  it('maps each reason of the store to a status and the audience\'s words, and asks for the locked words only when they are needed', async () => {
    let asked = 0;
    const locked = () => {
      asked++;
      return 'sent';
    };
    expect(await changeRefusal('not-found', words, locked)).toEqual({ ok: false, status: 404, error: 'gone' });
    expect(await changeRefusal('not-yours', words, locked)).toEqual({ ok: false, status: 403, error: 'not yours' });
    expect(await changeRefusal('deleted', words, locked)).toEqual({ ok: false, status: 409, error: 'deleted already', reason: 'deleted' });
    expect(asked).toBe(0);
    expect(await changeRefusal('locked', words, locked)).toEqual({ ok: false, status: 409, error: 'sent', reason: 'locked' });
    expect(asked).toBe(1);
  });
});
