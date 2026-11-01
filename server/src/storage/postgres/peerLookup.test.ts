import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDb } from './conn.js';
import { MAIN_SCHEMA, MAIN_STEPS, migrate } from './schema.js';
import { pgPeerLookup } from './peerLookup.js';
import { TEST_PG, createTestDatabase, type TestDatabase } from './testing.js';
import { ADMIN_SECRET } from '../rows.js';

const MIN = 60_000;
const START = 1_000_000_000_000;

describe.skipIf(!TEST_PG)('postgres peer lookup', () => {
  let td: TestDatabase;
  let db: PgDb;
  beforeAll(async () => {
    td = await createTestDatabase();
    db = new PgDb({ connectionString: td.url, schema: MAIN_SCHEMA, max: 4, name: 'test' });
    await migrate(db, MAIN_SCHEMA, MAIN_STEPS);
    const put = (key: string, over: { kind?: string; name?: string | null; owner?: string; credential?: string; at?: number; os?: string | null; peers?: number | null } = {}) =>
      db.run(
        `INSERT INTO reporters (key, kind, machine_id, machine_name, owner, credential, reporter_version, first_seen_at, last_seen_at, os, peers)
         VALUES (?, ?, ?, ?, ?, ?, '0.13.0', ?, ?, ?, ?)`,
        [key, over.kind ?? 'mod', key, over.name === undefined ? key : over.name, over.owner ?? 'Dana', over.credential ?? 'pdm_x', over.at ?? START, over.at ?? START, over.os ?? null, over.peers ?? null],
      );
    await put('studio', { name: 'studio-m2', at: START + MIN, os: 'macOS 27.0.1', peers: 1 });
    await put('bare', { name: null, credential: ADMIN_SECRET, owner: 'dana', at: START + MIN });
    await put('ci', { name: 'ci', at: START + 90 * MIN });
    await put('old', { name: 'old', at: START - MIN });
    await put('hooks', { kind: 'hooks', at: START + 90 * MIN });
    await put('other', { owner: 'Alex' });
  });
  afterAll(async () => {
    await db.close();
    await td.drop();
  });

  it('looks reporters up by key and by owner whatever the case, mod reporters only', async () => {
    const look = pgPeerLookup(db, START);
    expect(look.startedAt).toBe(START);
    expect(await look.get('studio')).toEqual({ key: 'studio', machine: 'studio-m2', owner: 'Dana', adminSecret: false, os: 'macOS 27.0.1', peers: true, version: '0.13.0' });
    expect(await look.get('bare')).toMatchObject({ machine: 'bare', adminSecret: true, peers: null });
    expect(await look.get('nope')).toBeNull();
    expect(await look.get('hooks')).toBeNull();
    expect((await look.ofOwner('DANA')).map((r) => r.key)).toEqual(['bare', 'ci', 'old', 'studio']);
  });

  it('gives one owner its reporters with the state and last report', async () => {
    const look = pgPeerLookup(db, START);
    const mine = await look.ofOwnerSeen('dana', START + 91 * MIN);
    expect(mine.map((r) => [r.machine, r.state, r.lastSeenAt])).toEqual([
      ['bare', 'silent', START + MIN],
      ['ci', 'reporting', START + 90 * MIN],
      ['old', 'restart', START - MIN],
      ['studio-m2', 'silent', START + MIN],
    ]);
    expect(mine[3]).toEqual({ ...(await look.get('studio')), state: 'silent', lastSeenAt: START + MIN, compat: 'ok' });
    expect(await look.ofOwnerSeen('nobody', START)).toEqual([]);
  });

  it('defaults the start time to now', () => {
    const before = Date.now();
    expect(pgPeerLookup(db).startedAt).toBeGreaterThanOrEqual(before);
  });
});
