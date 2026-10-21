// The browser's side of responding (#206, SPEC 7.1): signing in, reading an ask, answering it, and sending a message.
// Every change carries X-Podium-Respond: 1; the sign-in lives in an HttpOnly cookie the page never sees, and the token
// typed into the form is sent once and never kept (SPEC 7.7).
import type { ActivityHistoryPage, AskDetail, FileDiffReply, PeerLevel, RecordingGrant, RecordingPage, RespondMe } from "./types";
import type { PeerDefaults, PeerLimitsView, PeersRead } from "./peers";

const BASE = "/api/fleet/respond";

/** A refusal from the server, with its status and body, so the modal can show the matching frame. */
export class RespondError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.error === "string" ? body.error : `HTTP ${status}`);
  }
}

/** One request to the console's respond or peers routes: the header, the cookie, and a refusal as a RespondError. */
export async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "X-Podium-Respond": "1", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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

const callRespond = <T,>(method: string, path: string, body?: unknown) => call<T>(method, `${BASE}${path}`, body);

const sessionPath = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}`;

export const respondApi = {
  me: () => callRespond<RespondMe>("GET", "/me"),
  signIn: (name: string, token: string) => callRespond<{ ok: true; name: string; admin: boolean }>("POST", "/sign-in", { name, token }),
  signOut: () => callRespond<{ ok: true }>("POST", "/sign-out"),
  ask: (sessionId: string, askId: string) => callRespond<AskDetail>("GET", `${sessionPath(sessionId)}/asks/${encodeURIComponent(askId)}`),
  answer: (sessionId: string, askId: string, body: Record<string, unknown>) =>
    callRespond<{ ok: true; deliveryId: string }>("POST", `${sessionPath(sessionId)}/asks/${encodeURIComponent(askId)}/answer`, body),
  message: (sessionId: string, body: { text: string } | { command: "clear" | "compact" }) =>
    callRespond<{ ok: true; deliveryId: string; queued: boolean }>("POST", `${sessionPath(sessionId)}/messages`, body),
  /** One file's diff (#319): held until the session's machine answers, so it can take up to 15 seconds. */
  fileDiff: (sessionId: string, path: string) => callRespond<FileDiffReply>("GET", `${sessionPath(sessionId)}/files/diff?path=${encodeURIComponent(path)}`),
  /** One page of a loop's stored Activity (#432), oldest first; the owner and the Admin only. `before` is a page's `olderBefore`. */
  activityHistory: (sessionId: string, loop: string, before?: number | null, limit?: number) =>
    callRespond<ActivityHistoryPage>(
      "GET",
      `${sessionPath(sessionId)}/activity-history?loop=${encodeURIComponent(loop)}${before != null ? `&before=${before}` : ""}${limit != null ? `&limit=${limit}` : ""}`,
    ),
  discard: (deliveryId: string) => callRespond<{ ok: true }>("DELETE", `/deliveries/${encodeURIComponent(deliveryId)}`),
  /** One page of a session's recording (#353), oldest first; the owner and an Admin only. `before` is a page's `olderBefore`. */
  recordingPage: (sessionId: string, opts: { before?: number | null; loop?: string | null; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.before != null) q.set("before", String(opts.before));
    if (opts.loop) q.set("loop", opts.loop);
    if (opts.limit != null) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return callRespond<RecordingPage>("GET", `${sessionPath(sessionId)}/recording${qs ? `?${qs}` : ""}`);
  },
  /** The consent as it stands before Start (#353): `grant.consent.owner` says whether the session's reporter allows recording. */
  recordingConsent: (sessionId: string) => callRespond<{ ok: true; grant: RecordingGrant }>("GET", `${sessionPath(sessionId)}/recording/consent`),
  /** Chooses the loops to record from now on (#353). */
  recordingStart: (sessionId: string, loops: string[]) => callRespond<{ ok: true; grant: RecordingGrant }>("PUT", `${sessionPath(sessionId)}/recording`, { loops }),
  /** Ends capture and keeps what was recorded. */
  recordingStop: (sessionId: string) => callRespond<{ ok: true; grant: RecordingGrant }>("POST", `${sessionPath(sessionId)}/recording/stop`),
  /** Removes the whole recording. */
  recordingDelete: (sessionId: string) => callRespond<{ ok: true; entries: number; bytes: number }>("DELETE", `${sessionPath(sessionId)}/recording`),
};

/** The recording routes (#353). Optional so a test's fake can leave them out; the real one has them. */
type RecordingCalls = "recordingPage" | "recordingConsent" | "recordingStart" | "recordingStop" | "recordingDelete";

/** The browser's side of responding. `fileDiff`, `activityHistory` and the recording calls are optional so a test's fake can leave them out; the real one has them. */
export type RespondApi = Omit<typeof respondApi, "fileDiff" | "activityHistory" | RecordingCalls> & Partial<Pick<typeof respondApi, "fileDiff" | "activityHistory" | RecordingCalls>>;

/**
 * My reporters (#347, #415, SPEC 7.1 "Browser routes for orchestrator messaging"): on the same router and sign-in as
 * responding, so a change carries the same header. Each acts on the signed-in person's own reporters only.
 */
export const peersApi = {
  read: () => callRespond<PeersRead>("GET", "/peers"),
  setRight: (from: string, to: string, level: PeerLevel) => callRespond<{ ok: true }>("PUT", "/peers/rights", { from, to, level }),
  /** The owner's defaults, and their stricter `limits` (#436): a number at most the Admin's, or null to use the Admin's. */
  setDefaults: (patch: Partial<Pick<PeerDefaults, "trust" | "onRequest" | "newSend">> & { limits?: Partial<Record<keyof PeerLimitsView, number | null>> }) =>
    callRespond<{ ok: true; defaults: PeerDefaults }>("PUT", "/peers/defaults", patch),
  answer: (requestId: string, answer: "allow" | "decline" | "deliver") => callRespond<{ ok: true; outcome: string | null }>("POST", `/peers/requests/${encodeURIComponent(requestId)}`, { answer }),
};

export type PeersApi = typeof peersApi;
