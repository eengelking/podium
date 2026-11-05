// Test support for the peer stores on PostgreSQL (#822): a reporter lookup held in memory, so a test does not need the reporters store.
import type { ReporterRef, SeenReporterRef } from '../../fleet/peerTypes.js';
import { nameKey } from '../rows.js';
import type { AsyncPeerReporterLookup } from '../types.js';

export interface FakeReporters {
  readonly lookup: AsyncPeerReporterLookup;
  readonly reps: Map<string, ReporterRef>;
}

/** A lookup over `reps`; `ofOwner` lists in the order the reporters store does (machine name folded, then key). */
export function fakeReporters(startedAt: number): FakeReporters {
  const reps = new Map<string, ReporterRef>();
  const ofOwner = async (owner: string): Promise<ReporterRef[]> =>
    [...reps.values()]
      .filter((r) => r.owner !== null && nameKey(r.owner) === nameKey(owner))
      .sort((a, b) => a.machine.toLowerCase().localeCompare(b.machine.toLowerCase()) || a.key.localeCompare(b.key));
  const lookup: AsyncPeerReporterLookup = {
    startedAt,
    get: async (key) => reps.get(key) ?? null,
    ofOwner,
    ofOwnerSeen: async (owner) => (await ofOwner(owner)).map((r) => ({ ...r, state: 'live', lastSeenAt: startedAt, compat: { level: 'ok' } }) as unknown as SeenReporterRef),
  };
  return { lookup, reps };
}
