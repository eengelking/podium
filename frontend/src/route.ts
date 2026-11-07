export type Route = "history" | "admin" | "board" | "my-reporters" | "traffic" | "chat" | "fleet";

/**
 * `#/history` is the history view, `#/board` the kanban board, `#/me/reporters` My reporters, `#/chat` Chat (#1034, `#/chat?with=<id>` opens the chat with that session, #1067), `#/traffic` the
 * retired Traffic (which the page redirects to Chat) and `#/admin` the Admin section; every other hash (including the retired `#/usage`) is the fleet console.
 */
export function routeFor(hash: string): Route {
  if (hash === "#/admin" || hash.startsWith("#/admin/")) return "admin";
  if (hash === "#/board" || hash.startsWith("#/board?")) return "board";
  if (hash === "#/me/reporters") return "my-reporters";
  if (hash === "#/traffic") return "traffic";
  if (hash === "#/chat" || hash.startsWith("#/chat?")) return "chat";
  return hash === "#/history" || hash.startsWith("#/history?") ? "history" : "fleet";
}

/** The session whose chat `#/chat?with=<id>` opens (#1067), or null: the orchestrator page's "Chat with Agent" button builds that address. */
export function chatWith(hash: string): string | null {
  if (routeFor(hash) !== "chat") return null;
  const q = hash.indexOf("?");
  return q < 0 ? null : new URLSearchParams(hash.slice(q + 1)).get("with") || null;
}

/** The address of the chat with one session (#1067). */
export function chatHash(id: string): string {
  return `#/chat?${new URLSearchParams({ with: id }).toString()}`;
}

/** The orchestrator open on the fleet console, which the address keeps as `#/?open=<id>` the way History does. */
export function openIn(hash: string): string | null {
  if (routeFor(hash) !== "fleet") return null;
  const q = hash.indexOf("?");
  return q < 0 ? null : new URLSearchParams(hash.slice(q + 1)).get("open") || null;
}

/** The session whose recording is open as a replay (`#/?open=<id>&replay`, #353), or null: built on the open orchestrator's address. */
export function replayIn(hash: string): string | null {
  const id = openIn(hash);
  if (id === null) return null;
  return new URLSearchParams(hash.slice(hash.indexOf("?") + 1)).has("replay") ? id : null;
}

/** The address of a session's replay. It survives a reload, and a viewer who may not open it sees the refusal at the same address. */
export function replayHash(id: string): string {
  return `#/?${new URLSearchParams({ open: id }).toString()}&replay`;
}

/** The fleet console's address with an orchestrator open, or the wall's when none is. */
export function fleetHash(open: string | null): string {
  return open ? `#/?${new URLSearchParams({ open }).toString()}` : "#/";
}

/** Where a retired address goes: Traffic (#417) was replaced by Chat (#1034), so `#/traffic` opens `#/chat`. Null for every other address. */
export function redirectFor(hash: string): string | null {
  return hash === "#/traffic" ? "#/chat" : null;
}
