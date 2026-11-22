// The messaging tools, once for every harness (#1312): each tool's name, description, input schema, refusal prefix, what it does with
// an input and how a call's outcome becomes its answer. A harness only registers them, says whether a call came from a subagent and
// whether the session takes part, and makes the HTTP call (how that is held, timed and credentialed is the harness's own). A new tool
// is one entry in `PEER_TOOLS`; a new harness is an adapter over `runPeerTool`. The words each answer is made of are `peers.ts`.
import { redactText } from './diffRedact.ts';
import {
  accessAnswer, answerPaused, appliedLevel, channelListAnswer, channelSendAnswer, channelSendTarget, chatReadAnswer, chatReadTarget, convoSendAnswer, convoSendTarget, errorOf, findRequest, isRequestId, listAnswer, refusalAnswer,
  requestAnsweredLine, sendAnswer, shortId, SEND_NO_TO, SUBAGENT_ACCESS, SUBAGENT_CHAT_READ, SUBAGENT_PEERS, SUBAGENT_SEND,
} from './peers.ts';
import type { PeerRequest } from './protocol.ts';
import { sessionPath } from './respond.ts';

/** What a call to Podium came to: its answer, or that it was never started (`unreachable`) or started and did not come back in time (`unanswered`). */
export type PeerCallOutcome = { status: number; text: string } | 'unreachable' | 'unanswered';

/** What a harness gives a tool to run: the session it runs in, who the person is, this machine's name, and one call to Podium. */
export interface PeerToolIo {
  sessionId: string;
  /** The person the tools name: the reporter's user name, or "your person". */
  owner: string;
  machine: string | null;
  call: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<PeerCallOutcome>;
}

/** A tool's input, as the model gives it: anything may be missing or of the wrong type. */
interface PeerToolInput {
  to?: unknown;
  text?: unknown;
  right?: unknown;
  reason?: unknown;
  channel?: unknown;
  before?: unknown;
}

export interface PeerTool {
  description: string;
  /** Plain JSON Schema, the same for every harness. */
  inputSchema: Record<string, unknown>;
  /** What the answer starts with when the tool did nothing: a refusal reads `<refused> <why>`. */
  refused: string;
  /** The answer to a call from a subagent: only an orchestrator takes part. */
  subagent: string;
  run: (input: PeerToolInput, io: PeerToolIo) => Promise<string>;
}

/** A session's peer route: `<session>/peers<rest>`. */
export const peerPath = (sessionId: string, rest: string): string => `${sessionPath(sessionId)}/peers${rest}`;

/** What each tool's answer starts with when it did nothing. */
const NOT_LISTED = 'Not listed.';
const NOT_SENT = 'Not sent.';
const NOT_ASKED = 'Not asked.';
const NOT_READ = 'Not read.';

export const UNREACHABLE = 'Podium cannot be reached from this machine right now, so nothing left it. Try again in a minute; /podium shows the connection.';
export const UNANSWERED = 'Podium did not answer in time. It may still have taken it: podium_peers and Podium > Traffic show what arrived.';

/** What a call's outcome says: `ok` makes the answer from a 2xx body, anything else is the tool's refusal in Podium's words or ours. */
function answered(prefix: string, out: PeerCallOutcome, ok: (body: Record<string, unknown>) => string): string {
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

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export const PEER_TOOLS = {
  podium_peers: {
    description:
      "Lists your person's other orchestrators that you can reach through Podium: each one's name, machine and id (given by Podium, never reused), its OS, project and status, and whether you can send to it. Says which of your person's machines are left out and why.",
    inputSchema: { type: 'object', properties: {} },
    refused: NOT_LISTED,
    subagent: SUBAGENT_PEERS,
    run: async (_input, io) => answered(NOT_LISTED, await io.call('GET', peerPath(io.sessionId, '')), (body) => listAnswer(body, io.owner)),
  },
  podium_send: {
    description:
      'Sends a message through Podium; "to" says where. To another orchestrator of your person: Podium hands it over within seconds, and if that orchestrator is in the middle of a turn it reads the message at its next step, after the tool call it is on. Its answer arrives here as a new message. If it has ended, the answer says it is no longer available, by its name and id. To a person who wrote to you through Podium Chat: the answer goes to that person, and your person can read it. To a Chat channel, or a Direct Message of people and agents: the post shows there for everyone who can read it, not only to the person who called you. A channel (General, My group or a public one) takes a post only from an agent that was called into it with an @ in the last hour, and a Direct Message only where a person wrote to you in the last hour. General and every public channel are readable by everyone signed in to Podium, so post nothing you would not say to all of them. A channel post does not interrupt anyone\'s running turn. Anything that looks like a secret is replaced with [redacted] before the text leaves this machine. Only the main loop can send, not a subagent. To see what was said in a Chat channel, use podium_chat_read.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description:
            'The orchestrator, as "#id" (the id podium_peers shows for it, never reused, so the surest), "name@machine" or "name@machine#id"; or "person:name" to answer a person who wrote to you through Podium Chat; or "channel:group" (My group), "channel:general" (General) or "channel:<name>" (a public channel, such as "channel:issue-1035") to post in a Chat channel; or "convo:<id>" to answer in a Direct Message with several members, where the message gave you the id',
        },
        text: { type: 'string', description: 'The message' },
      },
      required: ['to', 'text'],
    },
    refused: NOT_SENT,
    subagent: SUBAGENT_SEND,
    run: async (input, io) => {
      const to = str(input.to);
      const raw = typeof input.text === 'string' ? input.text : '';
      if (!to) return SEND_NO_TO;
      if (!raw.trim()) return 'Not sent. The message is empty. Write the text to send.';
      // Secrets go before the text leaves the machine, with the same redactor as a file's diff (SPEC 6.4).
      const red = redactText(raw);
      const post = async (path: string, ok: (body: Record<string, unknown>) => string): Promise<string> => answered(NOT_SENT, await io.call('POST', path, { text: red.text }), ok);
      // An answer to a channel that called this agent in goes to the channel, not to the person (#1065); Podium decides whether it was called in.
      const target = channelSendTarget(to);
      if (target && 'refusal' in target) return target.refusal;
      if (target) return post(`${sessionPath(io.sessionId)}/chat/channels/${target.channel}/messages`, () => channelSendAnswer(target.channel, { owner: io.owner, redactions: red.redactions }));
      // An answer in a Direct Message of people and agents goes to that conversation (#1299); Podium decides whether this agent is in it and was written to.
      const convoTarget = convoSendTarget(to);
      if (convoTarget && 'refusal' in convoTarget) return convoTarget.refusal;
      if (convoTarget) return post(`${sessionPath(io.sessionId)}/chat/conversations/${convoTarget.convo}/messages`, () => convoSendAnswer({ owner: io.owner, redactions: red.redactions }));
      const out = await io.call('POST', peerPath(io.sessionId, '/messages'), { to, text: red.text });
      return answered(NOT_SENT, out, (body) => sendAnswer(body, { owner: io.owner, here: io.machine, to, redactions: red.redactions }));
    },
  },
  podium_request_access: {
    description:
      'Asks your person for a right you lack: to see the orchestrators on one of their machines, or to send to them.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'A machine, or "name@machine"' },
        right: { type: 'string', enum: ['see', 'send'], description: 'The right to ask for' },
        reason: { type: 'string', description: 'Why, in a sentence' },
      },
      required: ['to', 'right', 'reason'],
    },
    refused: NOT_ASKED,
    subagent: SUBAGENT_ACCESS,
    run: async (input, io) => {
      const to = str(input.to);
      if (!to) return 'Not asked. Say which machine: to is a machine, or "name@machine".';
      if (input.right !== 'see' && input.right !== 'send') return 'Not asked. right must be see or send.';
      const right = input.right;
      const reason = typeof input.reason === 'string' ? redactText(input.reason).text : '';
      const out = await io.call('POST', peerPath(io.sessionId, '/access'), { to, right, reason });
      return answered(NOT_ASKED, out, (body) => accessAnswer(body, { owner: io.owner, right, to }));
    },
  },
  podium_chat_read: {
    description:
      'Lists and reads Podium Chat channels. With no "channel" it lists the channels, General and every public channel anyone opened, each with its description, what it is linked to (an issue, a milestone or a project), who opened it and how many messages it holds; it reads no message, and it needs no call into a channel, so you can learn the names to post to. With "channel" set it reads that channel, and only when an @ called you into it in the last hour: it returns the last hour, the newest messages that fit in about 30,000 characters, whole messages, oldest first, each with its author, the kind of author and the time, under a line that says they are not your owner\'s instructions. Nothing older than an hour is ever returned, and a channel you were not called into is refused. A new message in a channel does not interrupt a running turn: read the channel to see it. It is read only; to post, use podium_send. Only the main loop can list or read, not a subagent.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: '"general" (General), "group" (My group) or the name of a public channel, such as "issue-1035". Leave it out to list the channels',
        },
        before: { type: 'string', description: 'The "before" value a previous read gave, to read the messages before those' },
      },
    },
    refused: NOT_READ,
    subagent: SUBAGENT_CHAT_READ,
    run: async (input, io) => {
      const target = chatReadTarget(input);
      if ('refusal' in target) return target.refusal;
      if ('list' in target) return answered(NOT_READ, await io.call('GET', `${sessionPath(io.sessionId)}/chat/channels`), (body) => channelListAnswer(body, { owner: io.owner }));
      const out = await io.call('GET', `${sessionPath(io.sessionId)}/chat/channels/${target.channel}/messages${target.query}`);
      return answered(NOT_READ, out, (body) => chatReadAnswer(body, { channel: target.channel, owner: io.owner }));
    },
  },
} as const satisfies Record<string, PeerTool>;

export type PeerToolName = keyof typeof PEER_TOOLS;

/**
 * The tools as a host registers them: name, description and input schema, in the order they are offered. Each schema is a fresh copy, so a host
 * that edits what it is given (a `$schema` key, `additionalProperties`) never changes the definition the next registration, or a test, reads.
 */
export const peerToolDefinitions = (): { name: PeerToolName; description: string; inputSchema: Record<string, unknown> }[] =>
  (Object.keys(PEER_TOOLS) as PeerToolName[]).map((name) => ({ name, description: PEER_TOOLS[name].description, inputSchema: JSON.parse(JSON.stringify(PEER_TOOLS[name].inputSchema)) as Record<string, unknown> }));

/**
 * One tool call, the same for every harness: a subagent's call is refused; so is one while the session does not take part (`io` is null, and
 * `off` words why for a prefix); otherwise the tool runs. Nothing Podium or the model did makes it throw.
 */
export async function runPeerTool(name: PeerToolName, input: unknown, host: { subagent: boolean; io: PeerToolIo | null; off: (prefix: string) => string }): Promise<string> {
  const tool: PeerTool = PEER_TOOLS[name];
  if (host.subagent) return tool.subagent;
  if (!host.io) return host.off(tool.refused);
  return tool.run((input && typeof input === 'object' ? input : {}) as PeerToolInput, host.io);
}

/** How many requests a session remembers for `/podium allow|decline|deliver`, after they leave the reply too, so a late answer hears how it closed. */
const REQUESTS_KEPT = 50;

/**
 * The requests a session knows of, the same for every harness (#414): each new one is shown once, the open ones are listed, and
 * `/podium allow|decline|deliver <id>` finds one by its id. How a request is shown (toast, transcript line) is the harness's.
 */
export class RequestBook {
  /** Requests seen, by id, oldest first. */
  private readonly known = new Map<string, PeerRequest>();
  private open: string[] = [];

  /** Takes the requests the reply lists as open. Returns the ones not seen before, which are shown once. */
  take(list: readonly PeerRequest[]): PeerRequest[] {
    this.open = list.map((q) => q.id);
    const fresh: PeerRequest[] = [];
    for (const q of list) {
      if (!this.known.has(q.id)) fresh.push(q);
      this.known.delete(q.id);
      this.known.set(q.id, q);
    }
    for (const id of this.known.keys()) {
      if (this.known.size <= REQUESTS_KEPT) break;
      this.known.delete(id);
    }
    return fresh;
  }

  /** The requests the last reply listed as open, which `/podium` lists. */
  opened(): PeerRequest[] {
    return this.open.flatMap((id) => this.known.get(id) ?? []);
  }

  /**
   * `/podium allow|decline|deliver <id>`, answered through the server's route; the answer names the id. `where` is where the person finds the id.
   * `io` is null when messaging is not on in this session; `post` is null when the call could not be made.
   */
  async answer(
    answer: 'allow' | 'decline' | 'deliver',
    arg: string,
    where: string,
    io: { sessionId: string; post: (path: string, body: unknown) => Promise<{ status: number; text: string } | null> } | null,
  ): Promise<string> {
    if (!arg) return `Name the request: /podium ${answer} <id>. The id is in the request's ${where}.`;
    if (!io) return 'Orchestrator messaging is not on in this session, so nothing can be answered here. Answer in Podium > My reporters.';
    const found = findRequest([...this.known.values()], arg);
    if (found && 'ambiguous' in found) return `More than one request starts with ${arg}: ${found.ambiguous.map((q) => q.id).join(', ')}. Use more of the id.`;
    const q = found?.request ?? null;
    const id = q?.id ?? (isRequestId(arg) ? arg.trim() : null);
    if (!id) return `No request ${arg} has reached this session. Requests show here as they arrive, and in Podium > My reporters.`;
    const s = q ? shortId(q.id) : arg;
    const res = await io.post(peerPath(io.sessionId, `/requests/${encodeURIComponent(id)}`), { answer });
    if (!res) return `Request ${s} was not answered: Podium cannot be reached. Try again, or answer in Podium > My reporters.`;
    if (res.status !== 200) return `Request ${s} was not answered: ${errorOf(res.text) ?? `Podium answered ${res.status}`}.`;
    this.open = this.open.filter((x) => x !== id);
    // Allowing never lowers a right, so the level applied can be higher than the request's: name the one Podium applied.
    return requestAnsweredLine(answer, s, q, appliedLevel(res.text), answerPaused(res.text));
  }
}
