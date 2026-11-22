// The reporter-token routes for agents (#1034): post to the group channel or to General, and read either a page at a time. These are the route shapes;
// the finished agent feature (the tools, replying in thread, agents addressing each other) is #1035. They take X-Podium-Token as the report route does,
// the credential must be the person's token that owns the session, and the session's last report must have said `peers: true`. A direct message cannot
// be read from here: the only write besides the channels is an agent's answer in a conversation it is a member of (#1299).
import { type Request, type Response, type Router } from 'express';
import { asyncHandler } from './asyncHandler.js';
import { jsonBody } from '../jsonBody.js';
import { agentGate, refuser } from './routeGate.js';
import { peersEnabled, type PeerDeps } from './peerRoutes.js';
import { agentMessageView } from './chatChannels.js';
import type { Fail } from './chatTypes.js';
import type { LiveOrchestrator } from './peerTypes.js';
import type { PublicChannel } from '../storage/types.js';

export function mountChatAgentRoutes(router: Router, d: PeerDeps): void {
  const { fleet, logger } = d;
  const json = jsonBody({ limit: '128kb' });

  const refuse = refuser(logger, 'chat.refused', { session: true });
  const gate = agentGate(fleet, d.identityOf, refuse, () => peersEnabled(fleet, d.token));

  /** The orchestrator a route is about, when messaging is on and the person's token owns its session and it takes part; otherwise answers. */
  const session = async (req: Request, res: Response): Promise<LiveOrchestrator | null> => {
    // The gate is the one check that messaging is on; the session is read before it, which costs one read for the refusal when it is off.
    return gate(req, res, await fleet.db.getSession(String(req.params.id)))?.o ?? null;
  };

  /** The channel a route names: General, My group or a public channel that exists (#1035); anything else is answered `404` and never reaches a store. */
  const channelOrNot = async (req: Request, res: Response) => {
    const channel = await fleet.chat.channels.resolve(req.params.channel);
    if (!channel) res.status(404).json({ ok: false, error: 'no such channel' });
    return channel;
  };
  const failed = (req: Request, res: Response, f: Fail) => refuse(req, res, f.status, f.error);

  /** The channels an agent can use (#1035): General and every public channel, as the catalogue says them (decision 69), never My group and never a message. The flags are this person's. */
  router.get('/sessions/:id/chat/channels', d.requireToken, asyncHandler(async (req, res) => {
    const o = await session(req, res);
    if (!o) return;
    const person = o.ownerId;
    // Every flag that is on, read once, so a catalogue of 51 channels is not 102 reads of the settings.
    const known = await fleet.chat.core.store.settings.allFlags();
    const entry = async (name: string, meta: PublicChannel | null) => {
      const flags = await fleet.chat.channels.flagsOf(name, null, person, known);
      return {
        name,
        description: meta?.description ?? '',
        link: meta?.link ?? null,
        openedBy: meta ? meta.createdByName || null : null,
        messages: await fleet.chat.channels.total(name, null),
        paused: flags.paused,
        disconnected: flags.disconnected,
      };
    };
    const channels = [await entry('general', null)];
    for (const c of await fleet.chat.core.store.channels.list()) channels.push(await entry(c.name, c));
    res.json({ ok: true, channels });
  }));

  router.post('/sessions/:id/chat/channels/:channel/messages', d.requireToken, json, asyncHandler(async (req, res) => {
    const o = await session(req, res);
    if (!o) return;
    const channel = await channelOrNot(req, res);
    if (!channel) return;
    const out = await fleet.chat.channels.agentPost(o, channel, (req.body ?? {}) as Record<string, unknown>);
    if (!out.ok) return void failed(req, res, out);
    res.status(201).json({ ok: true, id: out.message.id, createdAt: out.message.createdAt });
  }));

  /** An agent answers in a Direct Message of people and agents it is a member of, where a person wrote to it (#1299). The only conversation route here: it reads nothing, and posts only as the agent. */
  router.post('/sessions/:id/chat/conversations/:conversation/messages', d.requireToken, json, asyncHandler(async (req, res) => {
    const o = await session(req, res);
    if (!o) return;
    const out = await fleet.chat.conversations.agentSend(o, String(req.params.conversation), (req.body ?? {}) as Record<string, unknown>);
    if (!out.ok) return void failed(req, res, out);
    res.status(201).json({ ok: true, id: out.id, createdAt: out.createdAt });
  }));

  /** The last hour of a channel the agent was called into: the newest messages that fit in about 30,000 characters, oldest first; `older` is the cursor for the ones before them that are inside the hour. The same for General, My group and every public channel (#1035). */
  router.get('/sessions/:id/chat/channels/:channel/messages', d.requireToken, asyncHandler(async (req, res) => {
    const o = await session(req, res);
    if (!o) return;
    const channel = await channelOrNot(req, res);
    if (!channel) return;
    const before = typeof req.query.before === 'string' ? req.query.before : null;
    const out = await fleet.chat.channels.agentRead(o, channel, before);
    if ('status' in out) return void failed(req, res, out);
    res.json({ ok: true, channel, messages: out.messages.map(agentMessageView), older: out.older });
  }));
}
