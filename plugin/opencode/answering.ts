// Answering a session from Podium (#858): the OpenCode reporter's side of it. Runs from the reporter's timer, never from an event
// handler, so the event loop does not wait on the network. The waiting, announcing and reporting back is `core/respond.ts`;
// what is specific to OpenCode (replying to a permission, answering a form, sending a prompt) comes in through `Host`.
import { acceptsFor, MAIN_LOOP, type Ask as PodiumAsk, type Delivery, type DeliveryResult, type RespondInfo, type RespondKind, type RespondLevel, type RespondLimit } from '../core/protocol.ts';
import type { Responder } from '../core/respond.ts';
import type { Transport } from '../core/transport.ts';
import { decisionRecord, formAnswer, framedMessage, permissionReply, podiumAsk, rejectMessage } from './answer.ts';
import { loopKey, type Ask, type Root } from './state.ts';

/** The calls into OpenCode. Each rejects when OpenCode did not take it. */
export interface Host {
  /** `message` goes with a rejection only: the reason OpenCode gives the model. */
  permissionReply(sessionId: string, requestId: string, reply: 'once' | 'reject', message?: string): Promise<void>;
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
  /** How far answering goes, from the person's settings (`PODIUM_RESPOND`). `off` takes nothing, whatever `respond` says. */
  level: RespondLevel;
}

/** The kinds of answer OpenCode has no equivalent for. `/clear` is not here: it is a command, and `deliver` refuses every command but `/compact`. */
const UNSUPPORTED: readonly RespondKind[] = ['plan-approve', 'plan-feedback'];

/** Which kinds of delivery take an ask of each kind. */
const TAKES: Record<Ask['kind'], readonly Delivery['kind'][]> = { permission: ['allow-once', 'deny', 'reply'], question: ['question'] };

/** What a report says while the person has not allowed answering: level `off`, nothing taken. Absent, the console reads "Reporter can't answer" (SPEC 6.8, #1011). */
export const RESPOND_OFF: RespondInfo = { level: 'off', accepts: [], limits: [] };

export class Answering {
  /** Ask ids with a wait running. */
  private readonly listening = new Set<string>();

  constructor(
    private readonly responder: Responder,
    private readonly host: Host,
    private readonly consent: Consent,
    private readonly now: () => number = Date.now,
    /** Where a warning goes. The reporter's log drops a line it has just said, so a call that keeps failing the same way is said once. */
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  private warn(what: string, err: unknown): void {
    this.log(`podium-reporter: OpenCode did not take ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }

  /** What the session takes now. While the person has not allowed answering it is level `off` and takes nothing: a report with no `respond` reads as "Reporter can't answer" (SPEC 6.8), which is not the case (#1011). */
  info(): RespondInfo {
    if (!this.consent.respond) return RESPOND_OFF;
    // A question form cannot be given up for a typed reply until OpenCode can cancel a form and take a prompt in one step (#968).
    const limits: RespondLimit[] = ['no-reply-in-place'];
    const accepts = acceptsFor(this.consent.level, limits, this.consent.activityFeed).filter((k) => !UNSUPPORTED.includes(k) && (k !== 'question' || this.host.formChannel() !== null));
    return { level: this.consent.level, accepts, limits };
  }

  /** The asks Podium may be told of: only while the server takes answers, and only those it can answer. */
  asks(root: Root, transport: Transport): PodiumAsk[] {
    if (!transport.respond || !this.info().accepts.length) return [];
    return [...root.asks.values()].filter((a) => this.can(a)).flatMap((a) => podiumAsk(a, root) ?? []).slice(0, 8);
  }

  private can(a: Ask): boolean {
    const accepts = this.info().accepts;
    return accepts.includes(a.kind === 'permission' ? 'permission' : 'question');
  }

  /** One pass after a report: starts a wait for each new ask and acts on the messages and commands the reply handed over. */
  async drive(root: Root, transport: Transport): Promise<void> {
    if (!transport.respond || !this.info().accepts.length) return;
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
        if (reply === 'once') await this.host.permissionReply(ask.sessionId, ask.id, reply);
        else await this.host.permissionReply(ask.sessionId, ask.id, reply, rejectMessage(d));
        this.record(root, ask, d);
        return this.result(root, d, 'took');
      }
      const answer = formAnswer(ask.fields ?? [], d.answers ?? []);
      if (!answer) return this.result(root, d, 'refused');
      if (this.host.formChannel() === null) return this.result(root, d, 'not-taken');
      await this.host.formReply(ask.sessionId, ask.id, answer);
      this.record(root, ask, d);
      return this.result(root, d, 'took');
    } catch (err) {
      this.warn('an answer from Podium', err);
      return this.result(root, d, 'not-taken');
    }
  }

  /** An answer or approval OpenCode took is kept in the recording once, in order after the call it answers, marked with who sent it (#353). The recorder keeps nothing while recording is off. */
  private record(root: Root, ask: Ask, d: Delivery): void {
    const owner = root.sessions.get(ask.sessionId);
    const callSeq = (ask.callId ? owner?.calls.get(ask.callId)?.recSeq : null) ?? null;
    root.recorder.decided(owner ? loopKey(root, owner) : MAIN_LOOP, callSeq, decisionRecord(d, ask), this.now());
  }

  /** A message or `/compact`. Anything else is refused. */
  private async deliver(root: Root, d: Delivery): Promise<void> {
    const accepts = this.info().accepts;
    try {
      if (d.kind === 'message' && accepts.includes('message') && d.text) {
        const busy = [...root.sessions.values()].some((s) => s.executing);
        const framed = framedMessage(d);
        // Seen back as the prompt it becomes: the recording keeps the text that was sent, which is how the server knows it is Podium's.
        root.sentFromPodium.push({ framed, text: d.text });
        if (root.sentFromPodium.length > 20) root.sentFromPodium.shift();
        // Queued while a turn runs, and the later `took` follows once OpenCode has the prompt (SPEC 7.1).
        if (busy) this.result(root, d, 'queued');
        await this.host.prompt(root.id, d.id, framed);
        return this.result(root, d, 'took');
      }
      if (d.kind === 'command' && d.command === 'compact' && accepts.includes('command')) {
        root.podiumCompact = d.by;
        await this.host.compact(root.id, d.id);
        return this.result(root, d, 'took');
      }
      return this.result(root, d, 'refused');
    } catch (err) {
      this.warn(d.kind === 'message' ? 'a message from Podium' : 'the /compact from Podium', err);
      // Not `not-taken`: SPEC 7.1 keeps that for a plan approval, and it would lock the ask.
      return this.result(root, d, 'refused');
    }
  }
}
