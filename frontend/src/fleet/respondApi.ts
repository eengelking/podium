// The browser's side of responding (#206, SPEC 7.1): signing in, reading an ask, answering it, and sending a message.
// Every change carries X-Podium-Respond: 1; the sign-in lives in an HttpOnly cookie the page never sees, and the token
// typed into the form is sent once and never kept (SPEC 7.7).
import type { AskDetail, FileDiffReply, RespondMe } from "./types";

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

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
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

const sessionPath = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}`;

export const respondApi = {
  me: () => call<RespondMe>("GET", "/me"),
  signIn: (name: string, token: string) => call<{ ok: true; name: string; admin: boolean }>("POST", "/sign-in", { name, token }),
  signOut: () => call<{ ok: true }>("POST", "/sign-out"),
  ask: (sessionId: string, askId: string) => call<AskDetail>("GET", `${sessionPath(sessionId)}/asks/${encodeURIComponent(askId)}`),
  answer: (sessionId: string, askId: string, body: Record<string, unknown>) =>
    call<{ ok: true; deliveryId: string }>("POST", `${sessionPath(sessionId)}/asks/${encodeURIComponent(askId)}/answer`, body),
  message: (sessionId: string, body: { text: string } | { command: "clear" | "compact" }) =>
    call<{ ok: true; deliveryId: string; queued: boolean }>("POST", `${sessionPath(sessionId)}/messages`, body),
  /** One file's diff (#319): held until the session's machine answers, so it can take up to 15 seconds. */
  fileDiff: (sessionId: string, path: string) => call<FileDiffReply>("GET", `${sessionPath(sessionId)}/files/diff?path=${encodeURIComponent(path)}`),
  discard: (deliveryId: string) => call<{ ok: true }>("DELETE", `/deliveries/${encodeURIComponent(deliveryId)}`),
};

/** The browser's side of responding. `fileDiff` is optional so a test's fake can leave it out; the real one has it. */
export type RespondApi = Omit<typeof respondApi, "fileDiff"> & Partial<Pick<typeof respondApi, "fileDiff">>;
