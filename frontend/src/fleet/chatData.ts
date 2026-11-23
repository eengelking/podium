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
export type AdminReadKind =
  | "read"
  | "cleared"
  | "paused"
  | "resumed"
  | "disconnected"
  | "reconnected"
  | "recording_stopped"
  | "recording_deleted"
  | "activity_deleted"
  | "session_deleted"
  | "access_revoked"
  | "person_deleted"
  | "reporter_removed"
  | "respond_refused"
  | "links_paused"
  | "links_resumed"
  | "link_removed"
  | "channel_edited"
  | "channel_removed";
export interface AdminRead {
  admin: string;
  startedAt: number;
  lastSeenAt: number;
  kind?: AdminReadKind;
}

/** A channel as the overview lists it. `can` says what the viewer may do to it; the page offers nothing else. */
export interface ChatChannel {
  /** `general`, `group`, or a public channel's own name (#1035). */
  id: string;
  /** `public` for General and a channel someone opened, `group` for My group. */
  kind: "public" | "group";
  name: string;
  /** What a public channel is for; empty for General and My group. */
  description: string;
  /** What a public channel is about, or null. */
  link: ChannelLink | null;
  /** The person who opened a public channel; null for General, My group and a channel nobody opened. */
  openedBy: string | null;
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
  can: {
    pause: boolean;
    pauseEveryone: boolean;
    disconnect: boolean;
    removeAll: boolean;
    editDescription: boolean;
    removeChannel: boolean;
  };
}

export type ChannelLinkKind = "issue" | "milestone" | "project";
export interface ChannelLink {
  kind: ChannelLinkKind;
  ref: string;
}

/** The most public channels besides General the server keeps (#1035); at it, New channel is off. */
export const MAX_PUBLIC_CHANNELS = 50;

/** People and agents are listed this many to a page (#1272). Fixed, not a setting. */
export const PEOPLE_PER_PAGE = 10;

/** One row of People and agents, with what it is sorted by. */
export interface PeopleEntry {
  key: string;
  name: string;
  /** A running agent, or anyone this person has unread messages or mentions from. */
  needs: boolean;
  /** The last message with this person or agent, 0 when there is no conversation. */
  last: number;
}

/**
 * What a person or an agent sorts by in People and agents (#1272): whether they need this person (unread messages or mentions in a Direct Message with them,
 * or a running agent) and the time of the last message in a Direct Message with them. `match` says whether a Direct Message's party is this one.
 */
export function peopleSort(directs: readonly DirectInfo[], match: (p: Party) => boolean, running: boolean): Pick<PeopleEntry, "needs" | "last"> {
  let last = 0;
  let unread = 0;
  for (const d of directs) {
    if (!match(d.a) && !match(d.b)) continue;
    last = Math.max(last, d.lastAt);
    unread += d.unread + d.mentions;
  }
  return { needs: running || unread > 0, last };
}

/** Rows that need the person first, then the newest last message, then the name. Returns a new array. */
export function orderPeople<T extends PeopleEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((x, y) => Number(y.needs) - Number(x.needs) || y.last - x.last || x.name.localeCompare(y.name));
}

/** One agent the New direct message picker offers (#1035). Names, owners and states only. */
export interface DirectTarget {
  sessionId: string;
  name: string;
  machine: string;
  address: string;
  owner: string;
  own: boolean;
  status: AgentStatus;
  waitReason: "permission" | "input" | null;
  canMessage: boolean;
  why: string | null;
  needsApproval: boolean;
  link: "none" | "open" | "paused" | "removed" | null;
  thread: string;
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
  /** The name the server records an Admin's pause, reading or stop under; absent from an older server. */
  me: { name: string; actor?: string; admin: boolean; person: boolean; /** The viewer's person id, the one that decides which messages are theirs (a name can change hands). Null for the admin secret; absent from an older server. */ id?: number | null };
  settings: {
    maxChars: number;
    perMinute: number;
    retainDays: number;
    graceHours: number;
    everyone: boolean;
  };
  channels: ChatChannel[];
  directs: DirectInfo[];
  /** The viewer's conversations of people and agents (#1278). Absent from an older server. */
  conversations?: ConversationInfo[];
  agents: ChatAgent[];
  people: { name: string; you: boolean }[];
  /** How many messages from other people wait for the viewer's approval as the owner of the agent they wrote to. */
  approvals?: number;
  /** The Admins looking at this person's list of conversations now (#1051). Absent from an older server and for an Admin who browses. */
  listReading?: AdminReading[];
  /** The latest records of an Admin looking at the list, oldest first. */
  listReads?: AdminRead[];
  /** The person's unseen records of a conversation that has since been deleted, newest first (#1051). Sent once: the server marks them seen. */
  goneReads?: GoneRead[];
}

/** One member of a conversation of people and agents (#1278), as the overview lists it. `you` is the viewer's own place. */
interface ConversationMemberInfo {
  kind: "person" | "agent";
  name: string;
  you: boolean;
  addedBy: string | null;
  /** An agent that ended for good (#1283): it can no longer send or be sent to. Absent for a person and for an agent that has not. */
  ended?: boolean;
  /** What an @ types to address them in this conversation (#1282): `name@console`, `name@machine`, or null for an agent that has ended. */
  address: string | null;
  /** An agent's session id, for its state in the @ list; null for a person. */
  sessionId: string | null;
}

/** Who a message of a conversation went to or named, and what became of it for an agent (#1282). */
export interface ConversationDelivery {
  kind: "person" | "agent";
  name: string;
  /** True for a member the writer addressed with an @; false for one that took a message sent to everyone. */
  named: boolean;
  /** An agent's state; null for a person. */
  state: "queued" | "delivered" | "dropped" | null;
}

/** A conversation of two or more people and agents (#1278, DECISIONS 74): names, counts and times, never any text. */
export interface ConversationInfo {
  id: string;
  thread: string;
  members: ConversationMemberInfo[];
  /** An agent is in it now, so an Admin may read it (and everyone in it is told when one does). */
  hasAgent: boolean;
  unread: number;
  mentions: number;
  messages: number;
  lastAt: number;
  adminReading: AdminReading[];
}

/** One message of a conversation as a page reads it. */
export interface ConversationMessage {
  id: string;
  author: { kind: "person" | "agent"; name: string; you: boolean };
  text: string;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  replyTo: string | null;
  canChange: boolean;
  changeWhy: string | null;
  /** Who it went to or named (#1282); empty for a message with no agent to hand it to and for one written before this was kept. */
  deliveries: ConversationDelivery[];
}

export interface ConversationPageRead {
  ok: true;
  conversation: ConversationInfo;
  messages: ConversationMessage[];
  older: string | null;
  total: number;
  adminReads: AdminRead[];
}

/** Who a new conversation is with: a person by name, or one of the viewer's own agents by session id. */
export type ConversationMemberInput = { kind: "person"; name: string } | { kind: "agent"; sessionId: string };

/** The names the conversation lists give its members, the viewer left out and the other people first (as a direct message does). */
export function conversationName(c: Pick<ConversationInfo, "members">): string {
  const others = c.members.filter((m) => !m.you);
  const list = (others.length ? others : c.members).slice().sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "person" ? -1 : 1));
  return list.map((m) => m.name).join(", ");
}

/** The line under a conversation's name in the list. */
export function conversationSub(c: Pick<ConversationInfo, "members">): string {
  const others = c.members.filter((m) => !m.you);
  const people = others.filter((m) => m.kind === "person").length;
  const agents = others.filter((m) => m.kind === "agent").length;
  if (people === 1 && agents === 0) return "Direct message";
  if (people === 0 && agents === 1) return "You and one agent";
  const parts = [people ? `${people} ${people === 1 ? "person" : "people"}` : "", agents ? `${agents} ${agents === 1 ? "agent" : "agents"}` : ""].filter(Boolean);
  return `You and ${parts.join(" and ")}`;
}

/** An Admin record of a conversation that no longer exists, for the person's overview. Never any text. */
export interface GoneRead {
  admin: string;
  startedAt: number;
  kind: AdminReadKind;
  /** The other party's name. */
  with: string;
}

type MentionState =
  "waiting" | "working" | "done" | "not-delivered" | "held" | "dropped";

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
  /** For an agent's message in a public channel, the person who owns the agent; null for a person's message or an agent whose session is gone. */
  authorOwner?: string | null;
  mine: boolean;
  mentions: Mention[];
  /** When the author last changed the text (#1269); null for a message never edited. Absent from a server older than #1269. */
  editedAt?: number | null;
  /** When the author deleted it (#1269). A deleted message keeps its row and has no text and no mentions. */
  deletedAt?: number | null;
  /** Whether the viewer, who must be its author, may edit or delete it now. */
  canChange?: boolean;
  /** In words, why the author cannot change it now; null otherwise. */
  changeWhy?: string | null;
}

type DirectState =
  | "approval"
  | "ready"
  | "handed"
  | "queued"
  | "delivered"
  | "declined"
  | "dropped";

export interface DirectMessage {
  id: string;
  author: "agent" | "person";
  from: {
    kind: "agent" | "person";
    sessionId: string | null;
    /** For a person's message, the author's person id (display uses `name`; ownership uses this). Null for an agent, and for a message whose author is gone. */
    personId?: number | null;
    name: string;
    machine: string;
  };
  to: {
    sessionId: string;
    name: string;
    machine: string;
    state: DirectState;
    why: string | null;
  }[];
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
  /** When the author last changed the text (#1269); null for a message never edited. Absent from a server older than #1269. */
  editedAt?: number | null;
  /** When the author deleted it (#1269). A deleted message keeps its row and has no text. */
  deletedAt?: number | null;
  /** Whether the viewer, who must be its author, may edit or delete it now. */
  canChange?: boolean;
  /** In words, why the author cannot change it now; null otherwise. */
  changeWhy?: string | null;
}

export interface ChannelPageRead {
  ok: true;
  channel: string;
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
const qs = (o: {
  before?: string | null;
  limit?: number;
  owner?: string | null;
}) => {
  const q = new URLSearchParams();
  if (o.owner) q.set("owner", o.owner);
  if (o.before) q.set("before", o.before);
  q.set("limit", String(o.limit ?? PAGE_SIZE));
  return `?${q}`;
};

/** A Direct Message that was concluded and deleted because an agent in it ended (#1283): who ended, who it was with, and when. Never any text. */
export interface Concluded {
  id: string;
  thread: string;
  agent: string;
  with: string[];
  at: number;
  /** The agent was cleared with `/clear` and goes on under a new session, so it did not end (#1340). Absent otherwise. */
  cleared?: true;
  /** How many messages the person wrote that the agent never took, one still waiting for its owner's approval among them (#1283). Absent when none. */
  undelivered?: number;
}

/** The sentence that says a person's messages were not delivered when the agent ended; empty when none was waiting. */
export function undeliveredWords(n: number | undefined): string {
  if (!n) return "";
  return n === 1 ? " A message you wrote to it was not delivered." : ` ${n} messages you wrote to it were not delivered.`;
}

export const chatApi = {
  /** What was concluded for the signed-in person and not yet dismissed (#1283). */
  concluded: () => call<{ ok: true; concluded: Concluded[] }>("GET", `${BASE}/concluded`),
  dismissConcluded: (id: string) => call<{ ok: true }>("DELETE", `${BASE}/concluded/${enc(id)}`),
  /** An Admin names the person whose conversations to read with `owner`; the server answers that person's My group and Direct Messages. */
  overview: (owner?: string | null) =>
    call<ChatOverview>("GET", owner ? `${BASE}?owner=${enc(owner)}` : BASE),
  markRead: (thread: string, upTo: string | null) =>
    call<{ ok: true; unread: number; mentions: number }>(
      "POST",
      `${BASE}/read`,
      { thread, upTo },
    ),
  addresses: (channel: string) =>
    call<{ ok: true; addresses: Address[] }>(
      "GET",
      `${BASE}/addresses?channel=${channel}`,
    ),
  channelMessages: (
    channel: string,
    o: { before?: string | null; limit?: number; owner?: string | null } = {},
  ) =>
    call<ChannelPageRead>(
      "GET",
      `${BASE}/channels/${enc(channel)}/messages${qs(o)}`,
    ),
  post: (channel: string, text: string) =>
    call<{ ok: true; message: ChannelMessage; warnings: string[] }>(
      "POST",
      `${BASE}/channels/${enc(channel)}/messages`,
      { text },
    ),
  pause: (
    channel: string,
    paused: boolean,
    everyone = false,
    owner?: string | null,
  ) =>
    call<{ ok: true }>("PUT", `${BASE}/channels/${enc(channel)}/pause`, {
      paused,
      ...(everyone ? { everyone: true } : {}),
      ...(owner ? { owner } : {}),
    }),
  disconnect: (channel: string, disconnected: boolean, owner?: string | null) =>
    call<{ ok: true }>("PUT", `${BASE}/channels/${enc(channel)}/disconnect`, {
      disconnected,
      ...(owner ? { owner } : {}),
    }),
  clear: (channel: string, owner?: string | null) =>
    call<{ ok: true }>(
      "DELETE",
      `${BASE}/channels/${enc(channel)}/messages`,
      owner ? { owner } : {},
    ),
  /** An Admin's open thread says it is still being read, so its people keep seeing it. The group names its person; a Direct Message does not need to. */
  readingChannel: (channel: string, owner: string) =>
    call<{ ok: true }>("POST", `${BASE}/channels/${enc(channel)}/reading`, {
      owner,
    }),
  readingDm: (a: string, b: string, owner: string) =>
    call<{ ok: true }>("POST", `${BASE}/dm/${enc(a)}/${enc(b)}/reading`, {
      owner,
    }),
  dmMessages: (
    a: string,
    b: string,
    o: { before?: string | null; limit?: number } = {},
  ) =>
    call<DirectPageRead>(
      "GET",
      `${BASE}/dm/${enc(a)}/${enc(b)}/messages${qs(o)}`,
    ),
  sendDm: (a: string, b: string, text: string) =>
    call<{
      ok: true;
      message: DirectMessage;
      skipped: { name: string; why: string }[];
      errors: { name: string; error: string }[];
    }>("POST", `${BASE}/dm/${enc(a)}/${enc(b)}/messages`, { text }),
  deleteDm: (a: string, b: string) =>
    call<{ ok: true; removed: number }>(
      "DELETE",
      `${BASE}/dm/${enc(a)}/${enc(b)}`,
    ),
  /** Edits or deletes the viewer's own message (#1269). A refusal is a RespondError whose `message` is the server's words and whose body has its `reason` (`locked`, `deleted` or `approval` for a 409). The answer is the message as it now stands, to replace the row by its id. */
  editChannelMessage: (channel: string, id: string, text: string) =>
    call<{ ok: true; message: ChannelMessage }>(
      "PATCH",
      `${BASE}/channels/${enc(channel)}/messages/${enc(id)}`,
      { text },
    ),
  deleteChannelMessage: (channel: string, id: string) =>
    call<{ ok: true; message: ChannelMessage }>(
      "DELETE",
      `${BASE}/channels/${enc(channel)}/messages/${enc(id)}`,
    ),
  editDmMessage: (a: string, b: string, id: string, text: string) =>
    call<{ ok: true; message: DirectMessage }>(
      "PATCH",
      `${BASE}/dm/${enc(a)}/${enc(b)}/messages/${enc(id)}`,
      { text },
    ),
  deleteDmMessage: (a: string, b: string, id: string) =>
    call<{ ok: true; message: DirectMessage }>(
      "DELETE",
      `${BASE}/dm/${enc(a)}/${enc(b)}/messages/${enc(id)}`,
    ),
  /** A Direct Message's Pause link and Remove link, which were Traffic's: the same routes, by the two reporters' keys. */
  pauseLink: (a: string, b: string, paused: boolean) =>
    call<{ ok: true }>("PUT", "/api/fleet/respond/peers/links", {
      a,
      b,
      paused,
    }),
  removeLink: (a: string, b: string) =>
    call<{ ok: true }>("DELETE", "/api/fleet/respond/peers/links", { a, b }),
  /** Pause, resume, remove or open again the link of a conversation across owners (the two ids of the conversation, `person:<name>` included). */
  /** Opens a public channel (#1035). A refusal is a RespondError whose body has the server's `error` and its `reason`. */
  createChannel: (
    name: string,
    description: string,
    link: ChannelLink | null,
  ) =>
    call<{ ok: true; channel: ChatChannel }>("POST", `${BASE}/channels`, {
      name,
      description,
      link,
    }),
  describeChannel: (channel: string, description: string) =>
    call<{ ok: true; channel: ChatChannel }>(
      "PATCH",
      `${BASE}/channels/${enc(channel)}`,
      { description },
    ),
  removeChannel: (channel: string) =>
    call<{ ok: true; removed: number }>(
      "DELETE",
      `${BASE}/channels/${enc(channel)}`,
    ),
  /** Who the person may start a Direct Message with, narrowed by `q` (the search box asks as it is typed). */
  directTargets: (q = "") =>
    call<{ ok: true; targets: DirectTarget[] }>(
      "GET",
      `${BASE}/direct-targets${q ? `?q=${enc(q)}` : ""}`,
    ),
  /** Everyone who can sign in, running or not, narrowed by `q`; `conversation` is the one that already holds exactly the viewer and that person (#1278). */
  chatPeople: (q = "") =>
    call<{ ok: true; people: { name: string; conversation: string | null }[] }>(
      "GET",
      `${BASE}/people${q ? `?q=${enc(q)}` : ""}`,
    ),
  /** Opens the conversation of these members and the viewer, or answers the one that exists, and sends `text` when there is one. */
  openConversation: (members: ConversationMemberInput[], text?: string) =>
    call<{ ok: true; created: boolean; conversation: ConversationInfo; message?: ConversationMessage; skipped: string[] }>(
      "POST",
      `${BASE}/conversations`,
      text === undefined ? { members } : { members, text },
    ),
  conversationMessages: (id: string, o: { before?: string | null; limit?: number } = {}) =>
    call<ConversationPageRead>("GET", `${BASE}/conversations/${enc(id)}/messages${qs(o)}`),
  sendConversation: (id: string, text: string) =>
    call<{ ok: true; message: ConversationMessage; skipped: string[] }>("POST", `${BASE}/conversations/${enc(id)}/messages`, { text }),
  editConversationMessage: (id: string, messageId: string, text: string) =>
    call<{ ok: true; message: ConversationMessage }>("PATCH", `${BASE}/conversations/${enc(id)}/messages/${enc(messageId)}`, { text }),
  deleteConversationMessage: (id: string, messageId: string) =>
    call<{ ok: true; message: ConversationMessage }>("DELETE", `${BASE}/conversations/${enc(id)}/messages/${enc(messageId)}`),
  addConversationMembers: (id: string, members: ConversationMemberInput[]) =>
    call<{ ok: true; conversation: ConversationInfo }>("POST", `${BASE}/conversations/${enc(id)}/members`, { members }),
  leaveConversation: (id: string) => call<{ ok: true; deleted: boolean }>("DELETE", `${BASE}/conversations/${enc(id)}/members/me`),
  readingConversation: (id: string) => call<{ ok: true }>("POST", `${BASE}/conversations/${enc(id)}/reading`),
  link: (a: string, b: string, op: LinkOp) =>
    call<{ ok: true; link: Cross["link"] }>(
      "PUT",
      `${BASE}/dm/${enc(a)}/${enc(b)}/link`,
      { op },
    ),
};

export type LinkOp = "pause" | "resume" | "remove" | "allow";

export type ChatApi = typeof chatApi;

/** A server reason without its closing full stop, so a sentence built around it does not end in two. */
export const plain = (s: string): string => {
  let end = s.length;
  while (end > 0 && (s[end - 1] === "." || /\s/.test(s[end - 1]!))) end--;
  return s.slice(0, end);
};

// ---- Direct Messages ---------------------------------------------------------------------------------------------------

/**
 * A conversation's row key: the server's own `thread` value (dm:<a>|<b>). The ends alone are not enough, because the person's own
 * conversation with an agent and another person's with the same agent share the agent (#1051).
 */
export function dmKey(d: Pick<DirectInfo, "thread">): string {
  return d.thread;
}

/** The viewer's own conversation with one agent (no other person in it), or undefined: a new message to that agent opens it. */
export function ownDmWith(
  directs: readonly DirectInfo[],
  sessionId: string,
): DirectInfo | undefined {
  return directs.find(
    (d) =>
      !d.cross &&
      d.a.kind !== d.b.kind &&
      [d.a, d.b].some((p) => p.kind === "agent" && p.sessionId === sessionId),
  );
}

/** A conversation between the person and one agent is named by the agent; one between two agents by both; one across owners by the other person first. */
export function dmName(
  d: Pick<DirectInfo, "a" | "b"> & { cross?: Cross | null },
): string {
  const agents = [d.a, d.b].filter((p) => p.kind === "agent");
  // Across owners the other person is named first, so the row says whose conversation it is.
  return [
    ...(d.cross ? [d.cross.person] : []),
    ...agents.map((p) => p.name),
  ].join(", ");
}

/** A conversation between two agents has a link to pause and remove; the person's own with one agent has none. */
export const hasLink = (d: Pick<DirectInfo, "a" | "b">): boolean =>
  d.a.kind === "agent" && d.b.kind === "agent";

/** The line under a Direct Message's name: who is in it, from the viewer's side. */
export function dmSub(
  d: Pick<DirectInfo, "a" | "b"> & { cross?: Cross | null; owner?: string },
  readOnly = false,
): string {
  const c = d.cross;
  // An Admin reading a person's conversation sees it from the owner's side.
  if (readOnly)
    return `${c ? `${c.person} and ${c.owner}'s agent` : hasLink(d) ? `Two agents, and ${d.owner}` : `${d.owner} and one agent`}, read only`;
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

export function channelTag(
  c: Pick<
    ChatChannel,
    "paused" | "pausedForEveryone" | "disconnected" | "pausedByAdmin"
  >,
): Tag | null {
  if (c.disconnected)
    return { icon: "pause", text: "Your agents are disconnected" };
  // A pause an Admin made has its own red tag.
  if (c.paused && !c.pausedForEveryone && c.pausedByAdmin) return null;
  if (c.paused)
    return {
      icon: "pause",
      text: c.pausedForEveryone ? "Paused for everyone" : "Paused",
      warn: true,
    };
  return null;
}

export function dmTag(
  d: Pick<DirectInfo, "a" | "b" | "state" | "paused" | "canSend" | "ended"> & {
    cross?: Cross | null;
    pausedBy?: CrossRole | null;
    pausedByAdmin?: string | null;
  },
): Tag | null {
  if (d.cross) {
    if (d.cross.link === "removed")
      return { icon: "trash", text: "Link removed" };
    if (d.ended.length)
      return { icon: "pause", text: `${joinNames(d.ended)} ended` };
    if (adminPauseOf(d)) return null;
    if (d.cross.link === "paused") return { icon: "pause", text: "Paused" };
    if (d.cross.link === "waiting")
      return { icon: "clock", text: "Waiting for approval", warn: true };
    return null;
  }
  if (hasLink(d) && !d.canSend.aToB && !d.canSend.bToA && d.state === "active")
    return { icon: "trash", text: "Link removed" };
  if (d.ended.length)
    return { icon: "pause", text: `${joinNames(d.ended)} ended` };
  if (d.state === "waiting")
    return { icon: "clock", text: "Waiting for approval", warn: true };
  if (adminPauseOf(d)) return null;
  if (d.state === "paused" || d.paused)
    return { icon: "pause", text: "Paused" };
  return null;
}

// ---- Conversations across owners -------------------------------------------------------------------------------------------

/** A role as the words name it: the person, the owner, or an Admin. */
export const whoWord = (
  c: Pick<Cross, "person" | "owner"> & { pausedByAdmin?: string | null },
  who: CrossRole,
): string =>
  who === "sender"
    ? c.person
    : who === "owner"
      ? c.owner
      : adminWho(c.pausedByAdmin);

/** The header line: who the two people are, and who may read. */
export const crossLine = (c: Cross, agent: string): string =>
  `${c.person} (a person using Chat) writes to ${c.owner}'s agent ${agent}. Only ${c.person}, ${c.owner} and an Admin can read this.`;

/** Why the message box is off in a conversation across owners, with the one word for its placeholder; null when the viewer may write. */
export function crossOff(c: Cross): { word: string; why: string } | null {
  const mayWrite = c.viewerIs === "sender";
  if (c.link === "removed")
    return {
      word: "Link removed",
      why: `The link was removed, so nothing can be sent. ${mayWrite ? `Only ${c.owner} can open it again.` : "Choose Allow again in the menu to open it."}`,
    };
  if (c.link === "paused") {
    const by = c.pausedBy ? whoWord(c, c.pausedBy) : null;
    const rest =
      c.canResume === false && by
        ? `Only ${c.pausedBy === "admin" ? "an Admin" : by} can resume it.`
        : "Resume the link from the menu to send.";
    return {
      word: "Paused",
      why: `Paused${by ? ` by ${by}` : ""}: messages are held. ${rest}`,
    };
  }
  if (!mayWrite)
    return {
      word: "Read only",
      why: `Only ${c.person} writes in this conversation. ${c.viewerIs === "owner" ? "You" : "An Admin"} can pause or remove its link from the menu.`,
    };
  return null;
}

/** What the box says under it while a person's message waits for the owner. */
export const crossNote = (c: Cross): string | null =>
  c.viewerIs === "sender" && c.link === "waiting"
    ? `Waiting for ${c.owner} to approve your message. It is delivered once ${c.owner} allows it.`
    : null;

// ---- Who wrote a channel message (#1051) --------------------------------------------------------------------------------

export interface AuthorMarks {
  /** The chip that says an orchestrator or subagent wrote it, not a person: "orchestrator on <machine>". */
  chip: string;
  /** The warning chips: a name that is a person's, or that says it is an Admin. */
  warns: { text: string; title: string }[];
}

export const AUTHOR_CHIP_TITLE = "Written by an orchestrator, not a person";

/**
 * What a channel message says about its author beyond the name. A person's message has none. An agent's has the chip, so an agent
 * cannot look like a person, and a warning when its name is a person's on this server or claims to be an Admin. `machine` is where
 * the author runs, or null when the page does not know it (the chip then says only what wrote it).
 */
export function authorMarks(
  m: Pick<ChannelMessage, "authorKind" | "authorName">,
  people: readonly string[],
  machine: string | null,
): AuthorMarks | null {
  if (m.authorKind === "person") return null;
  const what = m.authorKind === "subagent" ? "subagent" : "orchestrator";
  const warns: AuthorMarks["warns"] = [];
  const name = m.authorName.trim().toLowerCase();
  if (people.some((p) => p.trim().toLowerCase() === name))
    warns.push({
      text: "Same name as a person",
      title: "This orchestrator's name is the name of a person on this server.",
    });
  if (name.includes("(an admin)"))
    warns.push({
      text: "Name says Admin",
      title:
        "This orchestrator's name says it is an Admin. Only a person signed in as an Admin is one.",
    });
  return { chip: machine ? `${what} on ${machine}` : what, warns };
}

// ---- Delivery lines ----------------------------------------------------------------------------------------------------

export type DeliveryIcon = "ok" | "queue" | "clock" | "pause" | "no";
export interface Delivery {
  icon: DeliveryIcon;
  text: string;
  wait: boolean;
}

const nameOf = (typed: string): string => typed.split("@")[0] ?? typed;
const list = (names: string[]): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** What became of a channel message, in one line. Someone else's message, and one with no `@`, is simply Posted. */
export function channelDelivery(
  m: Pick<ChannelMessage, "mine" | "mentions">,
): Delivery {
  if (!m.mine) return { icon: "ok", text: "Posted", wait: false };
  const by = (...s: MentionState[]) =>
    m.mentions.filter((x) => s.includes(x.state));
  const bad = by("not-delivered", "dropped");
  if (bad.length) {
    const why = bad[0]!.why ? `: ${plain(bad[0]!.why)}` : "";
    return {
      icon: "no",
      text: `Not delivered to ${list(bad.map((x) => nameOf(x.typed)))}${why}.`,
      wait: false,
    };
  }
  const held = by("held");
  if (held.length)
    return {
      icon: "pause",
      text: `Held: ${plain(held[0]!.why ?? "the channel is paused")}. It goes when the channel resumes.`,
      wait: true,
    };
  const waiting = by("waiting");
  if (waiting.length) {
    const names = waiting.map((x) => nameOf(x.typed));
    return {
      icon: "queue",
      text: `Waiting: ${list(names)} get${names.length === 1 ? "s" : ""} this when ${names.length === 1 ? "its" : "their"} current turn ends.`,
      wait: true,
    };
  }
  const working = by("working");
  const notified = by("done").filter((x) => x.sessionId === null);
  if (notified.length)
    return {
      icon: "ok",
      text: `Posted. ${list(notified.map((x) => nameOf(x.typed)))} ${notified.length === 1 ? "was" : "were"} notified.`,
      wait: false,
    };
  if (working.length)
    return {
      icon: "ok",
      text: `Posted. ${list(working.map((x) => nameOf(x.typed)))} ${working.length === 1 ? "is" : "are"} working on it.`,
      wait: false,
    };
  // A message with no `@` is between people, so it says nothing about agents (#1270). A message aimed at an agent has a mention, and
  // the mention's own state (not delivered, dropped, held, waiting, working) is the line above.
  return { icon: "ok", text: "Posted", wait: false };
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
      return {
        kind: "bad",
        state: "waiting",
        text: `${m.typed} not delivered`,
      };
  }
}

/** Where a Direct Message is, as an icon and words. `time` formats a time; the page passes the default. */
export function dmDelivery(
  m: DirectMessage,
  linkPaused: boolean,
  owner: string,
  time: (t: number) => string = hm,
  across = false,
  heldBy?: string,
): Delivery {
  const target = m.to[0];
  switch (m.state) {
    case "delivered":
      return {
        icon: "ok",
        text: `Delivered at ${time(m.stateAt)}${m.approved ? `, after ${owner} approved it` : ""}.`,
        wait: false,
      };
    case "approval":
      if (across)
        return {
          icon: "clock",
          text: `Waiting for ${m.waitingFor ?? owner} to approve it.`,
          wait: true,
        };
      return {
        icon: "clock",
        text: `Waiting for ${owner} to approve it, in My reporters or in a session on ${target?.machine ?? "its machine"}.`,
        wait: true,
      };
    case "declined":
      return {
        icon: "no",
        text: `Declined at ${time(m.stateAt)}${m.reason ? `: ${plain(m.reason)}` : ""}. It was not delivered.`,
        wait: false,
      };
    case "dropped":
      return {
        icon: "no",
        text: `Dropped at ${time(m.stateAt)}: ${m.reason ? plain(m.reason) : (PEER_DROP_WORDS[m.why ?? ""] ?? m.why ?? "the server let it go")}. It was not delivered.`,
        wait: false,
      };
    default:
      if (linkPaused)
        return {
          icon: "pause",
          text: `Held: ${heldBy ?? owner} paused this link. It goes when the link resumes.`,
          wait: true,
        };
      if (m.state === "handed")
        return {
          icon: "queue",
          text: `Handed to ${target?.machine ?? "its machine"}. Waiting for it to say ${target?.name ?? "the agent"} took it.`,
          wait: true,
        };
      return {
        icon: "queue",
        text: `Waiting: ${list(m.to.map((t) => t.name))} ${m.to.length > 1 ? "are" : "is"} working. It gets this when its turn ends.`,
        wait: true,
      };
  }
}

// ---- The box ------------------------------------------------------------------------------------------------------------

/**
 * The text typed after the last `@` that starts a word, up to the caret (#1343). A name may hold spaces, so the query runs to the
 * caret, but it starts at the `@` the caret is in: an address already in the draft (`@name@machine `) is not part of a new query,
 * so every later `@` opens the list again.
 */
export function mentionQuery(
  value: string,
  caret: number,
): { from: number; to: number; q: string } | null {
  const before = value.slice(0, caret);
  let from = -1;
  for (const m of before.matchAll(/(^|\s)@/g)) from = m.index + m[1]!.length;
  if (from < 0) return null;
  const q = before.slice(from + 1);
  return q.includes("\n") ? null : { from, to: caret, q };
}

const spoken = (names: string[]): string => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** The members of a conversation an @ can address (#1282): its people and agents other than the viewer, and nobody else. An agent that has ended is listed and cannot be picked. */
export function conversationAddresses(c: Pick<ConversationInfo, "members">): Address[] {
  return c.members
    .filter((m) => !m.you)
    .map((m): Address =>
      m.kind === "person"
        ? { typed: m.address ?? `${m.name}@console`, label: "Person in this conversation", role: "person", sessionId: null }
        : m.address
          ? { typed: m.address, label: "Orchestrator in this conversation", role: "orchestrator", sessionId: m.sessionId }
          : { typed: m.name, label: "Orchestrator in this conversation", role: "orchestrator", sessionId: m.sessionId, disabled: true, why: "Has ended, so it cannot take a message." },
    );
}

/** Who is in a conversation, in words, for its header: the people (the viewer as "You" first) and the number of agents. */
export function conversationSummary(c: Pick<ConversationInfo, "members">): string {
  const people = c.members.filter((m) => m.kind === "person").sort((a, b) => Number(b.you) - Number(a.you));
  const agents = c.members.filter((m) => m.kind === "agent").length;
  return `${spoken([...people.map((m) => (m.you ? "You" : m.name)), ...(agents ? [`${agents} ${agents === 1 ? "agent" : "agents"}`] : [])])}.`;
}

/** The line under a message that says who it was for (#1282): an icon and words, never color alone. Null when the message keeps no record of it. */
export function conversationFor(m: Pick<ConversationMessage, "deliveries">): { everyone: boolean; text: string } | null {
  if (!m.deliveries.length) return null;
  const named = m.deliveries.filter((d) => d.named);
  if (!named.length) return { everyone: true, text: "For everyone in this conversation" };
  return { everyone: false, text: `For ${spoken(named.map((d) => d.name))}${named.every((d) => d.kind === "person") ? ". No agent received it." : ""}` };
}

/** The delivery line under a message (#1282): only the agents it was handed to, in the words the Direct Message uses. Null when no agent was handed it. */
export function conversationDelivery(m: Pick<ConversationMessage, "deliveries">): { state: "done" | "wait" | "bad"; text: string } | null {
  const agents = m.deliveries.filter((d) => d.kind === "agent" && d.state !== null);
  if (!agents.length) return null;
  const of = (s: string) => agents.filter((d) => d.state === s).map((d) => d.name);
  const delivered = of("delivered");
  const queued = of("queued");
  const dropped = of("dropped");
  const parts = [
    ...(delivered.length ? [`Delivered to ${spoken(delivered)}`] : []),
    ...(queued.length ? [`Waiting for ${spoken(queued)} to take it`] : []),
    ...(dropped.length ? [`${spoken(dropped)} did not take it`] : []),
  ];
  return { state: dropped.length ? "bad" : queued.length ? "wait" : "done", text: parts.join(". ") };
}

/** The addresses that start with what is typed, in any case; the order the server gave stays. */
export function addressMatches(all: readonly Address[], q: string): Address[] {
  const want = q.toLowerCase();
  return all.filter((a) => a.typed.toLowerCase().startsWith(want));
}

export interface TextPart {
  kind: "text" | "mention" | "redacted" | "inline" | "code";
  text: string;
  /** A fenced block's language word, when the fence has one. */
  lang?: string;
}

const MENTION =
  /(@[A-Za-z0-9._-]+@[A-Za-z0-9._-]+(?:#[A-Za-z0-9_-]+)?|@group\b|@everyone\b)/;
const TICKS = "```";
/** The language word on a fence's first line, and the space and line break after it. Linear: it reads only the start of the block. */
const FENCE_HEAD = /^[\w+#.-]*[ \t]*(?:\r?\n)?/;

/**
 * The fenced blocks of a text: three backticks, an optional language word, the code, three backticks. One that is never closed is not
 * a block. `from` and `to` bound the whole fence in the text. Found with indexOf, so a text with many unclosed fences stays linear.
 */
function fences(
  text: string,
): { from: number; to: number; lang: string; body: string }[] {
  const out: { from: number; to: number; lang: string; body: string }[] = [];
  let at = 0;
  for (;;) {
    const open = text.indexOf(TICKS, at);
    if (open < 0) return out;
    const close = text.indexOf(TICKS, open + TICKS.length);
    if (close < 0) return out;
    const inner = text.slice(open + TICKS.length, close);
    const head = FENCE_HEAD.exec(inner)![0];
    out.push({
      from: open,
      to: close + TICKS.length,
      lang: /^[\w+#.-]*/.exec(head)![0],
      body: inner.slice(head.length),
    });
    at = close + TICKS.length;
  }
}
const INLINE = /`([^`\n]+)`/;

function inlineParts(chunk: string, out: TextPart[]): void {
  chunk.split(INLINE).forEach((seg, i) => {
    if (!seg) return;
    if (i % 2 === 1) {
      out.push({ kind: "inline", text: seg });
      return;
    }
    for (const bit of seg.split(MENTION)) {
      if (bit)
        out.push({
          kind: bit.startsWith("@") && MENTION.test(bit) ? "mention" : "text",
          text: bit,
        });
    }
  });
}

/**
 * A message's text as parts the page draws as text nodes: plain text, a mention, an `inline` code run, a fenced `code` block and
 * Podium's own `[redacted]` marker. Never HTML. A fence with nothing in it, or one that is never closed, stays plain text.
 */
export function messageParts(text: string): TextPart[] {
  const out: TextPart[] = [];
  const plain = (chunk: string) => {
    chunk.split("[redacted]").forEach((bit, i) => {
      if (i > 0) out.push({ kind: "redacted", text: "[redacted]" });
      inlineParts(bit, out);
    });
  };
  let at = 0;
  for (const f of fences(text)) {
    const body = f.body.replace(/\r?\n$/, "");
    if (!body.trim()) continue;
    plain(text.slice(at, f.from));
    out.push({ kind: "code", text: body, ...(f.lang ? { lang: f.lang } : {}) });
    at = f.to;
  }
  plain(text.slice(at));
  return out;
}

// ---- Runs, days and the New line (#1232) --------------------------------------------------------------------------------

/** A message continues the previous run when the same author wrote it within this long of it, on the same day. */
export const RUN_MS = 5 * 60 * 1000;

export const sameDay = (a: number, b: number): boolean => {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
};

/** Who wrote a message, as one key for grouping: you are always `me`, an agent is its session and name (a name that changes is a new header, so its warnings show), a person their name. */
export function authorKey(m: {
  channel: ChannelMessage | null;
  direct: DirectMessage | null;
}): string {
  const c = m.channel;
  if (c)
    return c.mine
      ? "me"
      : c.authorKind === "person"
        ? `person:${c.authorName.toLowerCase()}`
        : `agent:${c.authorRef}:${c.authorName}`;
  const f = m.direct!.from;
  return f.kind === "person"
    ? `person:${f.name.toLowerCase()}`
    : `agent:${f.sessionId ?? ""}:${f.name}`;
}

/**
 * For each row of the thread, in order, whether it continues the run above it. A row is a message (it has an author) or something
 * between messages (a record line, a divider, the New line: `author` is null). A message continues the run when the row just above
 * is a message by the same author on the same day, at most five minutes earlier.
 */
export function continuesRun(
  rows: readonly { author: string | null; at: number }[],
): boolean[] {
  return rows.map((r, i) => {
    const p = rows[i - 1];
    return (
      r.author !== null &&
      p !== undefined &&
      p.author === r.author &&
      sameDay(p.at, r.at) &&
      r.at - p.at >= 0 &&
      r.at - p.at <= RUN_MS
    );
  });
}

/** "Today", "Yesterday", else "Nov 6" (with the year when it is not this one), for a day divider. */
export function dayLabel(t: number, now: number): string {
  if (sameDay(t, now)) return "Today";
  if (sameDay(t, now - 86_400_000)) return "Yesterday";
  const d = new Date(t);
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear()
    ? base
    : `${base}, ${d.getFullYear()}`;
}

// ---- Times --------------------------------------------------------------------------------------------------------------

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "13:52" for today, "Mon 13:52" for any other day, in local time. */
export function stamp(t: number, now: number): string {
  const d = new Date(t);
  const n = new Date(now);
  const same =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate();
  return same ? hm(t) : `${DAYS[d.getDay()]} ${hm(t)}`;
}

// ---- An Admin reading (#1034) ---------------------------------------------------------------------------------------------------

/** An Admin as the words name them: with the name when it is known. */
export const adminWho = (name: string | null | undefined): string =>
  name ? `${name} (an Admin)` : "an Admin";

/** The readings still live by the server's clock; the page does not wait for the server to say one ended. */
export const liveReaders = (
  l: readonly AdminReading[] | undefined,
  serverNow: number,
): AdminReading[] => (l ?? []).filter((r) => r.until > serverNow);

const more = (n: number) => `${n} more Admin${n === 1 ? "" : "s"}`;

/** The banner's bold line: the first two Admins by name, the rest counted. */
export function readersLine(l: readonly AdminReading[]): string {
  const names = l.map((r) => r.admin);
  if (names.length <= 1)
    return `${adminWho(names[0])} is reading this conversation.`;
  if (names.length === 2)
    return `${names[0]} and ${names[1]} (Admins) are reading this conversation.`;
  return `${names[0]}, ${names[1]} and ${more(names.length - 2)} are reading this conversation.`;
}

/** Who has to stop for the notice to clear. */
export const readersStops = (l: readonly AdminReading[]): string =>
  l.length === 1 ? `${l[0]!.admin} stops` : "the last of them stops";

/** The tip's text: every Admin reading, with when they started. `at` formats a time. */
export const readersTip = (
  l: readonly AdminReading[],
  at: (t: number) => string,
): string =>
  `Reading now: ${l.map((r) => `${r.admin} since ${at(r.since)}`).join(", ")}.`;

/** The red banner's bold line for the Admins looking at the person's list of conversations. */
export function listReadersLine(l: readonly AdminReading[]): string {
  const names = l.map((r) => r.admin);
  if (names.length <= 1) return adminWho(names[0]);
  if (names.length === 2) return `${names[0]} and ${names[1]} (Admins)`;
  return `${names[0]}, ${names[1]} and ${more(names.length - 2)}`;
}

/** The rest of that banner: what the Admin sees of the list, and what they do not. */
export const LIST_READING_REST =
  "looking at your list of conversations now: who you talk to and how many messages, not what they say.";

/** What an Admin did in a conversation that has since been deleted, in the words after their name. */
const GONE_WHAT: Record<AdminReadKind, string> = {
  read: "read",
  cleared: "removed all messages in",
  paused: "paused",
  resumed: "resumed",
  disconnected: "disconnected the agents in",
  reconnected: "reconnected the agents in",
  recording_stopped: "stopped a recording of one of your sessions",
  recording_deleted: "deleted a recording of one of your sessions",
  activity_deleted: "deleted the stored activity of one of your sessions",
  session_deleted: "deleted one of your sessions",
  access_revoked: "revoked your Podium access",
  person_deleted: "deleted your Podium account",
  reporter_removed: "removed one of your reporters from the Reporters list",
  respond_refused: "tried to respond to one of your sessions and was refused",
  links_paused: "paused the messaging links of one of your reporters",
  links_resumed: "resumed the messaging links of one of your reporters",
  link_removed: "removed a messaging link of one of your reporters",
  channel_edited: "edited the description of a channel you opened",
  channel_removed: "removed a channel you opened",
};

/** An Admin's stop or delete of the person's own things (#1078): it has no conversation, so the line names no other party. */
export const isActRecord = (r: Pick<GoneRead, "kind">): boolean =>
  ![
    "read",
    "cleared",
    "paused",
    "resumed",
    "disconnected",
    "reconnected",
  ].includes(r.kind);

/** The parts of the quiet line for a record of a deleted conversation: the Admin, what they did, the other party and when. The page puts the names in <bdi>. */
export const goneRecordParts = (
  r: GoneRead,
): { admin: string; what: string; with: string; when: string } => ({
  admin: adminWho(r.admin),
  what: GONE_WHAT[r.kind] ?? GONE_WHAT.read,
  with: r.with,
  when: onDay(r.startedAt),
});

/** Adds the records a read brought to those the page already shows, newest first, at most 20, so they stay while the page is open though the server sends each once. */
export function mergeGone(
  shown: readonly GoneRead[],
  incoming: readonly GoneRead[],
): GoneRead[] {
  const key = (r: GoneRead) => `${r.admin}|${r.startedAt}|${r.kind}|${r.with}`;
  const seen = new Set(shown.map(key));
  const added = incoming.filter((r) => !seen.has(key(r)));
  return added.length
    ? [...shown, ...added]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 20)
    : (shown as GoneRead[]);
}

/** The quiet line a look at the person's list leaves afterward. */
export const listRecordLine = (r: AdminRead): string =>
  `${adminWho(r.admin)} looked at your list of conversations on ${onDay(r.startedAt)}. They saw who you talk to and message counts, not the messages.`;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** "Nov 6 at 14:20", in local time. */
export function onDay(t: number): string {
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} at ${hm(t)}`;
}

/** The quiet line an Admin's visit leaves among the messages. */
export function recordLine(r: AdminRead): string {
  const WHAT: Record<string, string> = {
    cleared: "removed all messages",
    paused: "paused this link",
    resumed: "resumed this link",
    disconnected: "disconnected the agents in this group",
    reconnected: "reconnected the agents in this group",
  };
  const what = (r.kind && WHAT[r.kind]) || "read this conversation";
  return `${adminWho(r.admin)} ${what} on ${onDay(r.startedAt)}.`;
}

/** The Admin who holds a pause on a channel, plain Direct Message or conversation across owners; null when no Admin does. */
export function adminPauseOf(x: {
  paused?: boolean;
  pausedByAdmin?: string | null;
  pausedBy?: CrossRole | null;
  state?: string;
  cross?: Cross | null;
}): { name: string | null } | null {
  if (x.cross)
    return x.cross.link === "paused" && x.cross.pausedBy === "admin"
      ? { name: x.cross.pausedByAdmin ?? null }
      : null;
  if (!(x.paused || x.state === "paused")) return null;
  if (x.pausedBy !== undefined && x.pausedBy !== "admin") return null;
  return x.pausedByAdmin || x.pausedBy === "admin"
    ? { name: x.pausedByAdmin ?? null }
    : null;
}
