// Routes for Chat (#1034, SPEC 7.1, 7.7). Three sides, kept in separate files so a missed filter cannot send one audience's text to another:
// the channels (chatChannelRoutes.ts), the direct messages (chatDmRoutes.ts) and what an agent may do with its reporter's token (chatAgentRoutes.ts).
// This file is the gate they share, the overview (counts and names, never text), the read marker and the audit rows.
import { type Request, type Response, type Router } from 'express';
import { mountChatAgentRoutes } from './chatAgentRoutes.js';
import { mountChatChannelRoutes, type ChatBrowserDeps } from './chatChannelRoutes.js';
import { mountChatDmRoutes } from './chatDmRoutes.js';
import { mountChatConversationRoutes } from './chatConversationRoutes.js';
import { channelName, GENERAL, type ChatEvent, type ChatViewer, type Fail } from './chatTypes.js';
import { ADMIN_OWNER, ADMIN_SECRET_ACTOR } from '../storage/rows.js';
import { peersEnabled, type BrowserHelpers, type PeerDeps } from './peerRoutes.js';
import { refuser } from './routeGate.js';
import type { Fleet } from './fleet.js';
import type { Logger } from '../logging/logger.js';
import type { PeopleStoreApi } from '../storage/types.js';

const short = (id: string): string => id.slice(0, 12);

/** The Admin log and the server log get every Chat event: who, which channel or conversation, and ids. Never a message's text. */
function wireChatLogs(fleet: Fleet, people: PeopleStoreApi | null, logger: Logger): void {
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
        const prefix = e.channel === 'group' ? 'group' : e.channel === 'general' ? 'general' : 'channel';
        const where = `${channelName(e.channel)}${e.owner ? `, ${e.owner}'s` : ''}`;
        const words = e.kind === 'sent' ? 'Message posted' : e.kind === 'delivered' ? 'Message delivered to an agent' : `Message not delivered${e.why ? `: ${e.why}` : ''}`;
        row(`${prefix}_${e.kind}`, `${words} in ${where} [${short(e.messageId)}]${e.sessionId ? ` (${short(e.sessionId)})` : ''}`, actorName(e.by), { channel: e.channel, owner: e.owner, message_id: short(e.messageId), by: e.by });
        break;
      }
      case 'paused':
      case 'resumed':
      case 'disconnected':
      case 'reconnected':
      case 'cleared': {
        const prefix = e.channel === 'group' ? 'group' : e.channel === 'general' ? 'general' : 'channel';
        const what = e.kind === 'cleared' ? `all ${e.count} messages removed` : `${e.kind}${e.everyone ? ' for everyone' : ''}${e.count ? `, ${e.count} held messages delivered` : ''}`;
        row(`${prefix}_${e.kind}`, `${channelName(e.channel)}${e.owner ? `, ${e.owner}'s` : ''}: ${what}`, actorName(e.by), { channel: e.channel, owner: e.owner, everyone: e.everyone, count: e.count });
        break;
      }
      case 'dm_sent':
        row('chat_sent', `A person sent a message in a direct message, ${e.owner}'s [${short(e.messageId)}] (${short(e.sessionId)})`, actorName(e.by), { owner: e.owner, message_id: short(e.messageId), session_id: e.sessionId });
        break;
      case 'across':
        row(e.approval ? 'chat_across_requested' : 'chat_across_sent', `${e.approval ? 'Asked' : 'Wrote to'} ${e.owner}'s agent for ${e.person} [${short(e.messageId)}] (${short(e.sessionId)})`, actorName(e.by), { owner: e.owner, person: e.person, message_id: short(e.messageId), session_id: e.sessionId, approval: e.approval });
        break;
      case 'message_edited':
      case 'message_deleted': {
        // Ids and where, never the text: the author changed their own message (#1269).
        const prefix = e.scope === 'dm' ? 'chat' : e.channel === 'group' ? 'group' : e.channel === GENERAL ? 'general' : 'channel';
        const where = e.scope === 'dm' ? `a direct message, ${e.owner}'s` : `${channelName(e.channel as string)}${e.owner ? `, ${e.owner}'s` : ''}`;
        row(`${prefix}_${e.kind}`, `${e.kind === 'message_edited' ? 'Edited' : 'Deleted'} own message in ${where} [${short(e.messageId)}]`, actorName(e.by), { scope: e.scope, channel: e.channel, owner: e.owner, message_id: short(e.messageId), by: e.by });
        break;
      }
      case 'dm_deleted':
        row('chat_deleted', `Deleted a conversation, ${e.owner}'s: ${e.count} messages (${short(e.a)}, ${short(e.b)})`, actorName(e.by), { owner: e.owner, count: e.count });
        break;
      case 'dm_concluded':
        row('chat_concluded', `Concluded a conversation, ${e.owner}'s, because an agent in it ended: ${e.count} messages (${short(e.a)}, ${short(e.b)})`, 'Podium', { owner: e.owner, count: e.count });
        break;
      case 'admin_read': {
        const where = e.scope === 'group' ? `${e.owners.join(', ')}'s My group` : `a Direct Message of ${e.owners.join(' and ')}`;
        row('chat_admin_read', `${e.by} read ${where}`, actorName(e.by), { scope: e.scope, thread: e.thread, owners: e.owners.join(','), by: e.by });
        break;
      }
      case 'admin_browse':
        row('chat_admin_browse', `${e.by} browsed the list of ${e.person}'s conversations (names and counts only)`, actorName(e.by), { person: e.person, by: e.by });
        break;
      case 'channel_opened':
      case 'channel_edited':
      case 'channel_removed': {
        const words = e.kind === 'channel_opened' ? 'opened' : e.kind === 'channel_edited' ? 'changed the description of' : `removed${e.messages ? ` (with ${e.messages} messages)` : ''}`;
        // An Admin's edit or removal of a channel somebody else opened names the opener and how many of their sessions show it now (#1328), as the link stops do.
        const told = e.opener === undefined ? '' : e.unrecorded ? ` (opened by ${e.opener}, NOT recorded for them)` : ` (opened by ${e.opener}, ${e.told ?? 0} session${e.told === 1 ? '' : 's'} told)`;
        row(e.kind, `${e.kind === 'channel_removed' ? `Public channel ${e.channel} ${words}` : `${words.replace(/^./, (c) => c.toUpperCase())} public channel ${e.channel}`}${told}`, actorName(e.by), { channel: e.channel, by: e.by, ...(e.opener === undefined ? {} : { opener: e.opener, told: e.told ?? 0 }) });
        break;
      }
      case 'conversation_opened':
        row('conversation_opened', `Opened a conversation of ${e.members} members [${short(e.conversation)}]`, actorName(e.by), { conversation: short(e.conversation), members: e.members });
        break;
      case 'conversation_sent':
        row('conversation_sent', `Sent a message in a conversation [${short(e.conversation)}] [${short(e.messageId)}]`, actorName(e.by), { conversation: short(e.conversation), message_id: short(e.messageId) });
        break;
      case 'conversation_message_edited':
      case 'conversation_message_deleted':
        row(e.kind, `${e.kind === 'conversation_message_edited' ? 'Edited' : 'Deleted'} own message in a conversation [${short(e.conversation)}] [${short(e.messageId)}]`, actorName(e.by), { conversation: short(e.conversation), message_id: short(e.messageId) });
        break;
      case 'conversation_members_added':
        row('conversation_members_added', `Added ${e.count} to a conversation [${short(e.conversation)}]`, actorName(e.by), { conversation: short(e.conversation), count: e.count });
        break;
      case 'conversation_left':
        row('conversation_left', `Left a conversation${e.deleted ? ' (the last person, so it was deleted)' : ''} [${short(e.conversation)}]`, actorName(e.by), { conversation: short(e.conversation), deleted: e.deleted });
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
  const chatHandler = fleet.chat.handler;
  fleet.chat.people = d.people;
  wireChatLogs(fleet, d.people, logger);
  const enabled = () => peersEnabled(fleet, d.token);

  const refuseWith = refuser(logger, 'chat.refused');
  const refuse = (req: Request, res: Response, f: Fail) => refuseWith(req, res, f.status, f.error, f.reason ? { reason: f.reason } : {});

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

  browser.get('/chat', chatHandler(async (req, res) => {
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

  browser.post('/chat/read', chatHandler(async (req, res) => {
    const v = await viewer(req, res);
    if (!v) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const out = await fleet.chat.markRead(v, b.thread, b.upTo);
    if ('status' in out) return void refuse(req, res, out);
    res.json(out);
  }));

  mountChatChannelRoutes(browser, deps);
  mountChatDmRoutes(browser, deps);
  mountChatConversationRoutes(browser, deps);
}

export { mountChatAgentRoutes };
