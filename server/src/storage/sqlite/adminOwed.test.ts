// #1061: a person's unseen Admin records are found through the `chat_admin_owed` table keyed by person, never by reading and parsing every row of
// `chat_admin_reads`. The contract case (`contractChat.ts`) holds the answers on every adapter; this holds the way SQLite reaches them.
import { describe, expect, it } from 'vitest';
import { openSqliteStorage } from './index.js';

const T0 = 1_800_000_000_000;
const PEOPLE = 50;
const RECORDS = 10_000;

describe('unseenFor reaches only the rows of the person asked (#1061)', () => {
  it('plans every statement it runs as a search on the owed table, and never a scan of the records', async () => {
    const s = openSqliteStorage(':memory:');
    try {
      const clock = { now: T0 };
      const reads = s.chat({ now: () => clock.now }).adminReads;
      for (let i = 0; i < RECORDS; i++) {
        clock.now += 1;
        await reads.mark(`dm:t${i}`, 'Root', 'cleared', [`p${String(i % PEOPLE).padStart(2, '0')}`]);
      }
      const db = s.sqliteHandle;
      const run: string[] = [];
      const prepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        run.push(sql);
        return prepare(sql);
      }) as typeof db.prepare;
      const rows = await reads.unseenFor('p07');
      db.prepare = prepare;
      expect(rows).toHaveLength(RECORDS / PEOPLE);
      expect(run.length).toBeGreaterThan(0);
      for (const sql of run) {
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail);
        expect(plan.filter((d) => /^SCAN chat_admin_(reads|owed)\b/.test(d)), sql).toEqual([]);
      }
    } finally {
      await s.close();
    }
  }, 60_000);
});
