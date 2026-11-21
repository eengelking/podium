// The browser's routes for Chat's direct messages (#1034), under /respond/chat/dm. Only the conversation's owner, or an Admin to read, may use them.
// These routes read and write a conversation (`peer_messages`) only: they never touch a channel.
import { type Router } from 'express';
import { asyncHandler } from './asyncHandler.js';
import { limitOf, type ChatBrowserDeps } from './chatChannelRoutes.js';

export function mountChatDmRoutes(browser: Router, d: ChatBrowserDeps): void {
  const direct = () => d.fleet.chat.direct;

  /**
   * The picker for a new Direct Message (#1035): the live orchestrators the viewer may start a conversation with, their own and other people's, never a subagent, a
   * fork or an ended session. Names, owners, machines and states only, never a message's text. The first message goes to `POST /chat/dm/me/<sessionId>/messages`.
   */
  browser.get('/chat/direct-targets', asyncHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    res.json({ ok: true, targets: await direct().targets(v, typeof req.query.q === 'string' ? req.query.q : '') });
  }));

  /** What was concluded for the viewer because an agent in a Direct Message ended (#1283): names and times, never text. */
  browser.get('/chat/concluded', asyncHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    res.json({ ok: true, concluded: v.personId === null ? [] : d.fleet.chat.core.concluded.of(v.personId) });
  }));

  /** The viewer dismisses one of their own. Another person's id answers 404, as an unknown one does. */
  browser.delete('/chat/concluded/:id', asyncHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    if (v.personId === null || !d.fleet.chat.core.concluded.dismiss(v.personId, req.params.id!)) return void res.status(404).json({ ok: false, error: 'There is no such notice.' });
    res.json({ ok: true });
  }));

  browser.get('/chat/dm/:a/:b/messages', asyncHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const limit = limitOf(req.query.limit);
    if (limit === null) return void res.status(400).json({ ok: false, error: 'limit must be a whole number from 1 to 100' });
    const before = typeof req.query.before === 'string' ? req.query.before : null;
    const out = await direct().thread(v, req.params.a!, req.params.b!, { before, limit });
    if ('status' in out) return void d.refuse(req, res, out);
    res.json(out);
  }));

  /** An Admin's open conversation pings this every 15 seconds so its people keep seeing that it is being read. Answers only `ok`. */
  browser.post('/chat/dm/:a/:b/reading', asyncHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const out = await direct().reading(v, req.params.a!, req.params.b!);
    if ('status' in out) return void d.refuse(req, res, out);
    res.json({ ok: true });
  }));

  browser.post('/chat/dm/:a/:b/messages', asyncHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const out = await direct().send(v, req.params.a!, req.params.b!, (req.body ?? {}) as Record<string, unknown>);
    if ('status' in out) return void d.refuse(req, res, out);
    res.status(202).json(out);
  }));

  /** The author edits their own message: `{ text }`. `200 { ok, message }`, the message as a read returns it; refused with 404, 403, 409 (`locked`, `deleted`), 400, 422 or 429. */
  browser.patch('/chat/dm/:a/:b/messages/:id', asyncHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const out = await direct().editMessage(v, req.params.a!, req.params.b!, req.params.id!, (req.body ?? {}) as Record<string, unknown>);
    if ('status' in out) return void d.refuse(req, res, out);
    res.json(out);
  }));

  /** The author deletes their own message; a tombstone stays, and a request that waited for its owner is closed. */
  browser.delete('/chat/dm/:a/:b/messages/:id', asyncHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const out = await direct().deleteMessage(v, req.params.a!, req.params.b!, req.params.id!);
    if ('status' in out) return void d.refuse(req, res, out);
    res.json(out);
  }));

  /** Pause, Resume or Remove the link of a conversation across owners (and the owner opening it again): either person of it, at any time. */
  browser.put('/chat/dm/:a/:b/link', asyncHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const out = await direct().link(v, req.params.a!, req.params.b!, ((req.body ?? {}) as Record<string, unknown>).op);
    if ('status' in out) return void d.refuse(req, res, out);
    res.json(out);
  }));

  /** Delete conversation: its messages and its row. The link and its rights stay. */
  browser.delete('/chat/dm/:a/:b', asyncHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const out = await direct().remove(v, req.params.a!, req.params.b!);
    if ('status' in out) return void d.refuse(req, res, out);
    res.json(out);
  }));
}
