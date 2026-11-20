// The held-message list the Claude Code reporter reads at a tool boundary (#1264) is plain, so it is tested here: the mod's own tests run
// only inside Claude Code, where neither the server's coverage run nor SonarCloud can see them.
import { describe, it, expect } from 'vitest';
import { forSession, HELD_LEAD, makeHeld, withHeldContext, type HeldMessage } from '../plugin/claudecode/hooks/midTurn.ts';

const msg = (id: string, text = `text ${id}`, sid = 's1'): HeldMessage => ({ sid, id, text, from: null });

describe('held messages (#1264)', () => {
  it('takes what is held, oldest first, once', () => {
    const h = makeHeld();
    h.hold(msg('a'));
    h.hold(msg('b'));
    expect(h.size()).toBe(2);
    expect(h.take().map((m) => m.id)).toEqual(['a', 'b']);
    expect(h.size()).toBe(0);
    expect(h.take()).toEqual([]);
  });

  it('holds one delivery id once, even handed over twice', () => {
    const h = makeHeld();
    h.hold(msg('a'));
    h.hold(msg('a', 'again'));
    expect(h.take().map((m) => m.text)).toEqual(['text a']);
  });

  it('splits what belongs to the session from what was held for an earlier one', () => {
    const { mine, stale } = forSession([msg('a'), msg('b', 'x', 's0')], 's1');
    expect(mine.map((m) => m.id)).toEqual(['a']);
    expect(stale.map((m) => m.id)).toEqual(['b']);
  });

  it('adds the held texts after the context other hooks already gave', () => {
    expect(withHeldContext(['x'], [msg('a'), msg('b')])).toEqual(['x', `${HELD_LEAD}\ntext a`, `${HELD_LEAD}\ntext b`]);
    expect(withHeldContext(undefined, [msg('a')])).toEqual([`${HELD_LEAD}\ntext a`]);
  });
});
