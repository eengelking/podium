// What the chat, peer, session-read, recording and respond routes share: the refusal that is logged and answered, and the gate a reporter's token passes to act for
// one of its person's live orchestrators. Each route file passes its own log name; nothing here reads a message.
import type { Request, Response } from 'express';
import type { Logger } from '../logging/logger.js';
import { sourceAddress, type PersonRow, type SessionRow } from '../storage/rows.js';
import type { Fleet } from './fleet.js';
import type { LiveOrchestrator } from './peerTypes.js';
import type { Identity } from './routes.js';

export const sourceOf = (req: Request): string => sourceAddress(req.ip);

/** Logs a refusal (the status, the words and where it came from, never a body) and answers it. `extra` is added to the body. */
export type Refuse = (req: Request, res: Response, status: number, reason: string, extra?: Record<string, unknown>) => void;

/** The refusal of a route file, logged under `kind`. A route that is about a session (`:id`) also logs which one. */
export function refuser(logger: Logger, kind: string, opts: { session?: boolean } = {}): Refuse {
  return (req, res, status, reason, extra = {}) => {
    const session = opts.session ? { session_id: typeof req.params.id === 'string' ? req.params.id : null } : {};
    logger.warn(kind, `podium: refused ${req.method} ${req.baseUrl}${req.path} from ${sourceOf(req)}: ${reason}`, { status, reason, source: sourceOf(req), ...session });
    res.status(status).json({ ok: false, error: reason, ...extra });
  };
}

/**
 * The gate of a route a reporter's token calls for one of its person's sessions: messaging is on, the session is live, the credential is a person's and owns it, and the
 * reporter takes part (`peers`). Otherwise it answers and returns null. `row` is the session as the handler just read it, and the checks are synchronous, so what the
 * handler does after them runs in one turn, with nothing able to end or delete the session in between.
 */
export function agentGate(fleet: Fleet, identityOf: (res: Response) => Identity, refuse: Refuse, enabled: () => boolean) {
  return (req: Request, res: Response, row: SessionRow | undefined): { row: SessionRow; o: LiveOrchestrator; person: PersonRow } | null => {
    const no = (status: number, reason: string): null => {
      refuse(req, res, status, reason);
      return null;
    };
    if (!enabled()) return no(403, 'orchestrator messaging is off');
    if (!row || !fleet.isLive(row.id)) {
      res.status(404).json({ ok: false, error: 'unknown session', path: '$.id' });
      return null;
    }
    const id = identityOf(res);
    if (id.kind !== 'person') return no(403, 'a reporter on the admin secret cannot take part');
    if (row.owner_id === null || row.owner_id !== id.person.id) return no(403, 'not your session');
    const o = fleet.peers.messages.live(row.id);
    if (o?.peers !== true) return no(403, "messaging is off on this machine: turn on the reporter's peers option there");
    return { row, o, person: id.person };
  };
}
