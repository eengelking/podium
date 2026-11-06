// Chat's data (#1034, mockup/podium-chat.html): the shapes the server's /respond/chat routes answer with, the calls, and
// the words and small rules the page uses, so each can be tested without drawing. Nothing here holds a token. The server
// sends a `chat` event that carries no text; the page reads again on it, and message text only ever comes from the routes.
import { call } from "./respondApi";
import { hm } from "./trafficData";
import { PEER_DROP_WORDS } from "../../../plugin/core/protocol";

export type AgentStatus = "running" | "waiting" | "done";

/** A channel as the overview lists it. `can` says what the viewer may do to it; the page offers nothing else. */
export interface ChatChannel {
  id: "general" | "group";
  name: string;
  thread: string;
  unread: number;
  mentions: number;
  messages: number;
  paused: boolean;
  pausedForEveryone: boolean;
  disconnected: boolean;
  can: { pause: boolean; pauseEveryone: boolean; disconnect: boolean; removeAll: boolean };
}

/** One end of a Direct Message: an agent, or the person (`kind: "person"`). */
export interface Party {
  sessionId: string;
  name: string;
  machine: string;
  reporterKey: string;
  kind: "agent" | "person";
  live: boolean;
  status: AgentStatus | null;
}

export interface DirectInfo {
  thread: string;
  a: Party;
  b: Party;
  owner: string;
  messages: number;
  lastAt: number;
  state: "active" | "waiting" | "paused";
  paused: boolean;
  canSend: { aToB: boolean; bToA: boolean };
  roundTrips: { used: number; cap: number };
  /** The names of agents that left while others did not. */
  ended: string[];
  unread: number;
  mentions: number;
  hiddenAt: number | null;
}

export interface ChatAgent {
  sessionId: string;
  name: string;
  machine: string;
  reporterKey: string;
  address: string;
  status: AgentStatus;
  waitReason: "permission" | "input" | null;
  peers: boolean;
}

export interface ChatOverview {
  enabled: true;
  serverTime: number;
  me: { name: string; admin: boolean; person: boolean };
  settings: { maxChars: number; perMinute: number; retainDays: number; graceHours: number; everyone: boolean };
  channels: ChatChannel[];
  directs: DirectInfo[];
  agents: ChatAgent[];
  people: { name: string; you: boolean }[];
}

export type MentionState = "waiting" | "working" | "done" | "not-delivered" | "held" | "dropped";

export interface Mention {
  typed: string;
  sessionId: string | null;
  state: MentionState;
  why: string | null;
  stateAt: number;
}

export interface ChannelMessage {
  id: string;
  authorKind: "person" | "orchestrator" | "subagent" | "reporter";
  authorName: string;
  authorRef: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  replyTo: string | null;
  issue: string | null;
  project: string | null;
  milestone: string | null;
  mine: boolean;
  mentions: Mention[];
}

export type DirectState = "approval" | "ready" | "handed" | "queued" | "delivered" | "declined" | "dropped";

export interface DirectMessage {
  id: string;
  author: "agent" | "person";
  from: { kind: "agent" | "person"; sessionId: string | null; name: string; machine: string };
  to: { sessionId: string; name: string; machine: string; state: DirectState; why: string | null }[];
  text: string;
  sentAt: number;
  state: DirectState;
  stateAt: number;
  why: string | null;
  approved: boolean;
}

export interface ChannelPageRead {
  ok: true;
  channel: "general" | "group";
  messages: ChannelMessage[];
  older: string | null;
  total: number;
}

export interface DirectPageRead {
  ok: true;
  thread: string;
  a: Party;
  b: Party;
  messages: DirectMessage[];
  older: string | null;
  total: number;
  ended: string[];
  owner: string;
  paused: boolean;
  roundTrips: { used: number; cap: number };
}

export interface Address {
  typed: string;
  label: string;
  role: "orchestrator" | "person" | "group" | "everyone";
  sessionId: string | null;
  disabled?: boolean;
  why?: string;
}

export const PAGE_SIZE = 50;

const BASE = "/api/fleet/respond/chat";
const enc = encodeURIComponent;
const qs = (o: { before?: string | null; limit?: number }) => {
  const q = new URLSearchParams();
  if (o.before) q.set("before", o.before);
  q.set("limit", String(o.limit ?? PAGE_SIZE));
  return `?${q}`;
};

export const chatApi = {
  overview: () => call<ChatOverview>("GET", BASE),
  markRead: (thread: string, upTo: string | null) => call<{ ok: true; unread: number; mentions: number }>("POST", `${BASE}/read`, { thread, upTo }),
  addresses: (channel: "general" | "group") => call<{ ok: true; addresses: Address[] }>("GET", `${BASE}/addresses?channel=${channel}`),
  channelMessages: (channel: string, o: { before?: string | null; limit?: number } = {}) => call<ChannelPageRead>("GET", `${BASE}/channels/${enc(channel)}/messages${qs(o)}`),
  post: (channel: string, text: string) => call<{ ok: true; message: ChannelMessage; warnings: string[] }>("POST", `${BASE}/channels/${enc(channel)}/messages`, { text }),
  pause: (channel: string, paused: boolean, everyone = false) => call<{ ok: true }>("PUT", `${BASE}/channels/${enc(channel)}/pause`, { paused, ...(everyone ? { everyone: true } : {}) }),
  disconnect: (channel: string, disconnected: boolean) => call<{ ok: true }>("PUT", `${BASE}/channels/${enc(channel)}/disconnect`, { disconnected }),
  clear: (channel: string) => call<{ ok: true }>("DELETE", `${BASE}/channels/${enc(channel)}/messages`, {}),
  dmMessages: (a: string, b: string, o: { before?: string | null; limit?: number } = {}) => call<DirectPageRead>("GET", `${BASE}/dm/${enc(a)}/${enc(b)}/messages${qs(o)}`),
  sendDm: (a: string, b: string, text: string) => call<{ ok: true; message: DirectMessage; skipped: { name: string; why: string }[]; errors: { name: string; error: string }[] }>("POST", `${BASE}/dm/${enc(a)}/${enc(b)}/messages`, { text }),
  deleteDm: (a: string, b: string) => call<{ ok: true; removed: number }>("DELETE", `${BASE}/dm/${enc(a)}/${enc(b)}`),
  /** A Direct Message's Pause link and Remove link, which were Traffic's: the same routes, by the two reporters' keys. */
  pauseLink: (a: string, b: string, paused: boolean) => call<{ ok: true }>("PUT", "/api/fleet/respond/peers/links", { a, b, paused }),
  removeLink: (a: string, b: string) => call<{ ok: true }>("DELETE", "/api/fleet/respond/peers/links", { a, b }),
};

export type ChatApi = typeof chatApi;

/** A server reason without its closing full stop, so a sentence built around it does not end in two. */
export const plain = (s: string): string => s.replace(/[.\s]+$/, "");

// ---- Direct Messages ---------------------------------------------------------------------------------------------------

/** The agents of a conversation, sorted and joined: the same for one you have not started yet and one that is stored. */
export function dmKey(d: Pick<DirectInfo, "a" | "b">): string {
  return [d.a, d.b]
    .filter((p) => p.kind === "agent")
    .map((p) => p.sessionId)
    .sort()
    .join("+");
}

/** A conversation between the person and one agent is named by the agent; one between two agents by both. */
export function dmName(d: Pick<DirectInfo, "a" | "b">): string {
  const agents = [d.a, d.b].filter((p) => p.kind === "agent");
  return agents.map((p) => p.name).join(", ");
}

/** A conversation between two agents has a link to pause and remove; the person's own with one agent has none. */
export const hasLink = (d: Pick<DirectInfo, "a" | "b">): boolean => d.a.kind === "agent" && d.b.kind === "agent";

export type TagIcon = "pause" | "clock" | "trash";
export interface Tag {
  icon: TagIcon;
  text: string;
  warn?: boolean;
}

const joinNames = (names: string[]) => names.join(" and ");

export function channelTag(c: Pick<ChatChannel, "paused" | "pausedForEveryone" | "disconnected">): Tag | null {
  if (c.disconnected) return { icon: "pause", text: "Your agents are disconnected" };
  if (c.paused) return { icon: "pause", text: c.pausedForEveryone ? "Paused for everyone" : "Paused", warn: true };
  return null;
}

export function dmTag(d: Pick<DirectInfo, "a" | "b" | "state" | "paused" | "canSend" | "ended">): Tag | null {
  if (hasLink(d) && !d.canSend.aToB && !d.canSend.bToA && d.state === "active") return { icon: "trash", text: "Link removed" };
  if (d.ended.length) return { icon: "pause", text: `${joinNames(d.ended)} ended` };
  if (d.state === "waiting") return { icon: "clock", text: "Waiting for approval", warn: true };
  if (d.state === "paused" || d.paused) return { icon: "pause", text: "Paused" };
  return null;
}

// ---- Delivery lines ----------------------------------------------------------------------------------------------------

export type DeliveryIcon = "ok" | "queue" | "clock" | "pause" | "no";
export interface Delivery {
  icon: DeliveryIcon;
  text: string;
  wait: boolean;
}

const nameOf = (typed: string): string => typed.split("@")[0] ?? typed;
const list = (names: string[]): string => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** What became of a channel message, in one line. Someone else's message is simply Posted. */
export function channelDelivery(m: Pick<ChannelMessage, "mine" | "mentions">): Delivery {
  if (!m.mine) return { icon: "ok", text: "Posted", wait: false };
  const by = (...s: MentionState[]) => m.mentions.filter((x) => s.includes(x.state));
  const bad = by("not-delivered", "dropped");
  if (bad.length) {
    const why = bad[0]!.why ? `: ${plain(bad[0]!.why)}` : "";
    return { icon: "no", text: `Not delivered to ${list(bad.map((x) => nameOf(x.typed)))}${why}.`, wait: false };
  }
  const held = by("held");
  if (held.length) return { icon: "pause", text: `Held: ${plain(held[0]!.why ?? "the channel is paused")}. It goes when the channel resumes.`, wait: true };
  const waiting = by("waiting");
  if (waiting.length) {
    const names = waiting.map((x) => nameOf(x.typed));
    return { icon: "queue", text: `Waiting: ${list(names)} get${names.length === 1 ? "s" : ""} this when ${names.length === 1 ? "its" : "their"} current turn ends.`, wait: true };
  }
  const working = by("working");
  const notified = by("done").filter((x) => x.sessionId === null);
  if (notified.length) return { icon: "ok", text: `Posted. ${list(notified.map((x) => nameOf(x.typed)))} ${notified.length === 1 ? "was" : "were"} notified.`, wait: false };
  if (working.length) return { icon: "ok", text: `Posted. ${list(working.map((x) => nameOf(x.typed)))} ${working.length === 1 ? "is" : "are"} working on it.`, wait: false };
  if (m.mentions.length) return { icon: "ok", text: "Posted", wait: false };
  return { icon: "ok", text: "Posted. No agent was addressed, so none will act on it.", wait: false };
}

export interface MentionChip {
  kind: "done" | "run" | "wait" | "bad";
  /** Which state icon the chip draws. */
  state: "done" | "running" | "waiting";
  text: string;
}

/** One `@` of a message with where it stands, and the server's reason when it gave one (so a held mention reads right). */
export function mentionChip(m: Mention): MentionChip {
  const why = m.why ? `: ${m.why}` : "";
  switch (m.state) {
    case "done":
      return { kind: "done", state: "done", text: `${m.typed} done` };
    case "working":
      return { kind: "run", state: "running", text: `${m.typed} working` };
    case "waiting":
      return { kind: "wait", state: "waiting", text: `${m.typed} waiting${why}` };
    case "held":
      return { kind: "wait", state: "waiting", text: `${m.typed} held${why}` };
    case "dropped":
      return { kind: "bad", state: "waiting", text: `${m.typed} dropped${why}` };
    default:
      return { kind: "bad", state: "waiting", text: `${m.typed} not delivered${why}` };
  }
}

/** Where a Direct Message is, as an icon and words. `time` formats a time; the page passes the default. */
export function dmDelivery(m: DirectMessage, linkPaused: boolean, owner: string, time: (t: number) => string = hm): Delivery {
  const target = m.to[0];
  switch (m.state) {
    case "delivered":
      return { icon: "ok", text: `Delivered at ${time(m.stateAt)}${m.approved ? `, after ${owner} approved it` : ""}.`, wait: false };
    case "approval":
      return { icon: "clock", text: `Waiting for ${owner} to approve it, in My reporters or in a session on ${target?.machine ?? "its machine"}.`, wait: true };
    case "declined":
      return { icon: "no", text: `Declined at ${time(m.stateAt)}. It was not delivered.`, wait: false };
    case "dropped":
      return { icon: "no", text: `Dropped at ${time(m.stateAt)}: ${PEER_DROP_WORDS[m.why ?? ""] ?? m.why ?? "the server let it go"}. It was not delivered.`, wait: false };
    default:
      if (linkPaused) return { icon: "pause", text: `Held: ${owner} paused this link. It goes when the link resumes.`, wait: true };
      if (m.state === "handed") return { icon: "queue", text: `Handed to ${target?.machine ?? "its machine"}. Waiting for it to say ${target?.name ?? "the agent"} took it.`, wait: true };
      return { icon: "queue", text: `Waiting: ${list(m.to.map((t) => t.name))} ${m.to.length > 1 ? "are" : "is"} working. It gets this when its turn ends.`, wait: true };
  }
}

// ---- The box ------------------------------------------------------------------------------------------------------------

/** The word being typed after an `@` that starts a word, up to the caret: a name may hold spaces, so it runs to the line's end. */
export function mentionQuery(value: string, caret: number): { from: number; to: number; q: string } | null {
  const before = value.slice(0, caret);
  const m = /(^|\s)@([^\n]*)$/.exec(before);
  if (!m) return null;
  return { from: before.length - m[2]!.length - 1, to: caret, q: m[2]! };
}

/** The addresses that start with what is typed, in any case; the order the server gave stays. */
export function addressMatches(all: readonly Address[], q: string): Address[] {
  const want = q.toLowerCase();
  return all.filter((a) => a.typed.toLowerCase().startsWith(want));
}

export interface TextPart {
  kind: "text" | "mention" | "redacted";
  text: string;
}

const MENTION = /(@[A-Za-z0-9._-]+@[A-Za-z0-9._-]+(?:#[A-Za-z0-9_-]+)?|@group\b|@everyone\b)/;

/** A message's text as parts the page draws as text nodes: plain text, a mention, and Podium's own `[redacted]` marker. Never HTML. */
export function messageParts(text: string): TextPart[] {
  const out: TextPart[] = [];
  const bits = text.split("[redacted]");
  bits.forEach((bit, i) => {
    if (i > 0) out.push({ kind: "redacted", text: "[redacted]" });
    for (const seg of bit.split(MENTION)) {
      if (!seg) continue;
      out.push({ kind: seg.startsWith("@") && MENTION.test(seg) ? "mention" : "text", text: seg });
    }
  });
  return out;
}

// ---- Times --------------------------------------------------------------------------------------------------------------

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "13:52" for today, "Mon 13:52" for any other day, in local time. */
export function stamp(t: number, now: number): string {
  const d = new Date(t);
  const n = new Date(now);
  const same = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return same ? hm(t) : `${DAYS[d.getDay()]} ${hm(t)}`;
}
