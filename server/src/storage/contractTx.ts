// Contract cases for the transaction (#1007, item 3): `Storage.tx` is exclusive. A store call made outside it, by another task,
// waits until the transaction ends, so a read followed by a write inside it is one step on every adapter. The other task's call is
// made from the case's own context, not from inside the callback: a call made inside the callback is part of the transaction.
import { expect } from 'vitest';
import { onEachAdapter, type Openers } from './contractSame.js';
import { session } from './contract.js';

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A promise and the function that settles it. */
function latch(): { done: Promise<void>; open: () => void } {
  let open!: () => void;
  const done = new Promise<void>((r) => {
    open = r;
  });
  return { done, open };
}

export function txCases(o: Openers): void {
  onEachAdapter(o, 'holds a read made outside an open transaction until the transaction ends', async (s) => {
    const entered = latch();
    const release = latch();
    const txn = s.tx(async () => {
      await s.fleet.upsertSession(session({ id: 'inside' }));
      entered.open();
      await release.done;
    });
    await entered.done;
    let outsideDone = false;
    const outside = s.fleet.getSession('inside').then((r) => {
      outsideDone = true;
      return r;
    });
    await tick(150);
    expect(outsideDone).toBe(false);
    release.open();
    await txn;
    expect(await outside).toMatchObject({ id: 'inside' });
  });

  onEachAdapter(o, 'does not lose a write made by another task between a read and a write inside a transaction', async (s) => {
    await s.fleet.upsertSession(session({ id: 'p12', dropped_at: null }));
    const read = latch();
    const go = latch();
    const txn = s.tx(async () => {
      const row = await s.fleet.getSession('p12');
      read.open();
      await go.done;
      await s.fleet.upsertSession({ ...row!, status: 'done' });
    });
    await read.done;
    const concurrent = s.fleet.setDropped('p12', 777);
    await tick(150);
    go.open();
    await txn;
    await concurrent;
    expect((await s.fleet.getSession('p12'))!.dropped_at).toBe(777);
  });

  onEachAdapter(o, 'keeps a person moved to a group inside a transaction whole when that group is deleted at the same time', async (s) => {
    const { person } = await s.people.createPerson('Ann');
    const g = await s.people.createGroup('Crew');
    const moved = latch();
    const go = latch();
    const txn = s.tx(async () => {
      const ok = await s.people.setGroup(person.id, g.id);
      moved.open();
      await go.done;
      return { ok, group: await s.people.getGroup(g.id) };
    });
    await moved.done;
    const del = s.people.deleteGroup(g.id);
    await tick(150);
    go.open();
    // The group named in the transaction is the one the person was moved to; the delete came after it.
    expect(await txn).toEqual({ ok: true, group: g });
    await del;
    expect(await s.people.getGroup(g.id)).toBeUndefined();
    expect((await s.people.getPerson(person.id))!.groupId).toBeNull();
  });

  onEachAdapter(o, 'lets calls inside the transaction callback run, and a nested tx join it', async (s) => {
    await s.tx(async () => {
      await s.fleet.upsertSession(session({ id: 'a' }));
      await s.tx(async () => {
        await Promise.all([s.fleet.upsertSession(session({ id: 'b' })), s.fleet.getSession('a')]);
      });
    });
    expect((await s.fleet.getSessions(['a', 'b'])).length).toBe(2);
  });
}
