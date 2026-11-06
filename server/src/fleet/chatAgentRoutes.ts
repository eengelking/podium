// The reporter-token routes for agents (#1034): post to the group channel or to General, and read either a page at a time. These are the route shapes;
// the finished agent feature (the tools, replying in thread, agents addressing each other) is #1035. They take X-Podium-Token as the report route does,
// the credential must be the person's token that owns the session, and the session's last report must have said `peers: true`. A direct message is not
// reachable from here: the only stores these handlers use are the channels.
import { type Request, type Response, type Router } from 'express';
import { asyncHandler } from './asyncHandler.js';
import { jsonBody } from '../jsonBody.js';
import { nameKey, sourceAddress } from '../storage/rows.js';
import { peersEnabled, type PeerDeps } from './peerRoutes.js';
import { messageView } from './chatChannels.js';
import { channelOf, type Fail } from './chatTypes.js';
import type { LiveOrchestrator } from './peerTypes.js';

export function mountChatAgentRoutes(router: Router, d: PeerDeps): void {
  const { fleet, logger } = d;
  const json = jsonBody({ limit: '128kb' });

  const refuse = (req: Request, res: Response, status: number, reason: string) => {
    logger.warn('chat.refused', `podium: refused ${req.method} ${req.baseUrl}${req.path} from ${sourceAddress(req.ip)}: ${reason}`, { status, reason, source: sourceAddress(req.ip), session_id: typeof req.params.id === 'string' ? req.params.id : null });
    res.status(status).json({ ok: false, error: reason });
  };

  /** The orchestrator a route is about, when messaging is on and the person's token owns its session and it takes part; otherwise answers. */
  const session = async (req: Request, res: Response): Promise<LiveOrchestrator | null> => {
    const no = (status: number, reason: string): null => {
      refuse(req, res, status, reason);
      return null;
    };
    if (!peersEnabled(fleet, d.token)) return no(403, 'orchestrator messaging is off');
    const row = await fleet.db.getSession(String(req.params.id));
    if (!row || !fleet.isLive(row.id)) {
      res.status(404).json({ ok: false, error: 'unknown session', path: '$.id' });
      return null;
    }
    const id = d.identityOf(res);
    if (id.kind !== 'person') return no(403, 'a reporter on the admin secret cannot take part');
    if (row.owner === null || nameKey(row.owner) !== nameKey(id.person.name)) return no(403, 'not your session');
    const o = fleet.peers.messages.live(row.id);
    if (o?.peers !== true) return no(403, "messaging is off on this machine: turn on the reporter's peers option there");
    return o;
  };

  const channelOrNot = (req: Request, res: Response) => {
    const channel = channelOf(String(req.params.channel));
    if (!channel) res.status(404).json({ ok: false, error: 'no such channel' });
    return channel;
  };
  const failed = (req: Request, res: Response, f: Fail) => refuse(req, res, f.status, f.error);

  router.post('/sessions/:id/chat/channels/:channel/messages', d.requireToken, json, asyncHandler(async (req, res) => {
    const o = await session(req, res);
    if (!o) return;
    const channel = channelOrNot(req, res);
    if (!channel) return;
    const out = await fleet.chat.channels.agentPost(o, channel, (req.body ?? {}) as Record<string, unknown>);
    if (!out.ok) return void failed(req, res, out);
    res.status(201).json({ ok: true, id: out.message.id, createdAt: out.message.createdAt });
  }));

  /** The newest messages that fit in about 30,000 characters, oldest first; `older` is the cursor for the ones before them. */
  router.get('/sessions/:id/chat/channels/:channel/messages', d.requireToken, asyncHandler(async (req, res) => {
    const o = await session(req, res);
    if (!o) return;
    const channel = channelOrNot(req, res);
    if (!channel) return;
    const before = typeof req.query.before === 'string' ? req.query.before : null;
    const out = await fleet.chat.channels.agentRead(o, channel, before);
    if ('status' in out) return void failed(req, res, out);
    res.json({ ok: true, channel, messages: out.messages.map((m) => messageView(m, null)), older: out.older });
  }));
}
