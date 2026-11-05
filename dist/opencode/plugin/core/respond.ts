// Answering from Podium, the part that does not depend on a harness (#858): announcing an ask, waiting for its answer, telling the
// server how a delivery ended and how an ask closed, and remembering which deliveries were acted on. Everything it needs from the
// outside (the HTTP call, the clock, a sleep) is passed in, so a reporter with no hooks can drive it from a timer and a test can
// drive it with fakes. What an answer does to the harness (reply to a permission, answer a form, send a prompt) is the reporter's.
import { Transport, isDelivery, type FetchLike } from './transport.ts';
import type { Ask, AskClose, Delivery, DeliveryResult } from './protocol.ts';
import { RESPOND_LIMITS } from './protocol.ts';
import { trimTrailingSlashes } from './machine.ts';

/** Calls waiting to go to the server: a delivery's result and an ask's close. Capped, so a long outage cannot grow it without end. */
export const OUTBOX_MAX = 50;
/** How many acted-on delivery ids are remembered. */
export const ACTED_KEPT = 100;

export interface ResponderConfig {
  serverUrl: string;
  token: string;
}

export interface ResponderClock {
  now: () => number;
  /** Resolves false when the wait was cut short and the caller must stop waiting. */
  sleep: (ms: number) => Promise<boolean>;
}

interface OutItem {
  path: string;
  body: unknown;
}

/**
 * What outlives one Responder: the calls waiting to go and the acted-on ids. A reporter whose fetch belongs to the hook that runs
 * (Claude Code's is aborted by Esc) makes a Responder per call over one state; one with a single fetch makes one Responder.
 */
export interface ResponderState {
  outbox: OutItem[];
  acted: string[];
  flushing: Promise<void> | null;
}

export const newResponderState = (): ResponderState => ({ outbox: [], acted: [], flushing: null });

export interface ResponderHooks {
  /** Called with the remembered ids after a new one is added, so a reporter can keep them across a reload. */
  onActed?: (acted: string[]) => void;
  /** Called with the ask and the status after every announce, including the one a wait makes when the server forgot the ask. */
  onAnnounce?: (ask: Ask, status: number) => void;
  /** Called after each queued call the server took, before the next one goes (a reporter's own calls waiting behind the outbox). */
  afterSend?: () => Promise<void>;
}

export const sessionPath = (sessionId: string): string => `/api/fleet/sessions/${encodeURIComponent(sessionId)}`;

export class Responder {
  constructor(
    private readonly fetch: FetchLike,
    private readonly cfg: ResponderConfig,
    private readonly clock: ResponderClock,
    private readonly state: ResponderState = newResponderState(),
    private readonly hooks: ResponderHooks = {},
  ) {}

  get outbox(): OutItem[] {
    return this.state.outbox;
  }

  /** Replaces the remembered ids with ones kept from an earlier run (the newest ACTED_KEPT). */
  seedActed(ids: string[]): void {
    this.state.acted.splice(0, this.state.acted.length, ...ids.slice(-ACTED_KEPT));
  }

  /** One request to the server with the reporter's token; null when it could not be made. */
  async call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string } | null> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cfg.token) headers['X-Podium-Token'] = this.cfg.token;
    try {
      const init = body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) };
      const res = await this.fetch(trimTrailingSlashes(this.cfg.serverUrl) + path, init);
      return { status: res.status, text: res.text };
    } catch {
      return null;
    }
  }

  /** Announces an ask (PUT). The status the server answered with, or 0 when it could not be reached. */
  async announce(sessionId: string, ask: Ask): Promise<number> {
    const status = (await this.call('PUT', `${sessionPath(sessionId)}/asks/${encodeURIComponent(ask.id)}`, ask))?.status ?? 0;
    this.hooks.onAnnounce?.(ask, status);
    return status;
  }

  /** Notes a delivery as acted on, so one handed over twice (a lost reply, a reload) acts once. False when it already was. */
  markActed(id: string): boolean {
    const acted = this.state.acted;
    if (acted.includes(id)) return false;
    acted.push(id);
    if (acted.length > ACTED_KEPT) acted.splice(0, acted.length - ACTED_KEPT);
    this.hooks.onActed?.([...acted]);
    return true;
  }

  /** Queues a call of the reporter's own to send with the rest (a path under the server, and its JSON body). */
  queue(item: OutItem): void {
    this.outbox.push(item);
    if (this.outbox.length > OUTBOX_MAX) this.outbox.splice(0, this.outbox.length - OUTBOX_MAX);
  }

  queueResult(sessionId: string, deliveryId: string, result: DeliveryResult): void {
    this.queue({ path: `${sessionPath(sessionId)}/deliveries/${encodeURIComponent(deliveryId)}/result`, body: { result, at: this.clock.now() } });
  }

  queueClose(sessionId: string, askId: string, outcome: AskClose['outcome'], extra: Pick<AskClose, 'answer' | 'planApproved'> = {}): void {
    this.queue({ path: `${sessionPath(sessionId)}/asks/${encodeURIComponent(askId)}/close`, body: { outcome, at: this.clock.now(), ...extra } });
  }

  /**
   * Sends what was queued. A call that cannot be made keeps the rest for the next pass; one the server answers is dropped, whatever
   * it said. Callers that arrive while a pass runs wait for that pass, and so the first caller's `afterSend` is the one that runs: a reporter with several roots flushes from each, and two
   * passes at once would send the first item twice.
   */
  flush(): Promise<void> {
    this.state.flushing ??= this.drain().finally(() => {
      this.state.flushing = null;
    });
    return this.state.flushing;
  }

  private async drain(): Promise<void> {
    while (this.outbox.length) {
      const res = await this.call('POST', this.outbox[0]!.path, this.outbox[0]!.body);
      if (!res) return;
      this.outbox.shift();
      await this.hooks.afterSend?.();
    }
  }

  /**
   * Waits for the next answer to an ask, until one comes, `active` says the ask is no longer open, or the server stops taking
   * answers. A delivery that `wanted` does not take is refused, unless `other` takes it (a plan's approval: the wait goes on) or
   * `skip` names it (another wait on the ask acts on it: it is left alone and asked for again shortly). Resolves null when nothing
   * was taken.
   */
  async wait(sessionId: string, ask: Ask, active: () => boolean, wanted: (d: Delivery) => boolean, extra: { other?: (d: Delivery) => void; skip?: (d: Delivery) => boolean } = {}): Promise<Delivery | null> {
    while (active()) {
      const res = await this.call('GET', `${sessionPath(sessionId)}/asks/${encodeURIComponent(ask.id)}/answer?wait=${RESPOND_LIMITS.holdSeconds}`);
      if (!active()) {
        // The ask closed while the request was held: an answer that arrived anyway was not taken.
        const late = deliveryOf(res);
        if (late && this.markActed(late.id)) this.queueResult(sessionId, late.id, 'closed');
        return null;
      }
      if (!res) {
        if (!(await this.clock.sleep(Transport.backoff(1)))) return null;
        continue;
      }
      if (res.status === 204) continue;
      if (res.status === 404) {
        // The server forgot the ask (a restart): say it again before asking for its answer.
        if ((await this.announce(sessionId, ask)) !== 200 && !(await this.clock.sleep(Transport.backoff(2)))) return null;
        continue;
      }
      const d = deliveryOf(res);
      if (!d) return null;
      if (d.askId === ask.id && extra.skip?.(d)) {
        if (!(await this.clock.sleep(500))) return null;
        continue;
      }
      if (!this.markActed(d.id)) {
        // Already acted on and waiting for its result to reach the server: ask again shortly.
        if (!(await this.clock.sleep(1000))) return null;
        continue;
      }
      if (d.askId === ask.id && wanted(d)) return d;
      if (d.askId === ask.id && extra.other) {
        extra.other(d);
        continue;
      }
      this.queueResult(sessionId, d.id, 'refused');
    }
    return null;
  }
}

/** The delivery in a held request's reply; null for anything else (no answer, an error, a reply that is not a delivery). */
export function deliveryOf(res: { status: number; text: string } | null): Delivery | null {
  if (!res || res.status !== 200) return null;
  try {
    const d = (JSON.parse(res.text) as { delivery?: unknown }).delivery;
    return isDelivery(d) ? d : null;
  } catch {
    return null;
  }
}
