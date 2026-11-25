// The `samples` table of a throwaway SQLite file, for the index measurement (#755). Raw SQL stays in the adapter; see `SamplesPerf` in ../contractAdapter.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SamplesPerf } from '../contractAdapter.js';
import { openDb } from './db.js';

export function sqliteSamplesPerf(): SamplesPerf {
  const dir = mkdtempSync(path.join(tmpdir(), 'podium-samples-index-'));
  const file = path.join(dir, 'perf.sqlite');
  const db = openDb(file);
  return {
    podiumDb: file,
    async seed(sessions, seconds, endSec) {
      db.exec('BEGIN');
      const insert = db.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO samples (session_id, t, tokens_total, tokens_delta, peak_context, running_agents, cost_usd)
         SELECT ?, ? - i, i * 100, 100, 0.4, 2, i * 0.0001 FROM n`,
      );
      for (let s = 0; s < sessions; s++) insert.run(seconds - 1, `perf-${String(s).padStart(3, '0')}`, endSec);
      db.exec('COMMIT');
    },
    async dropIndex() { db.exec('DROP INDEX IF EXISTS samples_t'); },
    async createIndex() { db.exec('CREATE INDEX IF NOT EXISTS samples_t ON samples(t)'); },
    async indexBytes() {
      try {
        return Number((db.prepare("SELECT SUM(pgsize) AS b FROM dbstat WHERE name = 'samples_t'").get() as { b: number }).b);
      } catch {
        return null; // dbstat is not compiled into this SQLite
      }
    },
    async rows() { return Number((db.prepare('SELECT COUNT(*) AS n FROM samples').get() as { n: number }).n); },
    async close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
