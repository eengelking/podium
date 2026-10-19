// Orchestrator messaging on My reporters (#347, #415, SPEC 7.7 and 8.1): what the page reads from
// GET /api/fleet/respond/peers, and the rules it draws with. The server decides every right; this file only
// says how a pair looks: its level, whether it can be changed here, and why not.
import type { PeerLevel, PeerRequest, ReporterCompat, SessionView } from "./types";

export type { PeerLevel } from "./types";

/** One of the person's reporters, as GET /respond/peers lists it. */
export interface PeerReporter {
  key: string;
  /** The machine name, or the key when the reporter sent none. */
  machine: string;
  owner: string | null;
  adminSecret: boolean;
  os: string | null;
  /** The reporter's `peers` option as last reported; null from a reporter too old to send it. */
  peers: boolean | null;
  version: string;
  /** Its live orchestrators. */
  live: { sessionId: string; name: string; status: "running" | "waiting" | "done"; peers: boolean }[];
}

/** One direction between two reporters, as stored. A missing row is No access. */
export interface PeerRight {
  from: string;
  to: string;
  owner: string;
  level: PeerLevel;
  paused: boolean;
  setAt: number;
}

export interface PeerDefaults {
  trust: boolean;
  onRequest: "ask" | "allow" | "decline";
  newSend: "ask" | "send";
  limits: Partial<PeerLimitsView>;
}

export interface PeerLimitsView {
  roundTrips: number;
  perMinute: number;
  maxChars: number;
}

/** A request as the owner's read lists it: the reporters by machine for the words, and by key to find their Grid cell. */
export type PeerRequestView = PeerRequest & { fromKey: string; toKey: string; messageId: string | null };

/** My reporters in one read. */
export interface PeersRead {
  enabled: boolean;
  owner: string;
  reporters: PeerReporter[];
  rights: PeerRight[];
  defaults: PeerDefaults;
  limits: { server: PeerLimitsView; effective: PeerLimitsView };
  requests: PeerRequestView[];
}

/** The four levels, lowest first: the Board's columns and every select's options. */
export const LEVELS: readonly PeerLevel[] = ["none", "see", "ask", "send"];

/** One label per level, the same everywhere: the Grid, the Board, the Admin's view and the terminal (peers.ts on the server). */
export const LEVEL_LABEL: Record<PeerLevel, string> = { none: "No access", see: "Can see", ask: "Can send, with approval", send: "Can send" };

export const canSend = (l: PeerLevel): boolean => l === "ask" || l === "send";

/** `<from>><to>`: one direction between two reporters. */
export const pairKey = (from: string, to: string): string => `${from}>${to}`;

/** A reporter key made safe for an element id. */
export const idPart = (key: string): string => key.replaceAll(/[^\w-]/g, "_");

/** Why a reporter cannot take part, in words; null when its `peers` option is on. */
export function messagingOff(r: Pick<PeerReporter, "peers" | "machine">): string | null {
  if (r.peers === true) return null;
  return r.peers === null ? `${r.machine}'s reporter can't message: update it` : `Messaging is off on ${r.machine}`;
}

/** The parts of a read the Grid and the Board draw from, indexed once. */
export interface RightsModel {
  reporters: PeerReporter[];
  trust: boolean;
  /** The level the pair has now. */
  level: (a: string, b: string) => PeerLevel;
  /** Why the pair cannot be changed, or null. Messaging off on either machine, or Trust my own reporters. */
  locked: (a: string, b: string) => boolean;
  /** Why the pair has no messaging, when one of the two machines has it off. */
  off: (a: string, b: string) => string | null;
  paused: (a: string, b: string) => boolean;
  /** An Admin's proposal for the pair that waits for the owner. */
  proposed: (a: string, b: string) => PeerLevel | null;
}

export function rightsModel(d: Pick<PeersRead, "reporters" | "rights" | "defaults" | "requests">): RightsModel {
  const byKey = new Map(d.reporters.map((r) => [r.key, r]));
  const stored = new Map(d.rights.map((r) => [pairKey(r.from, r.to), r]));
  const proposals = new Map<string, PeerLevel>();
  for (const q of d.requests) {
    if (q.kind === "proposal" && q.level) proposals.set(pairKey(q.fromKey, q.toKey), q.level);
  }
  const off = (a: string, b: string): string | null => {
    const ra = byKey.get(a);
    const rb = byKey.get(b);
    if (!ra || !rb) return "That reporter is no longer listed";
    return messagingOff(ra) ?? messagingOff(rb);
  };
  const trust = d.defaults.trust;
  return {
    reporters: d.reporters,
    trust,
    off,
    level: (a, b) => (off(a, b) ? "none" : trust ? "send" : (stored.get(pairKey(a, b))?.level ?? "none")),
    locked: (a, b) => trust || off(a, b) !== null,
    paused: (a, b) => stored.get(pairKey(a, b))?.paused ?? false,
    proposed: (a, b) => proposals.get(pairKey(a, b)) ?? null,
  };
}

/**
 * Giving A the right to send to B asks at once whether B can answer, since a reply needs its own right. Asked only when
 * the change gave A a right to send it did not have, between two machines, and B cannot send back yet.
 */
export function asksBack(before: PeerLevel, after: PeerLevel, back: PeerLevel, a: string, b: string): boolean {
  return a !== b && canSend(after) && !canSend(before) && !canSend(back);
}

/** The words around the second reporter in a sentence about a right: "can send to B, with approval". */
export function rightWords(level: PeerLevel, today = false): [string, string] {
  switch (level) {
    case "none":
      return ["has no access to", ""];
    case "see":
      return [today ? "can only see" : "can see", ""];
    case "ask":
      return ["can send to", ", with approval"];
    default:
      return ["can send to", ""];
  }
}

export type SystemKind = "mac" | "win" | "linux";

/** Which icon a reporter's system gets. A system the server did not name has none. */
export function systemKind(os: string | null): SystemKind | null {
  if (!os) return null;
  if (/mac|darwin|os x/i.test(os)) return "mac";
  if (/windows/i.test(os)) return "win";
  return "linux";
}

/** What the person's own reporter table shows for one reporter, from its live orchestrators in the fleet. */
export interface ReporterLook {
  /** `reporting` while it has a live orchestrator; `quiet` otherwise. */
  state: "reporting" | "quiet";
  lastSeenAt: number | null;
  compat: ReporterCompat | null;
}

export function reporterLook(r: Pick<PeerReporter, "live">, sessions: Record<string, Pick<SessionView, "lastSeenAt" | "compat">>): ReporterLook {
  let lastSeenAt: number | null = null;
  let compat: ReporterCompat | null = null;
  for (const o of r.live) {
    const s = sessions[o.sessionId];
    if (!s) continue;
    if (lastSeenAt === null || s.lastSeenAt > lastSeenAt) {
      lastSeenAt = s.lastSeenAt;
      compat = s.compat;
    }
  }
  return { state: r.live.length ? "reporting" : "quiet", lastSeenAt, compat };
}

/** The read with one right changed, as the page shows it while the server saves it. */
export function withRight(d: PeersRead, from: string, to: string, level: PeerLevel): PeersRead {
  const had = d.rights.find((r) => r.from === from && r.to === to);
  const rest = d.rights.filter((r) => r !== had);
  if (level === "none" && !had?.paused) return { ...d, rights: rest };
  return { ...d, rights: [...rest, { from, to, owner: d.owner, level, paused: had?.paused ?? false, setAt: had?.setAt ?? 0 }] };
}
