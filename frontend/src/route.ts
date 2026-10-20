export type Route = "history" | "admin" | "board" | "my-reporters" | "traffic" | "fleet";

/**
 * `#/history` is the history view, `#/board` the kanban board, `#/me/reporters` My reporters, `#/traffic` Traffic and
 * `#/admin` the Admin section; every other hash (including the retired `#/usage`) is the fleet console.
 */
export function routeFor(hash: string): Route {
  if (hash === "#/admin" || hash.startsWith("#/admin/")) return "admin";
  if (hash === "#/board" || hash.startsWith("#/board?")) return "board";
  if (hash === "#/me/reporters") return "my-reporters";
  if (hash === "#/traffic") return "traffic";
  return hash === "#/history" || hash.startsWith("#/history?") ? "history" : "fleet";
}

/** The orchestrator open on the fleet console, which the address keeps as `#/?open=<id>` the way History does. */
export function openIn(hash: string): string | null {
  if (routeFor(hash) !== "fleet") return null;
  const q = hash.indexOf("?");
  return q < 0 ? null : new URLSearchParams(hash.slice(q + 1)).get("open") || null;
}

/** The fleet console's address with an orchestrator open, or the wall's when none is. */
export function fleetHash(open: string | null): string {
  return open ? `#/?${new URLSearchParams({ open }).toString()}` : "#/";
}
