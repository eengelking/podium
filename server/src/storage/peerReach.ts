// Who an orchestrator can reach, the same in every adapter and with no SQL (#1296). The adapters read what this needs once for all of the orchestrators (the reporters in one read, the
// rights in one `effectiveMany`), so a list of peers or a send by name costs the same number of statements for five orchestrators as for fifty; these functions then decide from what was read.
import type { EffectiveRight, LeftOut, LiveOrchestrator, PeerListing, ReporterRef } from '../fleet/peerTypes.js';

/** Whether the orchestrator's reporter is its person's: known, not on the admin secret, and filed under the same `people.id` the orchestrator reported with (#1284), so a reporter that changed hands is not the one it ran on. */
export const onPersonReporter = (o: LiveOrchestrator, r: ReporterRef | null | undefined): boolean => !!r && !r.adminSecret && o.ownerId !== null && r.ownerId === o.ownerId;

/** The live orchestrators of the sender's owner that have messaging on, the ones whose reporter and right are worth reading. The sender itself is among them when it qualifies. */
export const sameOwnerOn = (sender: LiveOrchestrator, live: Iterable<LiveOrchestrator>): LiveOrchestrator[] =>
  sender.ownerId === null ? [] : [...live].filter((o) => o.ownerId === sender.ownerId && o.peers === true);

/** What the adapter reads for the candidates `sameOwnerOn` names: their reporters by key, and the sender's right to each reporter key `rightKeys` asked for. */
export interface ReachRead {
  reporters: ReadonlyMap<string, ReporterRef>;
  /** The sender's right to each reporter key it was asked about. */
  rights: ReadonlyMap<string, EffectiveRight>;
}

/** The reporter keys the sender's right is needed for: each other orchestrator that runs on a person's reporter, and `more`. */
export function rightKeys(sender: LiveOrchestrator, candidates: readonly LiveOrchestrator[], reporters: ReadonlyMap<string, ReporterRef>, more: readonly string[] = []): string[] {
  return [...new Set([...candidates.filter((o) => o.sessionId !== sender.sessionId && onPersonReporter(o, reporters.get(o.reporterKey))).map((o) => o.reporterKey), ...more])];
}

/** The orchestrators among `candidates` that `sender` can reach: on a person's reporter and, unless it is the sender itself, one it has a right to see. */
export const reachedOf = (sender: LiveOrchestrator, candidates: readonly LiveOrchestrator[], read: ReachRead): LiveOrchestrator[] =>
  candidates.filter((o) => onPersonReporter(o, read.reporters.get(o.reporterKey)) && (o.sessionId === sender.sessionId || (read.rights.get(o.reporterKey) as EffectiveRight).level !== 'none'));

/** What `podium_peers` shows of one reachable orchestrator, with the sender's right to it. */
export const listingOf = (o: LiveOrchestrator, right: EffectiveRight): PeerListing => ({
  address: `${o.name}@${o.machine}`,
  id: String(o.agentId),
  name: o.name,
  machine: o.machine,
  os: o.os,
  project: o.project,
  status: o.status,
  level: right.level as PeerListing['level'],
  paused: right.paused,
});

/** The listings in the order the list gives: by address, then by id. */
export const sortListings = (list: PeerListing[]): PeerListing[] => list.sort((a, b) => a.address.localeCompare(b.address) || a.id.localeCompare(b.id));

/** Whether a reporter is a machine the list may name as left out: not the admin secret's and not where the sender itself runs (the mockup lists only the others). */
export const mayBeLeftOut = (r: ReporterRef, sender: LiveOrchestrator): boolean => !r.adminSecret && r.key !== sender.reporterKey;

/** Why a machine that is not listed is not: messaging off or too old to message, no right to see it, or simply no orchestrator running. `right` is the sender's right to it (read only for a reporter with messaging on). */
export function leftOutWhy(r: ReporterRef, right: EffectiveRight | undefined): LeftOut['why'] {
  if (r.peers === null) return 'reporter too old to message';
  if (!r.peers) return 'messaging off on the machine';
  return right?.level === 'none' ? 'no right to see it' : 'no orchestrator running';
}
