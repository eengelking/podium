// The `samples` table of a throwaway MariaDB database, for the index measurement (#755). Raw SQL stays in the adapter; see `SamplesPerf` in ../contractAdapter.ts.
import type { SamplesPerf } from '../contractAdapter.js';
import { MariaDbConn, parseTarget } from './conn.js';
import { openMariaDbStorage } from './index.js';
import { createTestDatabase } from './testing.js';

export async function mariadbSamplesPerf(): Promise<SamplesPerf> {
  const td = await createTestDatabase();
  // Opened as the server opens it, so the tables and their steps exist before the seed.
  await (await openMariaDbStorage(td.url.replace(/^mariadb:\/\//, ''), 0)).close();
  const db = new MariaDbConn({ target: parseTarget(td.url), max: 2 });
  const analyze = (): Promise<void> => db.exec('ANALYZE TABLE samples');
  return {
    podiumDb: td.url,
    async seed(sessions, seconds, endSec) {
      // The Sequence engine gives 0 .. N-1 without a table of numbers; N is a whole number the caller checked, so it is safe in the name.
      const last = Math.trunc(seconds) - 1;
      for (let s = 0; s < sessions; s++) {
        await db.run(
          `INSERT INTO samples (session_id, t, tokens_total, tokens_delta, peak_context, running_agents, cost_usd)
           SELECT ?, ? - seq, seq * 100, 100, 0.4, 2, seq * 0.0001 FROM seq_0_to_${last}`,
          [`perf-${String(s).padStart(3, '0')}`, endSec],
        );
      }
      await analyze();
    },
    async dropIndex() { await db.exec('DROP INDEX IF EXISTS samples_t ON samples'); await analyze(); },
    async createIndex() { await db.exec('CREATE INDEX IF NOT EXISTS samples_t ON samples(t)'); await analyze(); },
    // information_schema gives one figure for every secondary index of the table, and `samples` has only this one.
    async indexBytes() { return Number((await db.get<{ b: number }>("SELECT index_length AS b FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'samples'"))?.b ?? 0); },
    async rows() { return Number((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM samples'))?.n ?? 0); },
    async close() {
      await db.close();
      await td.drop();
    },
  };
}
