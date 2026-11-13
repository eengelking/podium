// The TUI part of the plugin (#858). It exists for one thing: OpenCode's server-side plugin API cannot answer a question form, and
// this part, which lives in the terminal UI, can. It tells the server part it is attached, and when the server part hands it an
// answer from Podium it replies to the form with `session.form.reply`. It reads nothing from Podium and sends nothing to it.
import { randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import type { Plugin } from '@opencode/plugin/tui';
import { settingsPath } from '../core/settings.ts';
import { ATTACH_EVERY_MS, BRIDGE, BRIDGE_ID, type AnswerEvent, type NoticeEvent, type StatusEvent } from './bridge.ts';
import { fileIO, showConfig, type ConfigEvent, type ConfigUi } from './configWindow.ts';
import { AdminBoard, ToastKeeper } from './notice.ts';
import { mountBanner, mountStatus, type StatusLine, type StatusParts } from './statusSlot.ts';

const plugin: Plugin.Definition = {
  id: `${BRIDGE_ID}-tui`,
  async setup(ctx) {
    const rpc = ctx.client.rpc(BRIDGE) as unknown as {
      attach: (input: { id: string }, options?: { location?: unknown }) => Promise<unknown>;
      detach: (input: { id: string }, options?: { location?: unknown }) => Promise<unknown>;
      shown: (input: { id: string }, options?: { location?: unknown }) => Promise<unknown>;
      events: { on: <N extends 'answer' | 'notice' | 'status' | 'config'>(name: N, handler: (e: { data: N extends 'answer' ? AnswerEvent : N extends 'status' ? StatusEvent : N extends 'config' ? ConfigEvent : NoticeEvent }) => Promise<void> | void) => () => void };
    };
    // Said now and again well within the server part's time limit; a failed call (the server part is not there) is tried again next time.
    // The server part registers the bridge in its project's location, so the call names the location this TUI is in.
    const id = randomUUID();
    const attach = (): void => void Promise.resolve(rpc.attach({ id }, { location: ctx.data.location.default() })).catch(() => undefined);
    attach();
    const timer = setInterval(attach, ATTACH_EVERY_MS);
    const off = rpc.events.on('answer', async (e) => {
      const { sessionID, formID, answer } = e.data;
      // Another TUI may have answered first: a reply that fails then is not an error here.
      await ctx.data.session.form.reply({ sessionID, formID, answer }, ctx.data.location.default()).catch(() => undefined);
    });
    // The connection's status and the answer to `/podium` are shown as a toast (#969).
    // The host shows one toast at a time, so the keeper shows an Admin callout again after another toast has replaced it (#1051).
    const keeper = new ToastKeeper(
      (n) => ctx.ui.toast.show({ ...(n.title ? { title: n.title } : {}), message: n.message, ...(n.variant ? { variant: n.variant } : {}), ...(n.duration ? { duration: n.duration } : {}) }),
      () => Date.now(),
      (ms, fn) => void setTimeout(fn, ms).unref?.(),
    );
    // The Admin callouts also stay on a board above the prompt for as long as the reading does; it is drawn here and never enters a session (#1051).
    const board = new AdminBoard();
    let banner: StatusLine | null = null;
    const refresh = (): void => banner?.set(board.lines(Date.now()).join('\n'));
    const shownIds = new Set<string>();
    const offNotice = rpc.events.on('notice', (e) => {
      const n = e.data;
      if (!n.admin || !n.id) return keeper.offer(n);
      // Shown once however often the server part offers it again; the word that it was shown goes back each time, as the first may not have arrived.
      if (!shownIds.has(n.id)) {
        shownIds.add(n.id);
        keeper.offer(n);
        board.add(n.id, n.message, Date.now());
        refresh();
      }
      void Promise.resolve(rpc.shown({ id: n.id }, { location: ctx.data.location.default() })).catch(() => undefined);
    });
    // `/podium config` (#1001): the settings window, in this terminal only when the command came from the session it shows. The person's
    // own press in a dialog is the only thing that writes a setting, and only to the file the reporter reads (configWindow.ts).
    const ui = ctx.ui as unknown as ConfigUi;
    const offConfig = rpc.events.on('config', (e) => {
      const here = { host: hostname(), path: settingsPath(homedir()), columns: process.stdout?.columns ?? null };
      // Not awaited: the window stays open as long as the person likes, and the event stream must not wait on it.
      void showConfig(ui, e.data, here, fileIO);
    });
    // The status line stays in the prompt's footer (#987). The pieces come from the host's own runtime; where it has none the toast is all there is.
    // The specifiers are literal: the host resolves a literal one to its own copy, and cannot resolve a name held in a variable (a live run failed on that).
    const load = async (): Promise<StatusParts> => ({ solid: (await import('solid-js')) as StatusParts['solid'], jsx: (await import('@opentui/solid/jsx-runtime')) as StatusParts['jsx'] });
    const line = await mountStatus(ctx.ui as unknown as Parameters<typeof mountStatus>[0], load);
    const offStatus = rpc.events.on('status', (e) => line?.set(e.data.text));
    banner = await mountBanner(ctx.ui as unknown as Parameters<typeof mountBanner>[0], load);
    refresh();
    const boardTimer = setInterval(refresh, 30_000);
    // The first attach above ran before this listener existed, so the status it triggered was lost; say it again now that the listener is there (#999).
    attach();
    return () => {
      // Closing the terminal says so, so the server part need not wait out the attach time limit and the idle wait to end this session's card (#1029). Best effort: a TUI killed outright cannot.
      void Promise.resolve(rpc.detach({ id }, { location: ctx.data.location.default() })).catch(() => undefined);
      clearInterval(timer);
      off();
      offNotice();
      offConfig();
      offStatus();
      line?.dispose();
      clearInterval(boardTimer);
      banner?.dispose();
    };
  },
};

export default plugin;
