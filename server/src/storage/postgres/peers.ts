// The peer store on PostgreSQL (#822): the SQLite store's logic over `PgDb`. Each storage-touching method is one transaction, so a
// rights check and the insert it allows, an answer and the delivery it causes, or a retention pass cannot be split by another
// task. The gate in `PgDb.tx` takes transactions one at a time, as the SQLite lock took steps. Only a read of the live directory
// (`messages.live`) answers at once: it is memory.
import type { PeerStoreApi, PeerStoreOptions, AsyncPeerReporterLookup } from '../types.js';
import type { PgDb } from './conn.js';
import { PgPeerService } from './peerService.js';
import { pgPeerLookup } from './peerLookup.js';

export const pgPeers = (db: PgDb, opts: PeerStoreOptions): PeerStoreApi => peerStoreOver(db, pgPeerLookup(db, opts.startedAt), opts);

/** The store over a given reporter lookup (the tests pass a hand-written one). */
export function peerStoreOver(db: PgDb, lookup: AsyncPeerReporterLookup, opts: PeerStoreOptions): PeerStoreApi {
  const svc = new PgPeerService(db, lookup, opts.now, opts.flagOn);
  const step = <T>(fn: () => Promise<T>): Promise<T> => db.tx(fn);
  /** Each named method of `target` as one step, so calls are served in the order they were asked for, as the SQLite lock served them. */
  const stepped = <T extends object, K extends keyof T>(target: T, names: readonly K[]): Pick<T, K> => {
    const out: Record<string, unknown> = {};
    for (const name of names) {
      const fn = target[name] as unknown as (...a: unknown[]) => Promise<unknown>;
      out[name as string] = (...args: unknown[]) => step(() => fn.apply(target, args));
    }
    return out as Pick<T, K>;
  };
  return {
    reporters: lookup,
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
    settings: stepped(svc.settings, ['get', 'set', 'limits', 'retainMs']),
    rights: stepped(svc.rights, ['effective', 'rightsOf', 'defaults', 'limits', 'setRight', 'pauseLink', 'pauseReporter', 'propose', 'requestAccess', 'openRequests']),
    messages: {
      live: (sessionId) => svc.messages.live(sessionId),
      ...stepped(svc.messages, ['list', 'send', 'result', 'conversations', 'conversation']),
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
