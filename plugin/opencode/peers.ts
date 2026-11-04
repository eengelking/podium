// Orchestrator messaging in the OpenCode reporter (#969, #347, #414, SPEC 5.3): the three tools an orchestrator calls, the messages that arrive
// for it, and the person's answers to a request. The words (what each tool answers, the frame a message comes under, the toasts) are
// `core/peers.ts`, the same as Claude Code's. What is OpenCode's own is how a message enters (`session.prompt`, queued behind the turn that
// runs) and how a tool reaches Podium: straight from the tool's call, with the reporter's own credential (the same `fetch` as its reports, so
// the rights are the OpenCode reporter's own and not Claude Code's on the same machine), under a time limit.
//
// A peer message only ever becomes a framed prompt. It never touches answering (`answering.ts`): no ask, no approval, no command.
import type { PeerDelivery, PeerRequest, PeerResult } from '../core/protocol.ts';
import { sessionPath, type Responder } from '../core/respond.ts';
import type { Transport } from '../core/transport.ts';
import { redactText } from '../core/diffRedact.ts';
import {
  accessAnswer, answerPaused, appliedLevel, deliveredLine, errorOf, findRequest, isAccessAnswer, isRequestId, listAnswer, noticePrompt, oneLine, peerPrompt,
  refusalAnswer, requestAnsweredLine, requestLine, requestToast, sendAnswer, shortId, SUBAGENT_ACCESS, SUBAGENT_PEERS, SUBAGENT_SEND,
} from '../core/peers.ts';
import type { Root } from './state.ts';

/** How long a tool waits for Podium before it says it did not answer. */
export const PEER_CALL_WAIT_MS = 8000;
/** Requests remembered for `/podium allow|decline|deliver`, after they leave the reply too, so a late answer hears how it closed. */
const REQUESTS_KEPT = 50;

const UNREACHABLE = 'Podium cannot be reached from this machine right now, so nothing left it. Try again in a minute; /podium shows the connection.';
const UNANSWERED = 'Podium did not answer in time. It may still have taken it: podium_peers and Podium > Traffic show what arrived.';

export interface PeersDeps {
  responder: Responder;
  /** Submits text as a prompt, queued behind the turn that runs (`session.prompt`). `id` is Podium's delivery id, so one sent twice is one message. */
  prompt: (sessionId: string, id: string, text: string) => Promise<void>;
  /** Tells the person something where they see it (a toast). Absent: nothing is shown. */
  notify?: (line: string) => void;
  now: () => number;
  /** The person the tools name: the reporter's user name. */
  owner: () => string | null;
  /** This machine's name, for "can send to" answers. */
  machine: () => string | null;
  /** How long a tool waits for Podium. */
  callMs?: number;
}

type Outcome = { status: number; text: string } | 'unreachable' | 'unanswered';

/** The tools' input, as the model gives it: anything may be missing or of the wrong type. */
interface ToolInput {
  to?: unknown;
  text?: unknown;
  right?: unknown;
  reason?: unknown;
}

export class Peers {
  /** Requests seen, by id, oldest first: each is toasted once. */
  private readonly known = new Map<string, PeerRequest>();
  private open: string[] = [];

  constructor(private readonly d: PeersDeps) {}

  /** Whether this session takes part now: the person's option is on (the caller checks) and the server's last word for it is yes. */
  private on(root: Root, t: Transport): boolean {
    return !root.done && t.peers;
  }

  private path(root: Root, rest: string): string {
    return `${sessionPath(root.id)}/peers${rest}`;
  }

  private result(root: Root, id: string, result: PeerResult): void {
    this.d.responder.queue({ path: this.path(root, `/deliveries/${encodeURIComponent(id)}/result`), body: { result, at: this.d.now() } });
  }

  /** The reply's messaging fields. Unless the session takes part, nothing in them is taken, whatever the reply says. */
  take(root: Root, t: Transport): void {
    const deliveries = t.peerDeliveries;
    const requests = t.peerRequests;
    t.peerDeliveries = [];
    t.peerRequests = [];
    if (!this.on(root, t)) return;
    for (const d of deliveries) this.deliver(root, d);
    this.show(requests);
  }

  /** One message or notice, acted on once. A message only ever becomes a framed prompt. */
  private deliver(root: Root, d: PeerDelivery): void {
    if (!this.d.responder.markActed(d.id)) return;
    if (d.kind === 'notice') {
      // Podium's own sentence, shown. The answer to an access request is also a turn, as the tool promised.
      this.d.notify?.(oneLine(d.text, 1000));
      this.result(root, d.id, 'took');
      if (isAccessAnswer(d.text)) void this.d.prompt(root.id, d.id, noticePrompt(d.text)).catch(() => undefined);
      return;
    }
    const text = peerPrompt(d);
    if (!text) return this.result(root, d.id, 'refused');
    if ([...root.sessions.values()].some((s) => s.executing)) this.result(root, d.id, 'queued');
    void this.d.prompt(root.id, d.id, text).then(
      () => {
        if (d.from) this.d.notify?.(deliveredLine(d.from));
        this.result(root, d.id, 'took');
      },
      () => this.result(root, d.id, 'refused'),
    );
  }

  /** The owner's open requests: each new one is a toast (the only place a waiting message's text is shown). */
  private show(list: PeerRequest[]): void {
    this.open = list.map((q) => q.id);
    for (const q of list) {
      const seen = this.known.has(q.id);
      this.known.delete(q.id);
      this.known.set(q.id, q);
      if (!seen) this.d.notify?.(requestToast(q, shortId(q.id)));
    }
    for (const id of this.known.keys()) {
      if (this.known.size <= REQUESTS_KEPT) break;
      this.known.delete(id);
    }
  }

  /** The line `/podium` adds while requests wait: who and what, by short id, without a message's text. Empty when none. */
  openLine(): string {
    return this.open.flatMap((id) => this.known.get(id) ?? []).map((q) => requestLine(q, shortId(q.id))).join('\n');
  }

  private held(t: Transport): boolean {
    return t.online === false && this.d.now() < t.nextAttemptAt;
  }

  /** One call to Podium, at most `callMs`. One that was not even started is `unreachable`; one that was and has not come back is `unanswered`. */
  private async call(t: Transport, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Outcome> {
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

  private outcome(prefix: string, out: Outcome, ok: (body: Record<string, unknown>) => string): string {
    if (out === 'unreachable') return `${prefix} ${UNREACHABLE}`;
    if (out === 'unanswered') return `${prefix} ${UNANSWERED}`;
    if (out.status >= 200 && out.status < 300) {
      try {
        return ok(JSON.parse(out.text) as Record<string, unknown>);
      } catch {
        return `${prefix} Podium's answer could not be read.`;
      }
    }
    return refusalAnswer(prefix, errorOf(out.text) ?? `Podium answered ${out.status}`);
  }

  private owner(): string {
    return this.d.owner()?.trim() || 'your person';
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

  /** `podium_peers`: the other orchestrators this one can reach. */
  async list(root: Root | undefined, t: Transport | undefined, sub: boolean): Promise<string> {
    if (sub) return SUBAGENT_PEERS;
    if (!root || !t || !this.on(root, t)) return this.off('Not listed.', root, t);
    return this.outcome('Not listed.', await this.call(t, 'GET', this.path(root, '')), (body) => listAnswer(body, this.owner()));
  }

  /** `podium_send`: a message to another orchestrator. Secrets are replaced before the text leaves the machine. */
  async send(root: Root | undefined, t: Transport | undefined, sub: boolean, input: ToolInput): Promise<string> {
    if (sub) return SUBAGENT_SEND;
    if (!root || !t || !this.on(root, t)) return this.off('Not sent.', root, t);
    const to = typeof input.to === 'string' ? input.to.trim() : '';
    const raw = typeof input.text === 'string' ? input.text : '';
    if (!to) return 'Not sent. Say who it is for: to is "name@machine", as podium_peers lists it.';
    if (!raw.trim()) return 'Not sent. The message is empty. Write the text to send.';
    const red = redactText(raw);
    const out = await this.call(t, 'POST', this.path(root, '/messages'), { to, text: red.text });
    return this.outcome('Not sent.', out, (body) => sendAnswer(body, { owner: this.owner(), here: this.d.machine(), to, redactions: red.redactions }));
  }

  /** `podium_request_access`: asks the person for a right the orchestrator lacks. */
  async access(root: Root | undefined, t: Transport | undefined, sub: boolean, input: ToolInput): Promise<string> {
    if (sub) return SUBAGENT_ACCESS;
    if (!root || !t || !this.on(root, t)) return this.off('Not asked.', root, t);
    const to = typeof input.to === 'string' ? input.to.trim() : '';
    if (!to) return 'Not asked. Say which machine: to is a machine, or "name@machine".';
    if (input.right !== 'see' && input.right !== 'send') return 'Not asked. right must be see or send.';
    const right = input.right;
    const reason = typeof input.reason === 'string' ? redactText(input.reason).text : '';
    const out = await this.call(t, 'POST', this.path(root, '/access'), { to, right, reason });
    return this.outcome('Not asked.', out, (body) => accessAnswer(body, { owner: this.owner(), right, to }));
  }

  /** `/podium allow|decline|deliver <id>`: answered through the server's route, and the answer names the id. */
  async answer(root: Root | undefined, t: Transport | undefined, answer: 'allow' | 'decline' | 'deliver', arg: string): Promise<string> {
    if (!arg) return `Name the request: /podium ${answer} <id>. The id is in the request's toast.`;
    if (!root || !t || !this.on(root, t)) return 'Orchestrator messaging is not on in this session, so nothing can be answered here. Answer in Podium > My reporters.';
    const found = findRequest([...this.known.values()], arg);
    if (found && 'ambiguous' in found) return `More than one request starts with ${arg}: ${found.ambiguous.map((q) => q.id).join(', ')}. Use more of the id.`;
    const q = found?.request ?? null;
    const id = q?.id ?? (isRequestId(arg) ? arg.trim() : null);
    if (!id) return `No request ${arg} has reached this session. Requests show here as they arrive, and in Podium > My reporters.`;
    const s = q ? shortId(q.id) : arg;
    const res = await this.d.responder.call('POST', this.path(root, `/requests/${encodeURIComponent(id)}`), { answer });
    if (!res) return `Request ${s} was not answered: Podium cannot be reached. Try again, or answer in Podium > My reporters.`;
    if (res.status !== 200) return `Request ${s} was not answered: ${errorOf(res.text) ?? `Podium answered ${res.status}`}.`;
    this.open = this.open.filter((x) => x !== id);
    return requestAnsweredLine(answer, s, q, appliedLevel(res.text), answerPaused(res.text));
  }
}
