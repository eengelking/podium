// The browser's routes for Chat's conversations of people and agents (#1278), under /respond/chat. Only a member may use them, and an Admin only to read one that has an
// agent in it. These routes read and write `conversation_*` only: they never touch a channel or a `peer_messages` row.
import { type Router } from 'express';
import { pageOf, type ChatBrowserDeps } from './chatChannelRoutes.js';

export function mountChatConversationRoutes(browser: Router, d: ChatBrowserDeps): void {
  const chatHandler = d.fleet.chat.handler;
  const conv = () => d.fleet.chat.conversations;

  /** Who the viewer can write to: every person who can sign in, running or not, and the conversation that already holds exactly the two of them. Names only. */
  browser.get('/chat/people', chatHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const out = await conv().peopleFor(v, typeof req.query.q === 'string' ? req.query.q : '');
    if ('status' in out) return void d.refuse(req, res, out);
    res.json(out);
  }));

  /** `{ members: [{ kind: 'person', name } | { kind: 'agent', sessionId }], text? }`: opens the conversation of exactly those members and the viewer, or answers the one that exists. */
  browser.post('/chat/conversations', chatHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const out = await conv().open(v, (req.body ?? {}) as Record<string, unknown>);
    if ('status' in out) return void d.refuse(req, res, out);
    res.status(out.created ? 201 : 200).json(out);
  }));

  browser.get('/chat/conversations/:id/messages', chatHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const page = pageOf(req, res);
    if (!page) return;
    const out = await conv().thread(v, req.params.id!, page);
    if ('status' in out) return void d.refuse(req, res, out);
    res.json(out);
  }));

  /** An Admin's open conversation (one with an agent in it) pings this every 15 seconds so its people keep seeing that it is being read. */
  browser.post('/chat/conversations/:id/reading', chatHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const out = await conv().reading(v, req.params.id!);
    if ('status' in out) return void d.refuse(req, res, out);
    res.json({ ok: true });
  }));

  browser.post('/chat/conversations/:id/messages', chatHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const out = await conv().send(v, req.params.id!, (req.body ?? {}) as Record<string, unknown>);
    if ('status' in out) return void d.refuse(req, res, out);
    res.status(201).json(out);
  }));

  browser.patch('/chat/conversations/:id/messages/:messageId', chatHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const out = await conv().editMessage(v, req.params.id!, req.params.messageId!, (req.body ?? {}) as Record<string, unknown>);
    if ('status' in out) return void d.refuse(req, res, out);
    res.json(out);
  }));

  browser.delete('/chat/conversations/:id/messages/:messageId', chatHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const out = await conv().deleteMessage(v, req.params.id!, req.params.messageId!);
    if ('status' in out) return void d.refuse(req, res, out);
    res.json(out);
  }));

  /** `{ members: [...] }`: a member adds people or their own agents. */
  browser.post('/chat/conversations/:id/members', chatHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const out = await conv().addMembers(v, req.params.id!, (req.body ?? {}) as Record<string, unknown>);
    if ('status' in out) return void d.refuse(req, res, out);
    res.json(out);
  }));

  /** The viewer leaves. The last person to leave deletes it. */
  browser.delete('/chat/conversations/:id/members/me', chatHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const out = await conv().leave(v, req.params.id!);
    if ('status' in out) return void d.refuse(req, res, out);
    res.json(out);
  }));
}
