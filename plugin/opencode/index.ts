// The OpenCode plugin entry (#855): glue between OpenCode's plugin API and the Reporter. Everything with logic lives in
// the modules beside it, which need no OpenCode API and are tested on their own.
import { execFile } from 'node:child_process';
import type { Plugin } from '@opencode/plugin';
import type { Runner } from '../core/git.ts';
import { optionsOf } from './options.ts';
import { DEFAULTS, Reporter } from './reporter.ts';
import { EVENT_TYPES, type BusEvent } from './state.ts';

const KEY = Symbol.for('podium-reporter.opencode');

/** One reporter per location, kept on `globalThis`: module state is not shared between plugin loads, `globalThis` is. */
interface Holder {
  reporter: Reporter;
  timer: ReturnType<typeof setInterval>;
  /** How many loads of the plugin use it; the last one out closes it. */
  users: number;
}
type Registry = Map<string, Holder>;

const registry = (): Registry => {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (g[KEY] ??= new Map());
};

const runIn = (cwd: string): Runner => (argv) =>
  new Promise((resolve) => {
    execFile(argv[0]!, argv.slice(1), { cwd, timeout: 5000, maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout ?? '') });
    });
  });

/** After a reload the registry still knows its sessions, but a permission opened meanwhile was never announced to this load. */
async function recoverPermissions(ctx: Plugin.Context, reporter: Reporter): Promise<void> {
  for (const sessionID of reporter.sessionIds()) {
    // One session that cannot be listed (gone since) must not hide the open permissions of the others.
    await ctx.permission.list({ sessionID }).then((open) => reporter.recover(open), () => undefined);
  }
}

const plugin: Plugin.Plugin = {
  id: 'podium-reporter',
  async setup(ctx) {
    const location = String((ctx.location as { directory?: string } | undefined)?.directory ?? 'default');
    const reg = registry();
    let holder = reg.get(location);
    if (!holder) {
      const reporter = new Reporter(
        { fetch: async (url, init) => { const r = await fetch(url, init); return { status: r.status, ok: r.ok, text: await r.text() }; }, now: () => Date.now(), runIn, log: () => undefined },
        optionsOf(ctx.options, null),
      );
      // The timer is the only caller that talks to the server; the event loop below never awaits it.
      const timer = setInterval(() => void reporter.tick().catch(() => undefined), DEFAULTS.flushMs);
      timer.unref?.();
      holder = { reporter, timer, users: 0 };
      reg.set(location, holder);
    }
    holder.users++;
    const { reporter } = holder;
    // A reload leaves permissions open that the bus will not announce again.
    void recoverPermissions(ctx, reporter).catch(() => undefined);
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ types: [...EVENT_TYPES] })) reporter.handle(ev as unknown as BusEvent);
      } catch {
        // The host closes the stream at shutdown.
      }
    })();
    return async () => {
      const h = reg.get(location);
      if (!h || --h.users > 0) return;
      reg.delete(location);
      clearInterval(h.timer);
      await h.reporter.close();
    };
  },
};

export default plugin;
