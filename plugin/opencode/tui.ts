// The TUI part of the plugin (#858). It exists for one thing: OpenCode's server-side plugin API cannot answer a question form, and
// this part, which lives in the terminal UI, can. It tells the server part it is attached, and when the server part hands it an
// answer from Podium it replies to the form with `session.form.reply`. It reads nothing from Podium and sends nothing to it.
import type { Plugin } from '@opencode/plugin/tui';
import { ATTACH_EVERY_MS, BRIDGE, BRIDGE_ID, type AnswerEvent, type NoticeEvent } from './bridge.ts';

const plugin: Plugin.Definition = {
  id: `${BRIDGE_ID}-tui`,
  async setup(ctx) {
    const rpc = ctx.client.rpc(BRIDGE) as unknown as {
      attach: (input: Record<string, never>, options?: { location?: unknown }) => Promise<unknown>;
      events: { on: <N extends 'answer' | 'notice'>(name: N, handler: (e: { data: N extends 'answer' ? AnswerEvent : NoticeEvent }) => Promise<void> | void) => () => void };
    };
    // Said now and again well within the server part's time limit; a failed call (the server part is not there) is tried again next time.
    // The server part registers the bridge in its project's location, so the call names the location this TUI is in.
    const attach = (): void => void Promise.resolve(rpc.attach({}, { location: ctx.data.location.default() })).catch(() => undefined);
    attach();
    const timer = setInterval(attach, ATTACH_EVERY_MS);
    const off = rpc.events.on('answer', async (e) => {
      const { sessionID, formID, answer } = e.data;
      // Another TUI may have answered first: a reply that fails then is not an error here.
      await ctx.data.session.form.reply({ sessionID, formID, answer }, ctx.data.location.default()).catch(() => undefined);
    });
    // The connection's status and the answer to `/podium` are shown as a toast (#969).
    const offNotice = rpc.events.on('notice', (e) => ctx.ui.toast.show(e.data));
    return () => {
      clearInterval(timer);
      off();
      offNotice();
    };
  },
};

export default plugin;
