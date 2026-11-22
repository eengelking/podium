// Two transactions that count the same people in a thread lock the same rows of `chat_read_state` (#1296). A multi-row upsert takes its row locks in the order of its VALUES, so two of them that list the
// people in opposite orders can each hold a row the other waits for, and the database aborts one: a chat post fails. One Podium takes its transactions one at a time (`MariaDbConn.tx`), so this needs two
// connections that do not share a gate, as two processes on one database would. The people are counted in ascending id whatever order they are given, so no two ever wait on each other.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatStoreApi } from '../types.js';
import { mariaChat } from './chat.js';
import { MariaDbConn, parseTarget } from './conn.js';
import { MAIN_MIGRATIONS, MAIN_STEPS, migrate } from './schema.js';
import { TEST_MARIADB, createTestDatabase, type TestDatabase } from './testing.js';

describe.skipIf(!TEST_MARIADB)('mariadb: counting the same people from two connections', () => {
  let td: TestDatabase;
  const dbs: MariaDbConn[] = [];
  const stores: ChatStoreApi[] = [];
  beforeAll(async () => {
    td = await createTestDatabase();
    for (let i = 0; i < 2; i++) {
      const db = new MariaDbConn({ target: parseTarget(td.url), max: 4 });
      dbs.push(db);
      if (i === 0) await migrate(db, MAIN_MIGRATIONS, MAIN_STEPS);
      stores.push(mariaChat(db, { now: () => 0 }));
    }
  });
  afterAll(async () => {
    for (const db of dbs) await db.close();
    await td.drop();
  });

  it('never deadlocks, whichever order each connection lists them in, and counts each person once for each bump', async () => {
    const people = Array.from({ length: 150 }, (_, i) => 1000 + i);
    const up = people.map((personId) => ({ personId, mention: false }));
    const down = [...up].reverse();
    const rounds = 60;
    const failures: string[] = [];
    for (let i = 0; i < rounds; i++) {
      const [a, b] = await Promise.allSettled([stores[0]!.readState.bumpMany(`t${i}`, up), stores[1]!.readState.bumpMany(`t${i}`, down)]);
      for (const r of [a!, b!]) if (r.status === 'rejected') failures.push(String(r.reason instanceof Error ? r.reason.message : r.reason));
    }
    expect(failures).toEqual([]);
    expect((await stores[0]!.readState.get(1000, 't0')).unread).toBe(2);
    expect((await stores[0]!.readState.get(1149, `t${rounds - 1}`)).unread).toBe(2);
  }, 60_000);

  it('answers in ascending person id, however the people were listed', async () => {
    const answer = await stores[0]!.readState.bumpMany('order', [{ personId: 30, mention: false }, { personId: 10, mention: true }, { personId: 20, mention: false }, { personId: 10, mention: false }]);
    expect(answer.map((r) => [r.personId, r.unread, r.mentions])).toEqual([[10, 2, 1], [20, 1, 0], [30, 1, 0]]);
  });
});
