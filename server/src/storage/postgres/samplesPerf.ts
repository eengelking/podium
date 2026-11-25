// The `samples` table of a throwaway PostgreSQL database, for the index measurement (#755). Raw SQL stays in the adapter; see `SamplesPerf` in ../contractAdapter.ts.
import type { SamplesPerf } from '../contractAdapter.js';
import { PgDb } from './conn.js';
import { openPostgresStorage } from './index.js';
import { MAIN_SCHEMA } from './schema.js';
import { createTestDatabase } from './testing.js';

export async function postgresSamplesPerf(): Promise<SamplesPerf> {
  const td = await createTestDatabase();
  // Opened as the server opens it, so the schema and its migrations exist before the seed.
  await (await openPostgresStorage(td.url.replace(/^postgres:\/\//, ''), 0)).close();
  const db = new PgDb({ connectionString: td.url, schema: MAIN_SCHEMA, max: 2, name: 'samples-perf' });
  const analyze = (): Promise<void> => db.exec('ANALYZE samples');
  return {
    podiumDb: td.url,
    async seed(sessions, seconds, endSec) {
      for (let s = 0; s < sessions; s++) {
        await db.run(
          `INSERT INTO samples (session_id, t, tokens_total, tokens_delta, peak_context, running_agents, cost_usd)
           SELECT ?, ?::bigint - g, g * 100, 100, 0.4, 2, g * 0.0001 FROM generate_series(0, ?::int) AS g`,
          [`perf-${String(s).padStart(3, '0')}`, endSec, seconds - 1],
        );
      }
      await analyze();
    },
    async dropIndex() { await db.exec('DROP INDEX IF EXISTS samples_t'); await analyze(); },
    async createIndex() { await db.exec('CREATE INDEX IF NOT EXISTS samples_t ON samples(t)'); await analyze(); },
    async indexBytes() { return Number((await db.get<{ b: number }>(`SELECT pg_relation_size('${MAIN_SCHEMA}.samples_t') AS b`))?.b ?? 0); },
    async rows() { return Number((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM samples'))?.n ?? 0); },
    async close() {
      await db.close();
      await td.drop();
    },
  };
}
