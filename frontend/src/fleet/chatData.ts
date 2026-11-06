// Chat's data (#1034, mockup/podium-chat.html): the shapes the server's /respond/chat routes answer with, the calls, and
// the words and small rules the page uses, so each can be tested without drawing. Nothing here holds a token. The server
// sends a `chat` event that carries no text; the page reads again on it, and message text only ever comes from the routes.
import { call } from "./respondApi";
import { hm } from "./trafficData";
import { PEER_DROP_WORDS } from "../../../plugin/core/protocol";

export type AgentStatus = "running" | "waiting" | "done";

/** An Admin who is reading a thread now (#1034): since when, and until when it counts as live if the Admin reads no more. Server clock, epoch ms. */
export interface AdminReading {
  admin: string;
  since: number;
  until: number;
}

/** What an Admin did in a thread that stays in it as a record line. A record from a server that does not say is a read. */
export type AdminReadKind = "read" | "cleared" | "paused" | "resumed";
export interface AdminRead {
  admin: string;
  startedAt: number;
  lastSeenAt: number;
  kind?: AdminReadKind;
}

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
  /** The Admin who paused it, while an Admin's pause holds it; null or absent otherwise. */
  pausedByAdmin?: string | null;
  /** The Admins reading it now (My group only). Hide an entry once its `until` has passed. */
  adminReading?: AdminReading[];
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

/** Who a role is, for the words: the person who writes, the agent's owner, an Admin reading. */
export type CrossRole = "sender" | "owner" | "admin";

/**
 * A conversation between a person and another person's agent (#1034). `link` is where their link stands. `pausedBy` and `canResume`
 * come from the server (step 2c): a missing `pausedBy` is unknown, a missing `canResume` means the viewer may resume.
 */
export interface Cross {
  person: string;
  owner: string;
  link: "waiting" | "open" | "paused" | "removed" | "none";
  viewerIs: CrossRole;
  pausedBy?: CrossRole | null;
  /** The Admin's name while `pausedBy` is `admin`. */
  pausedByAdmin?: string | null;
  canResume?: boolean;
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
  /** Who paused the link, and the Admin's name when it was an Admin. */
  pausedBy?: CrossRole | null;
  pausedByAdmin?: string | null;
  adminReading?: AdminReading[];
  canSend: { aToB: boolean; bToA: boolean };
  roundTrips: { used: number; cap: number };
  /** The names of agents that left while others did not. */
  ended: string[];
  unread: number;
  mentions: number;
  hiddenAt: number | null;
  /** Set for a conversation with another person's agent; null or absent for any other. */
  cross?: Cross | null;
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
  /** How many messages from other people wait for the viewer's approval as the owner of the agent they wrote to. */
  approvals?: number;
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
  /** The reason in words for a message that was declined or dropped. */
  reason?: string | null;
  /** The owner a person's message waits for while it waits for approval. */
  waitingFor?: string | null;
  approved: boolean;
}

export interface ChannelPageRead {
  ok: true;
  channel: "general" | "group";
  messages: ChannelMessage[];
  older: string | null;
  total: number;
  /** Who read this thread (My group only), oldest first. */
  adminReads?: AdminRead[];
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
  cross?: Cross | null;
  pausedBy?: CrossRole | null;
  pausedByAdmin?: string | null;
  adminReads?: AdminRead[];
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
const qs = (o: { before?: string | null; limit?: number; owner?: string | null }) => {
  const q = new URLSearchParams();
  if (o.owner) q.set("owner", o.owner);
  if (o.before) q.set("before", o.before);
  q.set("limit", String(o.limit ?? PAGE_SIZE));
  return `?${q}`;
};

export const chatApi = {
  /** An Admin names the person whose conversations to read with `owner`; the server answers that person's My group and Direct Messages. */
  overview: (owner?: string | null) => call<ChatOverview>("GET", owner ? `${BASE}?owner=${enc(owner)}` : BASE),
  markRead: (thread: string, upTo: string | null) => call<{ ok: true; unread: number; mentions: number }>("POST", `${BASE}/read`, { thread, upTo }),
  addresses: (channel: "general" | "group") => call<{ ok: true; addresses: Address[] }>("GET", `${BASE}/addresses?channel=${channel}`),
  channelMessages: (channel: string, o: { before?: string | null; limit?: number; owner?: string | null } = {}) => call<ChannelPageRead>("GET", `${BASE}/channels/${enc(channel)}/messages${qs(o)}`),
  post: (channel: string, text: string) => call<{ ok: true; message: ChannelMessage; warnings: string[] }>("POST", `${BASE}/channels/${enc(channel)}/messages`, { text }),
  pause: (channel: string, paused: boolean, everyone = false, owner?: string | null) => call<{ ok: true }>("PUT", `${BASE}/channels/${enc(channel)}/pause`, { paused, ...(everyone ? { everyone: true } : {}), ...(owner ? { owner } : {}) }),
  disconnect: (channel: string, disconnected: boolean, owner?: string | null) => call<{ ok: true }>("PUT", `${BASE}/channels/${enc(channel)}/disconnect`, { disconnected, ...(owner ? { owner } : {}) }),
  clear: (channel: string, owner?: string | null) => call<{ ok: true }>("DELETE", `${BASE}/channels/${enc(channel)}/messages`, owner ? { owner } : {}),
  /** An Admin's open thread says it is still being read, so its people keep seeing it. The group names its person; a Direct Message does not need to. */
  readingChannel: (channel: string, owner: string) => call<{ ok: true }>("POST", `${BASE}/channels/${enc(channel)}/reading`, { owner }),
  readingDm: (a: string, b: string, owner: string) => call<{ ok: true }>("POST", `${BASE}/dm/${enc(a)}/${enc(b)}/reading`, { owner }),
  dmMessages: (a: string, b: string, o: { before?: string | null; limit?: number } = {}) => call<DirectPageRead>("GET", `${BASE}/dm/${enc(a)}/${enc(b)}/messages${qs(o)}`),
  sendDm: (a: string, b: string, text: string) => call<{ ok: true; message: DirectMessage; skipped: { name: string; why: string }[]; errors: { name: string; error: string }[] }>("POST", `${BASE}/dm/${enc(a)}/${enc(b)}/messages`, { text }),
  deleteDm: (a: string, b: string) => call<{ ok: true; removed: number }>("DELETE", `${BASE}/dm/${enc(a)}/${enc(b)}`),
  /** A Direct Message's Pause link and Remove link, which were Traffic's: the same routes, by the two reporters' keys. */
  pauseLink: (a: string, b: string, paused: boolean) => call<{ ok: true }>("PUT", "/api/fleet/respond/peers/links", { a, b, paused }),
  removeLink: (a: string, b: string) => call<{ ok: true }>("DELETE", "/api/fleet/respond/peers/links", { a, b }),
  /** Pause, resume, remove or open again the link of a conversation across owners (the two ids of the conversation, `person:<name>` included). */
  link: (a: string, b: string, op: LinkOp) => call<{ ok: true; link: Cross["link"] }>("PUT", `${BASE}/dm/${enc(a)}/${enc(b)}/link`, { op }),
};

export type LinkOp = "pause" | "resume" | "remove" | "allow";

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

/** A conversation between the person and one agent is named by the agent; one between two agents by both; one across owners by the other person first. */
export function dmName(d: Pick<DirectInfo, "a" | "b"> & { cross?: Cross | null }): string {
  const agents = [d.a, d.b].filter((p) => p.kind === "agent");
  // Across owners the other person is named first, so the row says whose conversation it is.
  return [...(d.cross ? [d.cross.person] : []), ...agents.map((p) => p.name)].join(", ");
}

/** A conversation between two agents has a link to pause and remove; the person's own with one agent has none. */
export const hasLink = (d: Pick<DirectInfo, "a" | "b">): boolean => d.a.kind === "agent" && d.b.kind === "agent";

/** The line under a Direct Message's name: who is in it, from the viewer's side. */
export function dmSub(d: Pick<DirectInfo, "a" | "b"> & { cross?: Cross | null; owner?: string }, readOnly = false): string {
  const c = d.cross;
  // An Admin reading a person's conversation sees it from the owner's side.
  if (readOnly) return `${c ? `${c.person} and ${c.owner}'s agent` : hasLink(d) ? `Two agents, and ${d.owner}` : `${d.owner} and one agent`}, read only`;
  if (!c) return hasLink(d) ? "Two agents, and you" : "You and one agent";
  if (c.viewerIs === "sender") return `You and ${c.owner}'s agent`;
  return `${c.person} and ${c.viewerIs === "owner" ? "your" : `${c.owner}'s`} agent`;
}

export type TagIcon = "pause" | "clock" | "trash";
export interface Tag {
  icon: TagIcon;
  text: string;
  warn?: boolean;
}

const joinNames = (names: string[]) => names.join(" and ");

export function channelTag(c: Pick<ChatChannel, "paused" | "pausedForEveryone" | "disconnected" | "pausedByAdmin">): Tag | null {
  if (c.disconnected) return { icon: "pause", text: "Your agents are disconnected" };
  // A pause an Admin made has its own red tag.
  if (c.paused && !c.pausedForEveryone && c.pausedByAdmin) return null;
  if (c.paused) return { icon: "pause", text: c.pausedForEveryone ? "Paused for everyone" : "Paused", warn: true };
  return null;
}

export function dmTag(d: Pick<DirectInfo, "a" | "b" | "state" | "paused" | "canSend" | "ended"> & { cross?: Cross | null; pausedBy?: CrossRole | null; pausedByAdmin?: string | null }): Tag | null {
  if (d.cross) {
    if (d.cross.link === "removed") return { icon: "trash", text: "Link removed" };
    if (d.ended.length) return { icon: "pause", text: `${joinNames(d.ended)} ended` };
    if (adminPauseOf(d)) return null;
    if (d.cross.link === "paused") return { icon: "pause", text: "Paused" };
    if (d.cross.link === "waiting") return { icon: "clock", text: "Waiting for approval", warn: true };
    return null;
  }
  if (hasLink(d) && !d.canSend.aToB && !d.canSend.bToA && d.state === "active") return { icon: "trash", text: "Link removed" };
  if (d.ended.length) return { icon: "pause", text: `${joinNames(d.ended)} ended` };
  if (d.state === "waiting") return { icon: "clock", text: "Waiting for approval", warn: true };
  if (adminPauseOf(d)) return null;
  if (d.state === "paused" || d.paused) return { icon: "pause", text: "Paused" };
  return null;
}

// ---- Conversations across owners -------------------------------------------------------------------------------------------

/** A role as the words name it: the person, the owner, or an Admin. */
export const whoWord = (c: Pick<Cross, "person" | "owner"> & { pausedByAdmin?: string | null }, who: CrossRole): string => (who === "sender" ? c.person : who === "owner" ? c.owner : adminWho(c.pausedByAdmin));

/** The header line: who the two people are, and who may read. */
export const crossLine = (c: Cross, agent: string): string => `${c.person} (a person using Chat) writes to ${c.owner}'s agent ${agent}. Only ${c.person}, ${c.owner} and an Admin can read this.`;

/** Why the message box is off in a conversation across owners, with the one word for its placeholder; null when the viewer may write. */
export function crossOff(c: Cross): { word: string; why: string } | null {
  const mayWrite = c.viewerIs === "sender";
  if (c.link === "removed") return { word: "Link removed", why: `The link was removed, so nothing can be sent. ${mayWrite ? `Only ${c.owner} can open it again.` : "Choose Allow again in the menu to open it."}` };
  if (c.link === "paused") {
    const by = c.pausedBy ? whoWord(c, c.pausedBy) : null;
    const rest = c.canResume === false && by ? `Only ${c.pausedBy === "admin" ? "an Admin" : by} can resume it.` : "Resume the link from the menu to send.";
    return { word: "Paused", why: `Paused${by ? ` by ${by}` : ""}: messages are held. ${rest}` };
  }
  if (!mayWrite) return { word: "Read only", why: `Only ${c.person} writes in this conversation. ${c.viewerIs === "owner" ? "You" : "An Admin"} can pause or remove its link from the menu.` };
  return null;
}

/** What the box says under it while a person's message waits for the owner. */
export const crossNote = (c: Cross): string | null => (c.viewerIs === "sender" && c.link === "waiting" ? `Waiting for ${c.owner} to approve your message. It is delivered once ${c.owner} allows it.` : null);

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

/** One `@` of a message with where it stands, by the state word only: the reason is on the message's delivery line, so it is not said twice. */
export function mentionChip(m: Mention): MentionChip {
  switch (m.state) {
    case "done":
      return { kind: "done", state: "done", text: `${m.typed} done` };
    case "working":
      return { kind: "run", state: "running", text: `${m.typed} working` };
    case "waiting":
      return { kind: "wait", state: "waiting", text: `${m.typed} waiting` };
    case "held":
      return { kind: "wait", state: "waiting", text: `${m.typed} held` };
    case "dropped":
      return { kind: "bad", state: "waiting", text: `${m.typed} dropped` };
    default:
      return { kind: "bad", state: "waiting", text: `${m.typed} not delivered` };
  }
}

/** Where a Direct Message is, as an icon and words. `time` formats a time; the page passes the default. */
export function dmDelivery(m: DirectMessage, linkPaused: boolean, owner: string, time: (t: number) => string = hm, across = false, heldBy?: string): Delivery {
  const target = m.to[0];
  switch (m.state) {
    case "delivered":
      return { icon: "ok", text: `Delivered at ${time(m.stateAt)}${m.approved ? `, after ${owner} approved it` : ""}.`, wait: false };
    case "approval":
      if (across) return { icon: "clock", text: `Waiting for ${m.waitingFor ?? owner} to approve it.`, wait: true };
      return { icon: "clock", text: `Waiting for ${owner} to approve it, in My reporters or in a session on ${target?.machine ?? "its machine"}.`, wait: true };
    case "declined":
      return { icon: "no", text: `Declined at ${time(m.stateAt)}${m.reason ? `: ${plain(m.reason)}` : ""}. It was not delivered.`, wait: false };
    case "dropped":
      return { icon: "no", text: `Dropped at ${time(m.stateAt)}: ${m.reason ? plain(m.reason) : (PEER_DROP_WORDS[m.why ?? ""] ?? m.why ?? "the server let it go")}. It was not delivered.`, wait: false };
    default:
      if (linkPaused) return { icon: "pause", text: `Held: ${heldBy ?? owner} paused this link. It goes when the link resumes.`, wait: true };
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

// ---- An Admin reading (#1034) ---------------------------------------------------------------------------------------------------

/** An Admin as the words name them: with the name when it is known. */
export const adminWho = (name: string | null | undefined): string => (name ? `${name} (an Admin)` : "an Admin");

/** The readings still live by the server's clock; the page does not wait for the server to say one ended. */
export const liveReaders = (l: readonly AdminReading[] | undefined, serverNow: number): AdminReading[] => (l ?? []).filter((r) => r.until > serverNow);

const more = (n: number) => `${n} more Admin${n === 1 ? "" : "s"}`;

/** The banner's bold line: the first two Admins by name, the rest counted. */
export function readersLine(l: readonly AdminReading[]): string {
  const names = l.map((r) => r.admin);
  if (names.length <= 1) return `${adminWho(names[0])} is reading this conversation.`;
  if (names.length === 2) return `${names[0]} and ${names[1]} (Admins) are reading this conversation.`;
  return `${names[0]}, ${names[1]} and ${more(names.length - 2)} are reading this conversation.`;
}

/** Who has to stop for the notice to clear. */
export const readersStops = (l: readonly AdminReading[]): string => (l.length === 1 ? `${l[0]!.admin} stops` : "the last of them stops");

/** The tip's text: every Admin reading, with when they started. `at` formats a time. */
export const readersTip = (l: readonly AdminReading[], at: (t: number) => string): string => `Reading now: ${l.map((r) => `${r.admin} since ${at(r.since)}`).join(", ")}.`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "Nov 6 at 14:20", in local time. */
export function onDay(t: number): string {
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} at ${hm(t)}`;
}

/** The quiet line an Admin's visit leaves among the messages. */
export function recordLine(r: AdminRead): string {
  const what = r.kind === "cleared" ? "removed all messages" : r.kind === "paused" ? "paused this link" : r.kind === "resumed" ? "resumed this link" : "read this conversation";
  return `${adminWho(r.admin)} ${what} on ${onDay(r.startedAt)}.`;
}

/** The Admin who holds a pause on a channel, plain Direct Message or conversation across owners; null when no Admin does. */
export function adminPauseOf(x: { paused?: boolean; pausedByAdmin?: string | null; pausedBy?: CrossRole | null; state?: string; cross?: Cross | null }): { name: string | null } | null {
  if (x.cross) return x.cross.link === "paused" && x.cross.pausedBy === "admin" ? { name: x.cross.pausedByAdmin ?? null } : null;
  if (!(x.paused || x.state === "paused")) return null;
  if (x.pausedBy !== undefined && x.pausedBy !== "admin") return null;
  return x.pausedByAdmin || x.pausedBy === "admin" ? { name: x.pausedByAdmin ?? null } : null;
}
