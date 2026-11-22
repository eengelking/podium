// One chat event for each scope an action changed (#1296): what `ChatCore.batch` sends, when it sends it, and what it never swallows.
import { describe, it, expect } from 'vitest';
import { ChatCore } from './chatCore.js';
import type { ChatSignal } from './chatTypes.js';

/** A core whose host records what it is told, in order. Nothing here reads the store. */
function core() {
  const sent: ChatSignal[] = [];
  const host = { now: () => 0, respond: { watch: () => undefined }, signal: (s: ChatSignal) => void sent.push(s) };
  return { core: new ChatCore(host as unknown as ConstructorParameters<typeof ChatCore>[0], {} as ConstructorParameters<typeof ChatCore>[1]), sent };
}
const turn = () => new Promise<void>((r) => setImmediate(r));

describe('ChatCore.batch', () => {
  it('sends one event for each scope, in the order each was first signalled, and none until the action is done', async () => {
    const { core: c, sent } = core();
    await c.batch(async () => {
      c.signal('dm');
      c.signal('group');
      c.signal('dm');
      await turn();
      c.signal('dm');
      c.signal('group');
      expect(sent).toEqual([]);
    });
    expect(sent.map((s) => s.scope)).toEqual(['dm', 'group']);
  });

  it('numbers the events by one, across actions and across signals that came alone', async () => {
    const { core: c, sent } = core();
    c.signal('public');
    await c.batch(async () => {
      c.signal('dm');
      c.signal('group');
    });
    c.signal('dm');
    await c.batch(async () => c.signal('public'));
    expect(sent.map((s) => s.rev)).toEqual([1, 2, 3, 4, 5]);
  });

  it('sends nothing for an action that signals nothing, and returns what the action returns', async () => {
    const { core: c, sent } = core();
    expect(await c.batch(async () => 7)).toBe(7);
    expect(sent).toEqual([]);
  });

  it('sends what a failed action signalled, and lets the failure through', async () => {
    const { core: c, sent } = core();
    await expect(
      c.batch(async () => {
        c.signal('group');
        await turn();
        throw new Error('the second write failed');
      }),
    ).rejects.toThrow('the second write failed');
    expect(sent.map((s) => s.scope)).toEqual(['group']);
  });

  it('sends its events after the last write of the action, whatever turns the writes take', async () => {
    const { core: c } = core();
    let stored = 0;
    const atEvent: number[] = [];
    (c.host as { signal: (s: ChatSignal) => void }).signal = () => void atEvent.push(stored);
    await c.batch(async () => {
      stored = 1;
      c.signal('dm');
      await turn();
      stored = 2;
      c.signal('dm');
      await new Promise((r) => setTimeout(r, 5));
      stored = 3;
    });
    expect(atEvent).toEqual([3]);
  });

  it('keeps two actions that overlap apart: each sends its own scopes, and none is swallowed or lent to the other', async () => {
    const { core: c, sent } = core();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow = c.batch(async () => {
      c.signal('group');
      await gate;
      c.signal('public');
    });
    const quick = c.batch(async () => {
      await turn();
      c.signal('dm');
    });
    await quick;
    expect(sent.map((s) => s.scope)).toEqual(['dm']);
    release();
    await slow;
    expect(sent.map((s) => s.scope)).toEqual(['dm', 'group', 'public']);
    expect(sent.map((s) => s.rev)).toEqual([1, 2, 3]);
  });

  it('joins a batch inside another, so the outer one sends once', async () => {
    const { core: c, sent } = core();
    await c.batch(async () => {
      c.signal('dm');
      await c.batch(async () => c.signal('dm'));
      expect(sent).toEqual([]);
    });
    expect(sent.map((s) => s.scope)).toEqual(['dm']);
  });

  it('waits for what the action started and did not wait for, so its signal is part of the one event', async () => {
    const { core: c, sent } = core();
    await c.batch(async () => {
      c.also(
        (async () => {
          await new Promise((r) => setTimeout(r, 5));
          c.signal('dm');
        })(),
      );
      c.signal('dm');
    });
    expect(sent.map((s) => s.scope)).toEqual(['dm']);
  });

  it('sends a signal that comes after the batch is done on its own, and loses none', async () => {
    const { core: c, sent } = core();
    let late: () => void = () => undefined;
    const after = new Promise<void>((r) => (late = r));
    await c.batch(async () => {
      c.signal('dm');
      void after.then(() => c.signal('dm'));
    });
    expect(sent).toHaveLength(1);
    late();
    await turn();
    expect(sent.map((s) => s.scope)).toEqual(['dm', 'dm']);
  });

  it('makes an action of its own of a batch started by work that outlived its batch, and does not keep that work', async () => {
    const { core: c, sent } = core();
    let later: Promise<void> = Promise.resolve();
    await c.batch(async () => {
      // A timer made inside the batch runs in its context after the batch is done.
      later = new Promise<void>((r) =>
        setTimeout(() => {
          void c
            .batch(async () => {
              c.signal('dm');
              c.signal('dm');
              c.signal('group');
              expect(sent).toEqual([]);
            })
            .then(r);
        }, 5),
      );
    });
    await later;
    expect(sent.map((s) => s.scope)).toEqual(['dm', 'group']);
  });

  it('sends what is signalled outside any batch at once', () => {
    const { core: c, sent } = core();
    c.signal('group');
    c.signal('group');
    expect(sent.map((s) => s.scope)).toEqual(['group', 'group']);
  });
});
