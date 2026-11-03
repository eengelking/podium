// Answering a session from Podium (#858): the OpenCode reporter's side of it. Runs from the reporter's timer, never from an event
// handler, so the event loop does not wait on the network. The waiting, announcing and reporting back is `core/respond.ts`;
// what is specific to OpenCode (replying to a permission, answering a form, sending a prompt) comes in through `Host`.
import { acceptsFor, type Ask as PodiumAsk, type Delivery, type DeliveryResult, type RespondInfo, type RespondKind, type RespondLimit } from '../core/protocol.ts';
import type { Responder } from '../core/respond.ts';
import type { Transport } from '../core/transport.ts';
import { formAnswer, framedMessage, permissionReply, podiumAsk } from './answer.ts';
import type { Ask, Root } from './state.ts';

/** The calls into OpenCode. Each rejects when OpenCode did not take it. */
export interface Host {
  permissionReply(sessionId: string, requestId: string, reply: 'once' | 'reject'): Promise<void>;
  /** How a question can be answered now: through a TUI part that is attached, through the local HTTP route, or not at all. */
  formChannel(): 'tui' | 'http' | null;
  formReply(sessionId: string, formId: string, answer: Record<string, string | string[]>): Promise<void>;
  /** Sends a message as a prompt, queued behind the turn that runs; `id` is Podium's delivery id, so one sent twice is one message. */
  prompt(sessionId: string, id: string, text: string): Promise<void>;
  compact(sessionId: string, id: string): Promise<void>;
}

export interface Consent {
  respond: boolean;
  activityFeed: boolean;
}

/** The kinds of answer OpenCode has no equivalent for. `/clear` is not here: it is a command, and `deliver` refuses every command but `/compact`. */
const UNSUPPORTED: readonly RespondKind[] = ['plan-approve', 'plan-feedback'];

/** Which kinds of delivery take an ask of each kind. */
const TAKES: Record<Ask['kind'], readonly Delivery['kind'][]> = { permission: ['allow-once', 'deny'], question: ['question'] };

export class Answering {
  /** Ask ids with a wait running. */
  private readonly listening = new Set<string>();

  constructor(
    private readonly responder: Responder,
    private readonly host: Host,
    private readonly consent: Consent,
  ) {}

  /** What the session takes now. Null while the person has not allowed answering: the report then says nothing about it. */
  info(): RespondInfo | null {
    if (!this.consent.respond) return null;
    const limits: RespondLimit[] = [];
    const accepts = acceptsFor('everything', limits, this.consent.activityFeed).filter((k) => !UNSUPPORTED.includes(k) && (k !== 'question' || this.host.formChannel() !== null));
    return { level: 'everything', accepts, limits };
  }

  /** The asks Podium may be told of: only while the server takes answers, and only those it can answer. */
  asks(root: Root, transport: Transport): PodiumAsk[] {
    if (!transport.respond || !this.info()?.accepts.length) return [];
    return [...root.asks.values()].filter((a) => this.can(a)).flatMap((a) => podiumAsk(a, root) ?? []).slice(0, 8);
  }

  private can(a: Ask): boolean {
    const accepts = this.info()?.accepts ?? [];
    return accepts.includes(a.kind === 'permission' ? 'permission' : 'question');
  }

  /** One pass after a report: starts a wait for each new ask and acts on the messages and commands the reply handed over. */
  async drive(root: Root, transport: Transport): Promise<void> {
    if (!transport.respond || !this.info()?.accepts.length) return;
    for (const ask of root.asks.values()) {
      // A root that ended keeps no ask to announce.
      if (!root.done && !this.listening.has(ask.id) && this.can(ask)) {
        const shown = podiumAsk(ask, root);
        if (shown) void this.listen(root, transport, ask, shown);
      }
    }
    for (const d of transport.deliveries) {
      if (d.askId !== null || !this.responder.markActed(d.id)) continue;
      await this.deliver(root, d);
    }
    await this.responder.flush();
  }

  /** Announces an ask and waits for its answer until the ask closes in the terminal or the server stops taking answers. */
  private async listen(root: Root, transport: Transport, ask: Ask, shown: PodiumAsk): Promise<void> {
    this.listening.add(ask.id);
    try {
      await this.responder.announce(root.id, shown);
      const open = (): boolean => root.asks.has(ask.id) && transport.respond && !root.done;
      const d = await this.responder.wait(root.id, shown, open, (x) => TAKES[ask.kind].includes(x.kind));
      if (d) await this.answer(root, ask, d);
      // Closed without an answer from Podium: the person answered in the terminal, or the session ended.
      else if (!root.asks.has(ask.id)) this.responder.queueClose(root.id, ask.id, root.done ? 'ended' : 'terminal');
    } finally {
      this.listening.delete(ask.id);
    }
  }

  private result(root: Root, d: Delivery, r: DeliveryResult): void {
    this.responder.queueResult(root.id, d.id, r);
  }

  private async answer(root: Root, ask: Ask, d: Delivery): Promise<void> {
    try {
      if (ask.kind === 'permission') {
        const reply = permissionReply(d.kind);
        if (!reply) return this.result(root, d, 'refused');
        await this.host.permissionReply(ask.sessionId, ask.id, reply);
        return this.result(root, d, 'took');
      }
      const answer = formAnswer(ask.fields ?? [], d.answers ?? []);
      if (!answer) return this.result(root, d, 'refused');
      if (this.host.formChannel() === null) return this.result(root, d, 'not-taken');
      await this.host.formReply(ask.sessionId, ask.id, answer);
      return this.result(root, d, 'took');
    } catch {
      return this.result(root, d, 'not-taken');
    }
  }

  /** A message or `/compact`. Anything else is refused. */
  private async deliver(root: Root, d: Delivery): Promise<void> {
    const accepts = this.info()?.accepts ?? [];
    try {
      if (d.kind === 'message' && accepts.includes('message') && d.text) {
        const busy = [...root.sessions.values()].some((s) => s.executing);
        await this.host.prompt(root.id, d.id, framedMessage(d));
        return this.result(root, d, busy ? 'queued' : 'took');
      }
      if (d.kind === 'command' && d.command === 'compact' && accepts.includes('command')) {
        await this.host.compact(root.id, d.id);
        return this.result(root, d, 'took');
      }
      return this.result(root, d, 'refused');
    } catch {
      return this.result(root, d, 'not-taken');
    }
  }
}
