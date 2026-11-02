// The contract case for a database that already holds data when it is upgraded (#892). The cases in contract.ts open a fresh database, so no
// migration ever runs on rows that exist. Here an adapter builds a database at the schema before a row-rewriting migration, loads the same rows,
// and opens it as a Storage (which migrates it); what comes back through the interface is written out below and must be the same in every adapter.
import { it, expect } from 'vitest';
import type { Actor } from '../fleet/peerTypes.js';
import type { Storage } from './types.js';

/** A peer request as an older database stores it, before it had an insertion number. */
export interface LegacyRequest {
  id: string;
  owner: string;
  kind: 'proposal' | 'access';
  fromKey: string;
  toKey: string;
  level: 'see' | 'send';
  reason: string | null;
  by: string;
  fromSession: string | null;
  createdAt: number;
  closedAt: number | null;
  outcome: string | null;
}

/** What an adapter provides: a Storage over a database built at the schema before the request insertion number, holding `rows` inserted in the order given. */
export interface UpgradeOpeners {
  openUpgraded(rows: LegacyRequest[]): Promise<Storage>;
}

const T0 = 1_800_000_000_000;
const ED: Actor = { name: 'ed', admin: false };

const req = (id: string, createdAt: number, over: Partial<LegacyRequest> = {}): LegacyRequest => ({
  id, owner: 'ed', kind: 'access', fromKey: 'k1', toKey: 'k2', level: 'see', reason: `why-${id}`, by: 'alpha', fromSession: 's1', createdAt, closedAt: null, outcome: null, ...over,
});

// Inserted out of time order. `prq_a` and `prq_c` share a time and are inserted in id order, the one tie that an adapter
// numbering by insertion order and one numbering by id both settle the same way.
const FIXTURE: LegacyRequest[] = [
  req('prq_a', T0 + 5000),
  req('prq_c', T0 + 5000),
  req('prq_b', T0 + 4000, { fromSession: null }),
  req('prq_z', T0 + 1000, { owner: 'eve' }),
  req('prq_done', T0 + 3000, { closedAt: T0 + 9000, outcome: 'declined' }),
  req('prq_prop', T0 + 6000, { kind: 'proposal', level: 'send', reason: null, by: 'Admin' }),
];

export function upgradeCases(o: UpgradeOpeners): void {
  it('keeps every peer request, its values and its order when a database made before their insertion number is upgraded', async () => {
    const s = await o.openUpgraded(FIXTURE);
    try {
      const open = await s.peers({ now: () => T0 + 10_000, flagOn: () => true, startedAt: T0 }).rights.openRequests('ed');
      expect(open.map((r) => r.id)).toEqual(['prq_b', 'prq_a', 'prq_c', 'prq_prop']);
      expect(open.find((r) => r.id === 'prq_b')).toEqual({
        id: 'prq_b', owner: 'ed', kind: 'access', fromKey: 'k1', toKey: 'k2', level: 'see', reason: 'why-prq_b', by: 'alpha', fromSession: null,
        messageId: null, createdAt: T0 + 4000, closedAt: null, outcome: null,
      });
      expect(open.find((r) => r.id === 'prq_prop')).toMatchObject({ kind: 'proposal', level: 'send', reason: null, by: 'Admin', createdAt: T0 + 6000 });
      expect((await s.peers({ now: () => T0, flagOn: () => true, startedAt: T0 }).rights.openRequests('eve')).map((r) => r.id)).toEqual(['prq_z']);
    } finally {
      await s.close();
    }
  });

  it('numbers a request made after the upgrade after every request already there', async () => {
    const s = await o.openUpgraded(FIXTURE);
    try {
      const peers = s.peers({ now: () => T0 + 5000, flagOn: () => true, startedAt: T0 });
      const a = await s.reporters.record({ kind: 'mod', machineId: 'ma', machineName: 'box-a', source: '127.0.0.1', owner: 'ed', credential: 'person', version: '1.2.0', engineVersion: null, sessionId: 'sa', os: 'macOS', peers: true }, T0);
      const b = await s.reporters.record({ kind: 'mod', machineId: 'mb', machineName: 'box-b', source: '127.0.0.1', owner: 'ed', credential: 'person', version: '1.2.0', engineVersion: null, sessionId: 'sb', os: 'macOS', peers: true }, T0);
      const made = await peers.rights.propose(a, b, 'see', ED);
      expect(made).toMatchObject({ ok: true });
      // The same time as prq_a and prq_c: only the number the migration left decides that the new one comes last.
      const ids = (await peers.rights.openRequests('ed')).map((r) => r.id);
      expect(ids.slice(0, 3)).toEqual(['prq_b', 'prq_a', 'prq_c']);
      expect(ids).toHaveLength(5);
      expect(ids[3]).toBe((made as { request: { id: string } }).request.id);
    } finally {
      await s.close();
    }
  });
}
