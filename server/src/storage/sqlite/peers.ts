import type { DatabaseSync } from 'node:sqlite';
import { ReporterStore } from './reporters.js';
import { PeerService } from './peerService.js';
import type { PeerReporterLookup } from '../../fleet/peerTypes.js';
import type { AsyncPeerReporterLookup, PeerStoreApi, PeerStoreOptions } from '../types.js';
import type { AsyncLock } from './lock.js';

/** The reporter lookup with each read taken under the connection's lock. */
export function asyncLookupOver(lookup: PeerReporterLookup, lock: AsyncLock): AsyncPeerReporterLookup {
  return {
    startedAt: lookup.startedAt,
    ofOwnerSeen: (owner, at) => lock.run(() => lookup.ofOwnerSeen(owner, at)),
    get: (key) => lock.run(() => lookup.get(key)),
    ofOwner: (owner) => lock.run(() => lookup.ofOwner(owner)),
  };
}

/** Each named method of `target` as an async one that runs the synchronous call under the lock. Only the names given are reachable. */
function bound<T extends object, K extends keyof T>(target: T, lock: AsyncLock, names: readonly K[]): { [P in K]: T[P] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never } {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const fn = target[name] as unknown as (...a: unknown[]) => unknown;
    out[name as string] = (...args: unknown[]) => lock.run(() => fn.apply(target, args));
  }
  return out as never;
}

/**
 * The peer service over the connection. The synchronous service is kept whole and each step of it runs under the lock, so
 * a rights check and the insert it allows, an answer and the delivery it causes, or a retention pass cannot be split by
 * another task, in or out of a transaction. Steps run in the order they were asked for, as the synchronous calls did. Only a
 * read of the live directory (`messages.live`) answers at once: it is memory, and the routes check it and act in one turn.
 */
export function peerStoreOver(db: DatabaseSync, lock: AsyncLock, opts: PeerStoreOptions): PeerStoreApi {
  const lookup = new ReporterStore(db, opts.startedAt).peerLookup();
  const svc = new PeerService(db, lookup, opts.now, opts.flagOn);
  const step = <T>(fn: () => T): Promise<T> => lock.run(fn);
  return {
    reporters: asyncLookupOver(lookup, lock),
    flagOn: () => svc.flagOn(),
    get onRights() {
      return svc.onRights;
    },
    set onRights(f) {
      svc.onRights = f;
    },
    get onMessage() {
      return svc.onMessage;
    },
    set onMessage(f) {
      svc.onMessage = f;
    },
    withSource: (_src, fn) => fn(),
    settings: bound(svc.settings, lock, ['get', 'set', 'limits', 'retainMs']),
    rights: bound(svc.rights, lock, ['effective', 'rightsOf', 'defaults', 'limits', 'setRight', 'pauseLink', 'pauseReporter', 'propose', 'requestAccess', 'openRequests']),
    messages: {
      live: (sessionId) => svc.messages.live(sessionId),
      ...bound(svc.messages, lock, ['list', 'send', 'result', 'conversations', 'conversation']),
    },
    note: (sessionId, reporterKey, owner, report) => step(() => svc.note(sessionId, reporterKey, owner, report)),
    replyFor: (sessionId, allowed) => step(() => svc.replyFor(sessionId, allowed)),
    answer: (id, owner, answer, actor) => step(() => svc.answer(id, owner, answer, actor)),
    answerPaused: (id, owner, answer, actor) => step(() => svc.answerPaused(id, owner, answer, actor)),
    removeLink: (owner, a, b, actor) => step(() => svc.removeLink(owner, a, b, actor)),
    setDefaults: (owner, patch, actor) => step(() => svc.setDefaults(owner, patch, actor)),
    ownerView: (owner, now) => step(() => svc.ownerView(owner, now)),
    adminView: (key) => step(() => svc.adminView(key)),
    ended: (sessionId) => step(() => svc.ended(sessionId)),
    deleted: (sessionIds) => step(() => svc.deleted(sessionIds)),
    dropAll: () => step(() => svc.dropAll()),
    retain: () => step(() => svc.retain()),
  };
}
