// The browser's routes for Chat's channels (#1034), under /respond/chat/channels. Mounted on responding's browser router, so they share its sign-in
// cookie, its cross-site check and its no-store header. These routes read and write General and My group only: they never touch a direct message.
import { type Request, type Response, type Router } from 'express';
import { asyncHandler } from './asyncHandler.js';
import type { Fleet } from './fleet.js';
import { messageView } from './chatChannels.js';
import { fail, GROUP, GENERAL, isPublicChannel, type ChannelId, type ChatViewer, type Fail } from './chatTypes.js';

/** What Chat's browser routes share: the gate (messaging on, and a signed-in viewer) and how a refusal is answered. */
export interface ChatBrowserDeps {
  fleet: Fleet;
  viewer: (req: Request, res: Response) => Promise<ChatViewer | null>;
  refuse: (req: Request, res: Response, f: Fail) => void;
}

const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;

/** A page size from a query: 1 to 100, 50 when absent. Null for anything else. */
export function limitOf(raw: unknown): number | null {
  if (raw === undefined || raw === '') return PAGE_DEFAULT;
  if (typeof raw !== 'string' || !/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= PAGE_MAX ? n : null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function mountChatChannelRoutes(browser: Router, d: ChatBrowserDeps): void {
  const { fleet } = d;
  const channels = () => fleet.chat.channels;

  /** The viewer and the channel a route is about, or an answer already sent. */
  const target = async (req: Request, res: Response, named: unknown): Promise<{ v: ChatViewer; channel: ChannelId; owner: string | null } | null> => {
    const v = await d.viewer(req, res);
    if (!v) return null;
    const channel = await channels().resolve(req.params.channel);
    if (!channel) {
      res.status(404).json({ ok: false, error: 'no such channel' });
      return null;
    }
    const scope = channels().scopeFor(v, channel, str(named));
    if ('status' in scope) {
      d.refuse(req, res, scope);
      return null;
    }
    return { v, channel, owner: scope.owner };
  };

  /** Opens a public channel (#1035): a signed-in person or an Admin. `201 { ok, channel }`, the channel as the overview lists it. */
  browser.post('/chat/channels', asyncHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const out = await fleet.chat.publicChannels.open(v, (req.body ?? {}) as Record<string, unknown>);
    if (!out.ok) return void d.refuse(req, res, out);
    res.status(201).json({ ok: true, channel: await fleet.chat.channelEntry(v, out.channel) });
  }));

  /** Changes a public channel's description: the person who opened it, or an Admin. */
  browser.patch('/chat/channels/:channel', asyncHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const channel = await channels().resolve(req.params.channel);
    if (channel === GENERAL || channel === GROUP) return void d.refuse(req, res, fail(403, `${channel === GENERAL ? 'General' : 'My group'} is built in: it has no description to change.`));
    if (!channel) return void res.status(404).json({ ok: false, error: 'no such channel' });
    const out = await fleet.chat.publicChannels.describe(v, channel, (req.body ?? {}) as Record<string, unknown>);
    if (!out.ok) return void d.refuse(req, res, out);
    res.json({ ok: true, channel: await fleet.chat.channelEntry(v, out.channel) });
  }));

  /** Removes a public channel and everything in it: an Admin only. Its opener is told who did it. */
  browser.delete('/chat/channels/:channel', asyncHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const channel = await channels().resolve(req.params.channel);
    if (channel === GENERAL || channel === GROUP) return void d.refuse(req, res, fail(403, `${channel === GENERAL ? 'General' : 'My group'} is built in and cannot be removed.`));
    if (!channel) return void res.status(404).json({ ok: false, error: 'no such channel' });
    const out = await fleet.chat.publicChannels.remove(v, channel);
    if (!out.ok) return void d.refuse(req, res, out);
    res.json(out);
  }));

  browser.get('/chat/channels/:channel/messages', asyncHandler(async (req, res) => {
    const t = await target(req, res, req.query.owner);
    if (!t) return;
    const limit = limitOf(req.query.limit);
    if (limit === null) return void res.status(400).json({ ok: false, error: `limit must be a whole number from 1 to ${PAGE_MAX}` });
    const before = typeof req.query.before === 'string' ? req.query.before : null;
    // The request is checked first (the cursor is, by reading the page), so a refused read records nothing and tells no one.
    const got = await channels().page(t.v, t.channel, t.owner, { before, limit });
    if ('status' in got) return void d.refuse(req, res, got);
    // An Admin's read of another person's group is recorded before it is answered, so none goes unrecorded; if recording fails the read fails. General is public and never is.
    const adminReads = await channels().readRecord(t.v, t.channel, t.owner);
    const owners = await channels().ownersOf(got.page.messages);
    res.json({ ok: true, channel: t.channel, messages: got.page.messages.map((m) => messageView(m, t.v, owners)), older: got.page.older, total: got.total, adminReads });
  }));

  /** An Admin's open group pings this every 15 seconds so its person keeps seeing that it is being read. Answers only `ok`. */
  browser.post('/chat/channels/:channel/reading', asyncHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const channel = await channels().resolve(req.params.channel);
    if (!channel) return void res.status(404).json({ ok: false, error: 'no such channel' });
    if (!v.admin) return void d.refuse(req, res, fail(403, 'Only an Admin reads a group that is not their own.'));
    if (isPublicChannel(channel)) return void res.status(400).json({ ok: false, error: `${channel === GENERAL ? 'General' : 'A public channel'} is public, so reading it is not recorded.` });
    const scope = channels().scopeFor(v, channel, str(((req.body ?? {}) as Record<string, unknown>).owner));
    if ('status' in scope) return void d.refuse(req, res, scope);
    const out = await channels().reading(v, scope.owner);
    if ('status' in out) return void d.refuse(req, res, out);
    res.json({ ok: true });
  }));

  browser.post('/chat/channels/:channel/messages', asyncHandler(async (req, res) => {
    // An owner named in the body is the group the message is meant for: an Admin may name another person's, and is refused in `post`.
    const t = await target(req, res, ((req.body ?? {}) as Record<string, unknown>).owner);
    if (!t) return;
    const out = await channels().post(t.v, t.channel, t.owner, (req.body ?? {}) as Record<string, unknown>);
    if (!out.ok) return void d.refuse(req, res, out);
    res.status(201).json({ ok: true, message: messageView(out.message, t.v, await channels().ownersOf([out.message])), warnings: out.warnings });
  }));

  /** The viewer and the channel a change of one of their own messages is about (#1269), or an answer already sent. The admin secret has no messages, so it is refused before anything is read. */
  const changeTarget = async (req: Request, res: Response): Promise<{ v: ChatViewer; channel: ChannelId; owner: string | null; id: string } | null> => {
    const v = await d.viewer(req, res);
    if (!v) return null;
    if (v.personId === null) {
      d.refuse(req, res, fail(403, 'The admin secret has no messages of its own to change. Sign in with your own name.'));
      return null;
    }
    const channel = await channels().resolve(req.params.channel);
    if (!channel) {
      res.status(404).json({ ok: false, error: 'no such channel' });
      return null;
    }
    // Only the person's own group, as for a post: an owner is never named here.
    const scope = channels().scopeFor(v, channel, undefined);
    if ('status' in scope) {
      d.refuse(req, res, scope);
      return null;
    }
    return { v, channel, owner: scope.owner, id: String(req.params.id) };
  };

  /** The author edits their own message: `{ text }`. `200 { ok, message }`, the message as a read returns it; refused with 404, 403, 409 (`locked`, `deleted`, `approval`), 400, 422 or 429. */
  browser.patch('/chat/channels/:channel/messages/:id', asyncHandler(async (req, res) => {
    const t = await changeTarget(req, res);
    if (!t) return;
    const out = await channels().editMessage(t.v, t.channel, t.owner, t.id, (req.body ?? {}) as Record<string, unknown>);
    if (!out.ok) return void d.refuse(req, res, out);
    res.json({ ok: true, message: messageView(out.message, t.v, await channels().ownersOf([out.message])) });
  }));

  /** The author deletes their own message; a tombstone stays. `DELETE .../messages` without an id is Remove all and stays as it was. */
  browser.delete('/chat/channels/:channel/messages/:id', asyncHandler(async (req, res) => {
    const t = await changeTarget(req, res);
    if (!t) return;
    const out = await channels().deleteMessage(t.v, t.channel, t.owner, t.id);
    if (!out.ok) return void d.refuse(req, res, out);
    res.json({ ok: true, message: messageView(out.message, t.v, await channels().ownersOf([out.message])) });
  }));

  browser.put('/chat/channels/:channel/pause', asyncHandler(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const t = await target(req, res, b.owner);
    if (!t) return;
    if (typeof b.paused !== 'boolean') return void res.status(400).json({ ok: false, error: 'paused must be true or false' });
    const out = await channels().setPaused(t.v, t.channel, t.owner, b.paused, b.everyone === true);
    if ('status' in out) return void d.refuse(req, res, out);
    res.json(out);
  }));

  browser.put('/chat/channels/:channel/disconnect', asyncHandler(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const t = await target(req, res, b.owner);
    if (!t) return;
    if (typeof b.disconnected !== 'boolean') return void res.status(400).json({ ok: false, error: 'disconnected must be true or false' });
    const out = await channels().setDisconnected(t.v, t.channel, t.owner, b.disconnected);
    if ('status' in out) return void d.refuse(req, res, out);
    res.json(out);
  }));

  browser.delete('/chat/channels/:channel/messages', asyncHandler(async (req, res) => {
    const t = await target(req, res, (req.body as { owner?: unknown } | undefined)?.owner);
    if (!t) return;
    const out = await channels().clear(t.v, t.channel, t.owner);
    if ('status' in out) return void d.refuse(req, res, out);
    res.json(out);
  }));

  /** What a typed `@` can mean, narrowed by what is typed so far. For a direct message the list is the viewer's own agents. */
  browser.get('/chat/addresses', asyncHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    // A public channel's list is General's: everyone who can be reached from it. Anything that is not a channel is the viewer's group, as before.
    const named = await channels().resolve(req.query.channel);
    const channel: ChannelId = named !== null && isPublicChannel(named) ? named : GROUP;
    const scope = channels().scopeFor(v, channel, undefined);
    if ('status' in scope) return void d.refuse(req, res, scope);
    const q = typeof req.query.q === 'string' ? req.query.q.toLowerCase() : '';
    const all = await channels().addressBook(channel, scope.owner);
    res.json({ ok: true, addresses: all.filter((a) => a.typed.toLowerCase().startsWith(q)) });
  }));
}
