// The OpenCode plugin entry (#855): glue between OpenCode's plugin API and the Reporter. Everything with logic lives in
// the modules beside it, which need no OpenCode API and are tested on their own.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Plugin } from '@opencode/plugin';
import type { Runner } from '../core/git.ts';
import { BRIDGE, type AnswerEvent } from './bridge.ts';
import { makeHost, servicePath, type Api } from './host.ts';
import { readMachine, readSettingsFile } from './machine.ts';
import { optionsOf } from './options.ts';
import { DEFAULTS, Reporter } from './reporter.ts';
import type { FetchLike } from '../core/transport.ts';
import { EVENT_TYPES, type BusEvent } from './state.ts';
import { homeOf, openLink, withLink, type TlsLink } from './tls.ts';

const KEY = Symbol.for('podium-reporter.opencode');

/** One reporter per location, kept on `globalThis`: module state is not shared between plugin loads, `globalThis` is. */
interface Holder {
  reporter: Reporter;
  timer: ReturnType<typeof setInterval>;
  /** How many loads of the plugin use it; the last one out closes it. */
  users: number;
  /** The secure connection (#948), when a reporter config file was found. Started with the reporter and stopped with it. */
  link: TlsLink | null;
}
/** A promise per location: finding the reporter config file takes a moment, and two loads must wait for one reporter. */
type Registry = Map<string, Promise<Holder>>;

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

/** Adds this machine to the options. Read once per location and cheap, so several locations in one process may each run it. */
const withMachine = <T extends { userName: string | null; machine: unknown }>(o: T): T => ({ ...o, machine: readMachine(o.userName) });

/** The calls answering makes into OpenCode, from the plugin context. */
const apiOf = (ctx: Plugin.Context): Api => ({
  permissionReply: (i) => ctx.permission.reply({ sessionID: i.sessionID, requestID: i.requestID, decision: i.reply }),
  prompt: (i) => ctx.session.prompt({ sessionID: i.sessionID, id: i.id, text: i.text, delivery: 'queue' }),
  compact: (i) => ctx.session.compact({ sessionID: i.sessionID, id: i.id, delivery: 'queue' }),
});

/** The plain fetch the reporter uses when there is no reporter config file: the token goes in a header to the configured server. */
const plainFetch: FetchLike = async (url, init) => {
  const r = await fetch(url, init);
  return { status: r.status, ok: r.ok, text: await r.text() };
};

/** One reporter for a location: its options, the secure connection when a reporter config file is found, and the flush timer. */
async function createHolder(ctx: Plugin.Context): Promise<Holder> {
  const settings = readSettingsFile();
  // The token is in that file: say once per location when anyone but the owner can read it. The message holds no secret.
  if (settings.open) console.warn('podium-reporter: ~/.podium/config.env can be read by other users; run chmod 600 on it.');
  const trusted = optionsOf(ctx.options, null, process.env, settings.text);
  // A reporter config file (#948) is found from the environment and ~/.podium only, never from the project's options.
  const link = await openLink({ options: trusted, env: process.env, home: homeOf(process.env), now: () => Date.now() });
  const options = withMachine(withLink(trusted, link));
  const bridge = { seenAt: 0, emit: undefined as undefined | ((e: AnswerEvent) => Promise<void>), reporter: undefined as Reporter | undefined };
  // Answering exists only where the person allowed it, in the environment or ~/.podium/config.env, never in a project's options.
  const answering = options.consent.respond
    ? {
        consent: { respond: options.consent.respond, activityFeed: options.consent.activityFeed },
        host: makeHost({
          api: apiOf(ctx),
          emitAnswer: async (e) => bridge.emit?.(e),
          // A TUI part counts as attached only once the RPC it answers through is registered, or its answer would go nowhere.
          tuiSeenAt: () => (bridge.emit ? bridge.seenAt : 0),
          isOpen: (id) => !!bridge.reporter && [...bridge.reporter.store.roots.values()].some((r) => r.asks.has(id)),
          readService: () => { try { return readFileSync(servicePath(process.env, homedir()), 'utf8'); } catch { return null; } },
          hasService: () => existsSync(servicePath(process.env, homedir())),
          // OpenCode's own local route (service.json), never the Podium server: a plain local fetch.
          fetch: async (url, init) => { const r = await fetch(url, init); return { ok: r.ok, status: r.status }; },
          now: () => Date.now(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        }),
      }
    : undefined;
  // Everything sent to Podium, the answering calls included, goes through the link when there is one, and never falls back to http.
  const reporter = new Reporter({ fetch: link ? link.fetch : plainFetch, now: () => Date.now(), runIn, log: () => undefined, problem: link?.problem, answering }, options);
  bridge.reporter = reporter;
  if (answering) {
    // The TUI part says it is attached here, and is handed a question's answer as an event.
    void ctx.rpc.register(BRIDGE, { attach: async () => { bridge.seenAt = Date.now(); return { ok: true }; } }).then(
      (reg) => { bridge.emit = async (e) => (reg as unknown as { events: { emit: (name: 'answer', data: AnswerEvent) => Promise<void> } }).events.emit('answer', e); },
      () => undefined,
    );
  }
  // The renewal check of the certificate (shared lock with Claude sessions), once per location.
  link?.start();
  // The timer is the only caller that talks to the server; the event loop below never awaits it.
  const timer = setInterval(() => void reporter.tick().catch(() => undefined), DEFAULTS.flushMs);
  timer.unref?.();
  return { reporter, timer, users: 0, link };
}

const plugin: Plugin.Plugin = {
  id: 'podium-reporter',
  async setup(ctx) {
    const location = String((ctx.location as { directory?: string } | undefined)?.directory ?? 'default');
    const reg = registry();
    let pending = reg.get(location);
    if (!pending) {
      pending = createHolder(ctx);
      reg.set(location, pending);
      // A holder that could not be made must not stay in the registry, or every load after it would fail the same way.
      pending.catch(() => reg.delete(location));
    }
    const holder = await pending;
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
      const h = await reg.get(location)?.catch(() => undefined);
      if (!h || --h.users > 0) return;
      reg.delete(location);
      clearInterval(h.timer);
      await h.reporter.close();
      h.link?.stop();
    };
  },
};

export default plugin;
