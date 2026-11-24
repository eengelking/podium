// Orchestrator messaging in the OpenCode reporter (#969, #347, #414, SPEC 5.3): the tools an orchestrator calls, the messages that arrive
// for it, and the person's answers to a request. The tools themselves (what each is, says and does, and how a call's outcome reads) are
// `core/peerTools.ts`, and the words are `core/peers.ts`, the same as Claude Code's. What is OpenCode's own is how a message enters
// (`session.prompt`, queued behind the turn that runs, or steered into it at its next step, #1264) and how a tool reaches Podium: straight
// from the tool's call, with the reporter's own credential (the same `fetch` as its reports, so the rights are the OpenCode reporter's own and
// not Claude Code's on the same machine), under a time limit.
//
// A peer message only ever becomes a framed prompt. It never touches answering (`answering.ts`): no ask, no approval, no command.
import type { PeerDelivery, PeerRequest, PeerResult } from '../core/protocol.ts';
import type { Responder } from '../core/respond.ts';
import type { Transport } from '../core/transport.ts';
import { isLaunchId } from '../core/launch.ts';
import { deliveredLine, endedNoticePrompt, isAccessAnswer, isEndedNotice, noticePrompt, oneLine, peerPrompt, refusalAnswer, requestLine, requestToast, shortId } from '../core/peers.ts';
import { peerPath, RequestBook, runPeerTool, type PeerCallOutcome, type PeerToolName } from '../core/peerTools.ts';
import type { PromptDelivery } from './answering.ts';
import type { Root } from './state.ts';

/** How long a tool waits for Podium before it says it did not answer. */
const PEER_CALL_WAIT_MS = 8000;

export interface PeersDeps {
  responder: Responder;
  /** Submits text as a prompt (`session.prompt`): queued behind the turn that runs, or, with `steer`, taken at the turn's next step (#1264). `id` is Podium's delivery id, so one sent twice is one message. */
  prompt: (sessionId: string, id: string, text: string, delivery?: PromptDelivery) => Promise<void>;
  /** Tells the person something where they see it (a toast). Absent: nothing is shown. */
  notify?: (line: string) => void;
  now: () => number;
  /** The person the tools name: the reporter's user name. */
  owner: () => string | null;
  /** This machine's name, for "can send to" answers. */
  machine: () => string | null;
  /** How long a tool waits for Podium. */
  callMs?: number;
  /** Where a warning goes (the reporter's log, which drops a line it has just said). */
  log?: (line: string) => void;
}

export class Peers {
  /** The requests seen: each new one is toasted once. */
  private readonly requests = new RequestBook();

  constructor(private readonly d: PeersDeps) {}

  /** Whether this session takes part now: the person's option is on (the caller checks) and the server's last word for it is yes. */
  private on(root: Root, t: Transport): boolean {
    return !root.done && t.peers;
  }

  private result(root: Root, id: string, result: PeerResult): void {
    this.d.responder.queue({ path: peerPath(root.id, `/deliveries/${encodeURIComponent(id)}/result`), body: { result, at: this.d.now() } });
  }

  /** The reply's messaging fields. Unless the session takes part, nothing in them is taken, whatever the reply says. */
  take(root: Root, t: Transport): void {
    const deliveries = t.peerDeliveries;
    const requests = t.peerRequests;
    t.peerDeliveries = [];
    t.peerRequests = [];
    if (!this.on(root, t)) return;
    // The launch placeholder (#1112) is no OpenCode session, so a message cannot be given to it: the sender is told it was refused at once.
    if (isLaunchId(root.id)) {
      for (const d of deliveries) if (this.d.responder.markActed(d.id)) this.result(root, d.id, 'refused');
    } else {
      for (const d of deliveries) this.deliver(root, d);
    }
    this.show(requests);
  }

  /** One message or notice, acted on once. A message only ever becomes a framed prompt. */
  private deliver(root: Root, d: PeerDelivery): void {
    if (!this.d.responder.markActed(d.id)) return;
    if (d.kind === 'notice') {
      // Podium's own sentence, shown. The answer to an access request is also a turn, as the tool promised.
      this.d.notify?.(oneLine(d.text, 1000));
      this.result(root, d.id, 'took');
      if (isAccessAnswer(d.text)) void this.d.prompt(root.id, d.id, noticePrompt(d.text)).catch((err) => this.warn('a notice from Podium', err));
      // A direct message this orchestrator was in has ended (#1283): the agent is told in Podium's own words, so it neither continues it nor opens a new one.
      if (isEndedNotice(d.text)) void this.d.prompt(root.id, d.id, endedNoticePrompt(d.text)).catch((err) => this.warn('a notice from Podium', err));
      return;
    }
    const busy = [...root.sessions.values()].some((s) => s.executing);
    const text = peerPrompt(d, busy);
    if (!text) return this.result(root, d.id, 'refused');
    if (busy) this.result(root, d.id, 'queued');
    // While a turn runs the message is steered in, so the agent reads it at its next step instead of after the turn (#1264).
    // A steer the host refuses (the turn ended between the check and the call) is tried once more as an ordinary queued prompt.
    const send = busy ? this.d.prompt(root.id, d.id, text, 'steer').catch(() => this.d.prompt(root.id, d.id, text, 'queue')) : this.d.prompt(root.id, d.id, text, 'queue');
    void send.then(
      () => {
        if (d.from) this.d.notify?.(deliveredLine(d.from));
        this.result(root, d.id, 'took');
      },
      (err) => {
        this.warn('a message from another orchestrator', err);
        this.result(root, d.id, 'refused');
      },
    );
  }

  private warn(what: string, err: unknown): void {
    this.d.log?.(`podium-reporter: OpenCode did not take ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }

  /** The owner's open requests: each new one is a toast (the only place a waiting message's text is shown). */
  private show(list: PeerRequest[]): void {
    for (const q of this.requests.take(list)) this.d.notify?.(requestToast(q, shortId(q.id)));
  }

  /** The line `/podium` adds while requests wait: who and what, by short id, without a message's text. Empty when none. */
  openLine(): string {
    return this.requests
      .opened()
      .map((q) => requestLine(q, shortId(q.id)))
      .join('\n');
  }

  private held(t: Transport): boolean {
    return t.online === false && this.d.now() < t.nextAttemptAt;
  }

  /** One call to Podium, at most `callMs`. One that was not even started is `unreachable`; one that was and has not come back is `unanswered`. */
  private async call(t: Transport, method: 'GET' | 'POST', path: string, body?: unknown): Promise<PeerCallOutcome> {
    if (this.held(t)) return 'unreachable';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<'unanswered'>((resolve) => {
      timer = setTimeout(() => resolve('unanswered'), this.d.callMs ?? PEER_CALL_WAIT_MS);
    });
    try {
      return (await Promise.race([this.d.responder.call(method, path, body), limit])) ?? 'unreachable';
    } finally {
      clearTimeout(timer);
    }
  }

  /** The refusal when the session does not take part now, with the cause as far as the reporter knows it. */
  private off(prefix: string, root: Root | undefined, t: Transport | undefined): string {
    let why = ' in Podium right now';
    if (!root || !t || t.sent === 0) why = ' because the session has not reported yet: send it a prompt';
    else if (root.done) why = ' because the session has ended';
    else if (!this.d.owner()?.trim()) why = " because there is no user name: messaging is only between one person's own reporters, so set PODIUM_USER";
    else if (!t.peers) why = " because Podium's messaging flag is off (Admin > Settings), or this reporter signs in with the admin secret, which belongs to no person";
    return refusalAnswer(prefix, `orchestrator messaging is off for this session${why}`);
  }

  /** A messaging tool's call (`core/peerTools.ts` holds what each does): refused from a subagent's session, and while the session does not take part. */
  tool(name: PeerToolName, root: Root | undefined, t: Transport | undefined, sub: boolean, input: unknown): Promise<string> {
    const io =
      root && t && this.on(root, t)
        ? { sessionId: root.id, owner: this.d.owner()?.trim() || 'your person', machine: this.d.machine(), call: (method: 'GET' | 'POST', path: string, body?: unknown) => this.call(t, method, path, body) }
        : null;
    return runPeerTool(name, input, { subagent: sub, io, off: (prefix) => this.off(prefix, root, t) });
  }

  /** `/podium allow|decline|deliver <id>`: answered through the server's route, and the answer names the id. */
  answer(root: Root | undefined, t: Transport | undefined, answer: 'allow' | 'decline' | 'deliver', arg: string): Promise<string> {
    const io = root && t && this.on(root, t) ? { sessionId: root.id, post: (path: string, body: unknown) => this.d.responder.call('POST', path, body) } : null;
    return this.requests.answer(answer, arg, 'toast', io);
  }
}
