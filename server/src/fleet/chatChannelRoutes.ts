// The browser's routes for Chat's channels (#1034), under /respond/chat/channels. Mounted on responding's browser router, so they share its sign-in
// cookie, its cross-site check and its no-store header. These routes read and write General and My group only: they never touch a direct message.
import { type Request, type Response, type Router } from 'express';
import { asyncHandler } from './asyncHandler.js';
import type { Fleet } from './fleet.js';
import { messageView } from './chatChannels.js';
import { channelOf, fail, type ChannelId, type ChatViewer, type Fail } from './chatTypes.js';

/** What Chat's browser routes share: the gate (messaging on, and a signed-in viewer) and how a refusal is answered. */
export interface ChatBrowserDeps {
  fleet: Fleet;
  viewer: (req: Request, res: Response) => Promise<ChatViewer | null>;
  refuse: (req: Request, res: Response, f: Fail) => void;
}

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 100;

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
    const channel = channelOf(String(req.params.channel));
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

  browser.get('/chat/channels/:channel/messages', asyncHandler(async (req, res) => {
    const t = await target(req, res, req.query.owner);
    if (!t) return;
    const limit = limitOf(req.query.limit);
    if (limit === null) return void res.status(400).json({ ok: false, error: `limit must be a whole number from 1 to ${PAGE_MAX}` });
    const before = typeof req.query.before === 'string' ? req.query.before : null;
    // An Admin's read of another person's group is recorded before it is answered, so none goes unrecorded. General is public and never is.
    const adminReads = await channels().readRecord(t.v, t.channel, t.owner);
    const got = await channels().page(t.v, t.channel, t.owner, { before, limit });
    if ('status' in got) return void d.refuse(req, res, got);
    res.json({ ok: true, channel: t.channel, messages: got.page.messages.map((m) => messageView(m, t.v.name)), older: got.page.older, total: got.total, ...(t.channel === 'group' ? { adminReads } : {}) });
  }));

  /** An Admin's open group pings this every 15 seconds so its person keeps seeing that it is being read. Answers only `ok`. */
  browser.post('/chat/channels/:channel/reading', asyncHandler(async (req, res) => {
    const v = await d.viewer(req, res);
    if (!v) return;
    const channel = channelOf(String(req.params.channel));
    if (!channel) return void res.status(404).json({ ok: false, error: 'no such channel' });
    if (!v.admin) return void d.refuse(req, res, fail(403, 'Only an Admin reads a group that is not their own.'));
    if (channel === 'general') return void res.status(400).json({ ok: false, error: 'General is public, so reading it is not recorded.' });
    const scope = channels().scopeFor(v, channel, str(((req.body ?? {}) as Record<string, unknown>).owner));
    if ('status' in scope) return void d.refuse(req, res, scope);
    const out = await channels().reading(v, scope.owner);
    if ('status' in out) return void d.refuse(req, res, out);
    res.json({ ok: true });
  }));

  browser.post('/chat/channels/:channel/messages', asyncHandler(async (req, res) => {
    const t = await target(req, res, undefined);
    if (!t) return;
    const out = await channels().post(t.v, t.channel, t.owner, (req.body ?? {}) as Record<string, unknown>);
    if (!out.ok) return void d.refuse(req, res, out);
    res.status(201).json({ ok: true, message: messageView(out.message, t.v.name), warnings: out.warnings });
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
    const channel: ChannelId = req.query.channel === 'general' ? 'general' : 'group';
    const scope = channels().scopeFor(v, channel, undefined);
    if ('status' in scope) return void d.refuse(req, res, scope);
    const q = typeof req.query.q === 'string' ? req.query.q.toLowerCase() : '';
    const all = await channels().addressBook(channel, scope.owner);
    res.json({ ok: true, addresses: all.filter((a) => a.typed.toLowerCase().startsWith(q)) });
  }));
}
