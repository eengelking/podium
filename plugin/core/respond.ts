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

export const sessionPath = (sessionId: string): string => `/api/fleet/sessions/${encodeURIComponent(sessionId)}`;

export class Responder {
  readonly outbox: OutItem[] = [];
  private readonly acted: string[] = [];

  constructor(
    private readonly fetch: FetchLike,
    private readonly cfg: ResponderConfig,
    private readonly clock: ResponderClock,
  ) {}

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
    return (await this.call('PUT', `${sessionPath(sessionId)}/asks/${encodeURIComponent(ask.id)}`, ask))?.status ?? 0;
  }

  /** Notes a delivery as acted on, so one handed over twice (a lost reply, a reload) acts once. False when it already was. */
  markActed(id: string): boolean {
    if (this.acted.includes(id)) return false;
    this.acted.push(id);
    if (this.acted.length > ACTED_KEPT) this.acted.splice(0, this.acted.length - ACTED_KEPT);
    return true;
  }

  private queue(item: OutItem): void {
    this.outbox.push(item);
    if (this.outbox.length > OUTBOX_MAX) this.outbox.splice(0, this.outbox.length - OUTBOX_MAX);
  }

  queueResult(sessionId: string, deliveryId: string, result: DeliveryResult): void {
    this.queue({ path: `${sessionPath(sessionId)}/deliveries/${encodeURIComponent(deliveryId)}/result`, body: { result, at: this.clock.now() } });
  }

  queueClose(sessionId: string, askId: string, outcome: AskClose['outcome'], extra: Pick<AskClose, 'answer' | 'planApproved'> = {}): void {
    this.queue({ path: `${sessionPath(sessionId)}/asks/${encodeURIComponent(askId)}/close`, body: { outcome, at: this.clock.now(), ...extra } });
  }

  private flushing: Promise<void> | null = null;

  /**
   * Sends what was queued. A call that cannot be made keeps the rest for the next pass; one the server answers is dropped, whatever
   * it said. Callers that arrive while a pass runs wait for that pass: a reporter with several roots flushes from each, and two
   * passes at once would send the first item twice.
   */
  flush(): Promise<void> {
    this.flushing ??= this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.outbox.length) {
      const res = await this.call('POST', this.outbox[0]!.path, this.outbox[0]!.body);
      if (!res) return;
      this.outbox.shift();
    }
  }

  /**
   * Waits for the next answer to an ask, until one comes, `active` says the ask is no longer open, or the server stops taking
   * answers. A delivery that `wanted` does not take is refused. Resolves null when nothing was taken.
   */
  async wait(sessionId: string, ask: Ask, active: () => boolean, wanted: (d: Delivery) => boolean): Promise<Delivery | null> {
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
      if (!this.markActed(d.id)) {
        // Already acted on and waiting for its result to reach the server: ask again shortly.
        if (!(await this.clock.sleep(1000))) return null;
        continue;
      }
      if (d.askId === ask.id && wanted(d)) return d;
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
