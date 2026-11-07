// Routes for Chat (#1034, SPEC 7.1, 7.7). Three sides, kept in separate files so a missed filter cannot send one audience's text to another:
// the channels (chatChannelRoutes.ts), the direct messages (chatDmRoutes.ts) and what an agent may do with its reporter's token (chatAgentRoutes.ts).
// This file is the gate they share, the overview (counts and names, never text), the read marker and the audit rows.
import { type Request, type Response, type Router } from 'express';
import { asyncHandler } from './asyncHandler.js';
import { mountChatAgentRoutes } from './chatAgentRoutes.js';
import { mountChatChannelRoutes, type ChatBrowserDeps } from './chatChannelRoutes.js';
import { mountChatDmRoutes } from './chatDmRoutes.js';
import { CHANNEL_NAMES, type ChatEvent, type ChatViewer, type Fail } from './chatTypes.js';
import { ADMIN_OWNER, ADMIN_SECRET_ACTOR, sourceAddress } from '../storage/rows.js';
import { peersEnabled, type BrowserHelpers, type PeerDeps } from './peerRoutes.js';
import type { Fleet } from './fleet.js';
import type { Logger } from '../logging/logger.js';
import type { PeopleStoreApi } from '../storage/types.js';

const short = (id: string): string => id.slice(0, 12);

/** The Admin log and the server log get every Chat event: who, which channel or conversation, and ids. Never a message's text. */
export function wireChatLogs(fleet: Fleet, people: PeopleStoreApi | null, logger: Logger): void {
  const row = (kind: string, detail: string, actor: string | null, fields: Record<string, unknown>) => {
    void Promise.resolve(people?.log(kind, detail, 'server', fleet.now(), actor))
      .then(() => logger.info(`chat.${kind}`, `podium: ${detail}`, fields as Record<string, string | number | boolean | null>))
      .catch((err: Error) => logger.warn('chat.trail_failed', `podium: could not log a Chat event: ${err.message}`, { reason: err.message }));
  };
  const actorName = (by: string): string => (by === ADMIN_OWNER ? ADMIN_SECRET_ACTOR : by);
  fleet.chat.onEvent = (e: ChatEvent) => {
    switch (e.kind) {
      case 'sent':
      case 'delivered':
      case 'dropped': {
        const prefix = e.channel === 'group' ? 'group' : 'general';
        const where = `${CHANNEL_NAMES[e.channel]}${e.owner ? `, ${e.owner}'s` : ''}`;
        const words = e.kind === 'sent' ? 'Message posted' : e.kind === 'delivered' ? 'Message delivered to an agent' : `Message not delivered${e.why ? `: ${e.why}` : ''}`;
        row(`${prefix}_${e.kind}`, `${words} in ${where} [${short(e.messageId)}]${e.sessionId ? ` (${short(e.sessionId)})` : ''}`, actorName(e.by), { channel: e.channel, owner: e.owner, message_id: short(e.messageId), by: e.by });
        break;
      }
      case 'paused':
      case 'resumed':
      case 'disconnected':
      case 'reconnected':
      case 'cleared': {
        const prefix = e.channel === 'group' ? 'group' : 'general';
        const what = e.kind === 'cleared' ? `all ${e.count} messages removed` : `${e.kind}${e.everyone ? ' for everyone' : ''}${e.count ? `, ${e.count} held messages delivered` : ''}`;
        row(`${prefix}_${e.kind}`, `${CHANNEL_NAMES[e.channel]}${e.owner ? `, ${e.owner}'s` : ''}: ${what}`, actorName(e.by), { channel: e.channel, owner: e.owner, everyone: e.everyone, count: e.count });
        break;
      }
      case 'dm_sent':
        row('chat_sent', `A person sent a message in a direct message, ${e.owner}'s [${short(e.messageId)}] (${short(e.sessionId)})`, actorName(e.by), { owner: e.owner, message_id: short(e.messageId), session_id: e.sessionId });
        break;
      case 'across':
        row(e.approval ? 'chat_across_requested' : 'chat_across_sent', `${e.approval ? 'Asked' : 'Wrote to'} ${e.owner}'s agent for ${e.person} [${short(e.messageId)}] (${short(e.sessionId)})`, actorName(e.by), { owner: e.owner, person: e.person, message_id: short(e.messageId), session_id: e.sessionId, approval: e.approval });
        break;
      case 'dm_deleted':
        row('chat_deleted', `Deleted a conversation, ${e.owner}'s: ${e.count} messages (${short(e.a)}, ${short(e.b)})`, actorName(e.by), { owner: e.owner, count: e.count });
        break;
      case 'admin_read': {
        const where = e.scope === 'group' ? `${e.owners.join(', ')}'s My group` : `a Direct Message of ${e.owners.join(' and ')}`;
        row('chat_admin_read', `${e.by} read ${where}`, actorName(e.by), { scope: e.scope, thread: e.thread, owners: e.owners.join(','), by: e.by });
        break;
      }
      case 'admin_browse':
        row('chat_admin_browse', `${e.by} browsed the list of ${e.person}'s conversations (names and counts only)`, actorName(e.by), { person: e.person, by: e.by });
        break;
      case 'purged':
        row('chat_purged', `Chat retention removed ${e.channelMessages} channel messages and ${e.directMessages} messages of hidden conversations`, 'sweeper', { channel_messages: e.channelMessages, direct_messages: e.directMessages });
        break;
    }
  };
}

/** The browser side: every Chat route needs orchestrator messaging on and a signed-in viewer. */
export function mountChatBrowserRoutes(browser: Router, d: PeerDeps, h: BrowserHelpers): void {
  const { fleet, logger } = d;
  fleet.chat.people = d.people;
  wireChatLogs(fleet, d.people, logger);
  const enabled = () => peersEnabled(fleet, d.token);

  const refuse = (req: Request, res: Response, f: Fail) => {
    logger.warn('chat.refused', `podium: refused ${req.method} ${req.baseUrl}${req.path} from ${sourceAddress(req.ip)}: ${f.error}`, { status: f.status, reason: f.error, source: sourceAddress(req.ip) });
    res.status(f.status).json({ ok: false, error: f.error });
  };

  const viewer = async (req: Request, res: Response): Promise<ChatViewer | null> => {
    if (!enabled()) {
      refuse(req, res, { ok: false, status: 403, error: 'orchestrator messaging is off' });
      return null;
    }
    const v = await h.viewerOf(req);
    if (!v) {
      refuse(req, res, { ok: false, status: 403, error: 'sign in to use Chat' });
      return null;
    }
    return v;
  };

  const deps: ChatBrowserDeps = { fleet, viewer, refuse };

  browser.get('/chat', asyncHandler(async (req, res) => {
    const v = await viewer(req, res);
    if (!v) return;
    // `?owner=<name>`: an Admin browses that person's Chat (names and counts, never text).
    const owner = req.query.owner;
    if (owner === undefined) return void res.json(await fleet.chat.overview(v));
    if (typeof owner !== 'string' || owner.trim() === '') return void refuse(req, res, { ok: false, status: 400, error: 'owner must be one person\'s name' });
    const out = await fleet.chat.browse(v, owner.trim());
    if ('status' in out) return void refuse(req, res, out);
    res.json(out);
  }));

  browser.post('/chat/read', asyncHandler(async (req, res) => {
    const v = await viewer(req, res);
    if (!v) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const out = await fleet.chat.markRead(v, b.thread, b.upTo);
    if ('status' in out) return void refuse(req, res, out);
    res.json(out);
  }));

  mountChatChannelRoutes(browser, deps);
  mountChatDmRoutes(browser, deps);
}

export { mountChatAgentRoutes };
