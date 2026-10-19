// Traffic (#347, #417, SPEC 7.1 and 8.1, mockup/podium-traffic.html): which orchestrators message which. The open read,
// GET /api/fleet/peers/traffic, gives every conversation's pair, counts and state and never its text; a conversation's
// messages come from the owner's read on responding's router, which the server opens only to the owner and an Admin.
// This file holds the reads, the words the page uses for a link and a message, and the map's layout, so each can be
// tested without drawing. (Not traffic.ts: on a case-insensitive disk it would be the same file as Traffic.tsx.)
import { RespondError } from "./respondApi";
import { ADMIN } from "./people";

/** One end of a conversation: an orchestrator, and the reporter (machine) it runs on. */
export interface TrafficEnd {
  sessionId: string;
  name: string;
  machine: string;
  reporterKey: string;
}

export type LinkState = "active" | "waiting" | "paused";

/** One conversation as the open read lists it: never the text. `a` and `b` are ordered by session id. */
export interface TrafficLink {
  link: string;
  a: TrafficEnd;
  b: TrafficEnd;
  owner: string;
  messages: number;
  lastAt: number;
  state: LinkState;
  /** Whether the link is paused, which `state` hides while a message also waits for approval. */
  paused?: boolean;
  /** Whether each way can send now. */
  aToB: boolean;
  bToA: boolean;
  roundTrips: { used: number; cap: number };
}

export interface TrafficRead {
  enabled: boolean;
  conversations: TrafficLink[];
  /** Days a conversation is kept after its last message, the Admin's setting; absent while messaging is off. */
  retainDays?: number;
  /** The server's clock at the read, to count "ago" by; absent while messaging is off. */
  serverTime?: number;
}

/** How long a conversation is kept, in words, for the panel's foot and the rules. */
export function keptWords(days: number | undefined): string {
  if (days === undefined) return "for as long as Admin > Settings says";
  return days === 1 ? "for 1 day" : `for ${days} days`;
}

export type MessageState = "approval" | "ready" | "handed" | "queued" | "delivered" | "declined" | "dropped";

/** One message of a conversation, with its text, for its owner or an Admin. */
export interface PeerMessage {
  id: string;
  from: TrafficEnd;
  to: TrafficEnd;
  owner: string;
  text: string;
  sentAt: number;
  state: MessageState;
  stateAt: number;
  why: string | null;
  approved: boolean;
}

export type TrafficRange = "live" | "24h" | "30d";

export const RANGES: readonly { id: TrafficRange; label: string }[] = [
  { id: "live", label: "Live sessions" },
  { id: "24h", label: "Last 24 hours" },
  { id: "30d", label: "Last 30 days" },
];

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "X-Podium-Respond": "1", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // not JSON: the status says enough
  }
  if (!res.ok) throw new RespondError(res.status, parsed);
  return parsed as T;
}

const seg = encodeURIComponent;

export const trafficApi = {
  /** The open read: anyone who can read the console. */
  read: (range: TrafficRange) => call<TrafficRead>("GET", `/api/fleet/peers/traffic?range=${seg(range)}`),
  /** One conversation's messages, oldest first: the server answers only its owner and an Admin. */
  conversation: (a: string, b: string) => call<{ messages: PeerMessage[] }>("GET", `/api/fleet/respond/peers/conversations/${seg(a)}/${seg(b)}`),
  /** Pause link or Resume link: both ways between two reporters, keeping the rights. */
  pause: (a: string, b: string, paused: boolean) => call<{ ok: true }>("PUT", "/api/fleet/respond/peers/links", { a, b, paused }),
  /** Remove link: both ways lose every right, and a message still waiting on it is dropped. */
  remove: (a: string, b: string) => call<{ ok: true }>("DELETE", "/api/fleet/respond/peers/links", { a, b }),
};

export type TrafficApi = typeof trafficApi;

/** A conversation's id on the page: its two sessions. Two conversations can share a link between the same machines. */
export const linkId = (l: Pick<TrafficLink, "a" | "b">): string => `${l.a.sessionId}|${l.b.sessionId}`;

/** How the two ends can send: both ways, one way (and which), or neither. */
export type Ways = "both" | "aToB" | "bToA" | "none";
export function waysOf(l: Pick<TrafficLink, "aToB" | "bToA">): Ways {
  if (l.aToB && l.bToA) return "both";
  if (l.aToB) return "aToB";
  return l.bToA ? "bToA" : "none";
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "claude-dashboard and Tester", or "claude-dashboard to arm64-check" when only that way can send. */
export function pairWords(l: TrafficLink): string {
  const ways = waysOf(l);
  if (ways === "aToB") return `${l.a.name} to ${l.b.name}`;
  if (ways === "bToA") return `${l.b.name} to ${l.a.name}`;
  return `${l.a.name} and ${l.b.name}`;
}

/** The two ends in the order the line is read: the sender first on a one-way link. */
export function ordered(l: TrafficLink): [TrafficEnd, TrafficEnd] {
  return waysOf(l) === "bToA" ? [l.b, l.a] : [l.a, l.b];
}

/** Where the two run: "ed-mbp, same machine" or "ed-mbp and ci-runner-01". */
export function whereWords(l: TrafficLink): string {
  const [x, y] = ordered(l);
  return x.reporterKey === y.reporterKey ? `${x.machine}, same machine` : `${x.machine} and ${y.machine}`;
}

type StateOf = Pick<TrafficLink, "state" | "aToB" | "bToA" | "paused">;

/**
 * An active link that neither side can send on, as after Remove link: it reads "No right to send" in place of Active.
 * Worked out here from `aToB` and `bToA`; a paused or waiting link keeps its own state.
 */
export function noRightToSend(l: StateOf): boolean {
  return l.state === "active" && l.paused !== true && !l.aToB && !l.bToA;
}

/** A link's state as a word, for the panel and the table. */
export function stateWords(l: StateOf): string {
  if (l.state === "waiting") return "A message waits for approval";
  if (l.state === "paused") return "Paused";
  return noRightToSend(l) ? "No right to send" : "Active";
}

/** The count on a line's label, with the state's word when it is not active. */
export function labelWords(l: StateOf & Pick<TrafficLink, "messages">): string {
  const n = plural(l.messages, "message");
  if (l.state === "waiting") return `${n}, waiting`;
  if (l.state === "paused") return `${n}, paused`;
  return noRightToSend(l) ? `${n}, no right to send` : n;
}

/** A line's accessible name: who, how many, and its state in full words. */
export function lineLabel(l: TrafficLink): string {
  let st: string = l.state;
  if (l.state === "waiting") st = "a message waits for approval";
  else if (noRightToSend(l)) st = "no right to send";
  return `${pairWords(l)}, ${plural(l.messages, "message")}, ${st}. Show the conversation`;
}

/** The round trips cell of the table. */
export function tripsWords(l: TrafficLink): string {
  const ways = waysOf(l);
  if (ways === "both") return `${l.roundTrips.used} of ${l.roundTrips.cap}`;
  return ways === "none" ? "n/a, neither can send" : "n/a, one way";
}

/** "13:52", local time. */
export function hm(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Why the server let go of a held message, as its sender is told (peerRoutes.ts DROP_WORDS). */
const DROP_WORDS: Record<string, string> = {
  "receiver-ended": "the receiver ended first",
  "session-deleted": "a session was deleted",
  "link-removed": "the link was removed",
  "messaging-off": "orchestrator messaging was turned off",
  refused: "the receiving reporter refused it",
};

export type DeliveryIcon = "ok" | "queue" | "clock" | "pause" | "no";

/** Where a message is, as an icon and words. `wait` marks a message still held, in the warning ink. */
export function deliveryWords(m: PeerMessage, linkPaused: boolean): { icon: DeliveryIcon; text: string; wait: boolean } {
  switch (m.state) {
    case "delivered":
      return { icon: "ok", text: `Delivered at ${hm(m.stateAt)}${m.approved ? `, after ${m.owner} approved it` : ""}.`, wait: false };
    case "approval":
      return { icon: "clock", text: `Waiting for ${m.owner} to approve it, in My reporters or in a session on ${m.to.machine}.`, wait: true };
    case "declined":
      return { icon: "no", text: `Declined at ${hm(m.stateAt)}. It was not delivered.`, wait: false };
    case "dropped":
      return { icon: "no", text: `Dropped at ${hm(m.stateAt)}: ${DROP_WORDS[m.why ?? ""] ?? "the server let it go"}. It was not delivered.`, wait: false };
    default:
      if (linkPaused) return { icon: "pause", text: "Held: the link is paused. It goes when the link resumes.", wait: true };
      if (m.state === "handed") return { icon: "queue", text: `Handed to ${m.to.machine}. Waiting for it to say ${m.to.name} took it.`, wait: true };
      return { icon: "queue", text: `Waiting: ${m.to.name} is working. It gets this when its turn ends.`, wait: true };
  }
}

/** Text from an orchestrator split around Podium's own `[redacted]` marker, so the page draws text nodes and one element. */
export function redactedParts(text: string): string[] {
  return text.split("[redacted]");
}

/** A name cut to `n` characters with an ellipsis; the full text goes in a title. */
export function cut(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Whether the viewer may read a conversation's text: its owner, or an Admin. The server checks it again. */
export function canRead(viewer: { signedIn: boolean; name: string | null; admin: boolean } | null, owner: string): boolean {
  if (!viewer?.signedIn) return false;
  return viewer.admin || (viewer.name ?? "").toLowerCase() === owner.toLowerCase();
}

/** Whether the viewer may pause or remove a link here: only its owner, signed in with their own name. */
export function canManage(viewer: { signedIn: boolean; name: string | null } | null, owner: string): boolean {
  if (!viewer?.signedIn || !viewer.name) return false;
  const me = viewer.name.toLowerCase();
  return me !== ADMIN.toLowerCase() && me === owner.toLowerCase();
}

// ---- The map's layout ---------------------------------------------------------------------------------------------

export const MAP_W = 900;
const COL_X = [30, 600] as const;
const BOX_W = 270;
const TOP = 30;
const FIRST = 90;
const GAP = 170;
const FOOT = 70;
const BOX_GAP = 40;
export const NODE_R = 22;
const PILL_H = 22;

export interface MapMachine {
  key: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MapNode {
  sessionId: string;
  name: string;
  machine: string;
  x: number;
  y: number;
}

export interface MapEdge {
  id: string;
  link: TrafficLink;
  /** The path from a to b, so an arrow at its end points at b. */
  d: string;
  /** Line width: more messages, thicker, as a second signal. */
  width: number;
  /** The label pill's top-left corner and size. */
  pill: { x: number; y: number; w: number; h: number };
  label: string;
  ways: Ways;
}

export interface MapLayout {
  width: number;
  height: number;
  machines: MapMachine[];
  nodes: MapNode[];
  edges: MapEdge[];
}

type Pt = [number, number];

const byText = (x: string, y: string): number => x.localeCompare(y, undefined, { sensitivity: "base" });

/** A point on a cubic Bézier curve at `t`. */
export function bezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

/** The width a label needs at the map's 11 px font, with room for the state's icon. */
export function pillWidth(label: string, icon: boolean): number {
  return Math.ceil(label.length * 6.3) + 20 + (icon ? 16 : 0);
}

type Box = { x: number; y: number; w: number; h: number };
const overlaps = (p: Box, q: Box, pad = 4): boolean => p.x < q.x + q.w + pad && q.x < p.x + p.w + pad && p.y < q.y + q.h + pad && q.y < p.y + p.h + pad;

/** Where along a curve a label is tried, middle first, so labels where lines cross can sit apart. */
const TRIES = [0.5, 0.35, 0.65, 0.25, 0.75, 0.2, 0.8, 0.42, 0.58];

/**
 * Lays the map out: a box per machine in two columns (one centred when there is only one), its orchestrators stacked
 * in it, and a curve per conversation. A curve between the columns runs from side to side; one inside a column bows
 * out to that column's outer side. Each label goes at the first point along its curve that clears the labels placed
 * before it and the nodes and fits inside the map; when no point fits, the first clear one slid back inside the map.
 */
export function layoutMap(input: readonly TrafficLink[]): MapLayout {
  // Machines go by how many orchestrators they hold and then by name, orchestrators by name, and labels are placed in
  // one fixed order, so nothing moves when a newer message reorders the read.
  const links = [...input].sort((x, y) => byText(linkId(x), linkId(y)));
  const machineName = new Map<string, string>();
  const nodesOf = new Map<string, TrafficEnd[]>();
  for (const l of links) {
    for (const e of [l.a, l.b]) {
      if (!nodesOf.has(e.reporterKey)) {
        nodesOf.set(e.reporterKey, []);
        machineName.set(e.reporterKey, e.machine);
      }
      const list = nodesOf.get(e.reporterKey)!;
      if (!list.some((n) => n.sessionId === e.sessionId)) list.push(e);
    }
  }
  // The busiest machine first, so the columns come out even; then by name.
  const machineOrder = [...nodesOf.keys()].sort((x, y) => nodesOf.get(y)!.length - nodesOf.get(x)!.length || byText(machineName.get(x)!, machineName.get(y)!) || byText(x, y));
  for (const list of nodesOf.values()) list.sort((x, y) => byText(x.name, y.name) || byText(x.sessionId, y.sessionId));
  const heights = [TOP, TOP];
  const machines: MapMachine[] = [];
  const nodes = new Map<string, MapNode & { col: number }>();
  const single = machineOrder.length === 1;
  for (const key of machineOrder) {
    const list = nodesOf.get(key)!;
    const h = FIRST + (list.length - 1) * GAP + FOOT;
    const col = heights[0]! <= heights[1]! ? 0 : 1;
    const x = single ? (MAP_W - BOX_W) / 2 : COL_X[col];
    const y = heights[col]!;
    heights[col] = y + h + BOX_GAP;
    machines.push({ key, name: machineName.get(key)!, x, y, w: BOX_W, h });
    list.forEach((n, i) => nodes.set(n.sessionId, { sessionId: n.sessionId, name: n.name, machine: key, x: x + BOX_W / 2, y: y + FIRST + i * GAP, col: single ? 0 : col }));
  }
  const height = Math.max(heights[0]!, heights[1]!) - BOX_GAP + TOP;

  const blocked: Box[] = [...nodes.values()].map((n) => ({ x: n.x - 70, y: n.y - NODE_R, w: 140, h: NODE_R + 62 }));
  const edges: MapEdge[] = [];
  for (const l of links) {
    const A = nodes.get(l.a.sessionId)!;
    const B = nodes.get(l.b.sessionId)!;
    let p: [Pt, Pt, Pt, Pt];
    if (A.col !== B.col) {
      const dir = B.x > A.x ? 1 : -1;
      const ax = A.x + NODE_R * dir;
      const bx = B.x - NODE_R * dir;
      p = [[ax, A.y], [ax + 140 * dir, A.y], [bx - 140 * dir, B.y], [bx, B.y]];
    } else {
      const side = A.col === 1 ? 1 : -1;
      const down = B.y >= A.y ? 1 : -1;
      const depth = 90 + Math.min(Math.abs(B.y - A.y) / GAP, 3) * 20;
      p = [[A.x + NODE_R * side, A.y], [A.x + depth * side, A.y + 40 * down], [B.x + depth * side, B.y - 40 * down], [B.x + NODE_R * side, B.y]];
    }
    const d = `M${p[0][0]} ${p[0][1]} C ${p[1][0]} ${p[1][1]}, ${p[2][0]} ${p[2][1]}, ${p[3][0]} ${p[3][1]}`;
    const label = labelWords(l);
    const w = pillWidth(label, l.state !== "active" || noRightToSend(l));
    const at = (t: number): Box => {
      const [mx, my] = bezier(p[0], p[1], p[2], p[3], t);
      return { x: mx - w / 2, y: my - PILL_H / 2, w, h: PILL_H };
    };
    const free = (box: Box): boolean => !blocked.some((b) => overlaps(box, b));
    const inside = (box: Box): boolean => box.x >= 0 && box.x + box.w <= MAP_W && box.y >= 0 && box.y + box.h <= height;
    // Slid back inside the map: a long label on a line that bows out to the map's edge would otherwise be cut off.
    const keepIn = (box: Box): Box => ({ ...box, x: Math.max(0, Math.min(box.x, MAP_W - box.w)), y: Math.max(0, Math.min(box.y, height - box.h)) });
    const tries = TRIES.map(at);
    const pill = tries.find((b) => inside(b) && free(b)) ?? tries.map(keepIn).find(free) ?? keepIn(at(0.5));
    blocked.push(pill);
    edges.push({ id: linkId(l), link: l, d, width: Math.min(2 + l.messages * 0.8, 7), pill, label, ways: waysOf(l) });
  }
  return { width: MAP_W, height, machines, nodes: [...nodes.values()].map(({ col: _col, ...n }) => n), edges };
}
