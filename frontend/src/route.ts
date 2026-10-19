export type Route = "history" | "admin" | "board" | "my-reporters" | "fleet";

/**
 * `#/history` is the history view, `#/board` the kanban board, `#/me/reporters` My reporters and `#/admin` the Admin
 * section; every other hash (including the retired `#/usage`) is the fleet console.
 */
export function routeFor(hash: string): Route {
  if (hash === "#/admin" || hash.startsWith("#/admin/")) return "admin";
  if (hash === "#/board" || hash.startsWith("#/board?")) return "board";
  if (hash === "#/me/reporters") return "my-reporters";
  return hash === "#/history" || hash.startsWith("#/history?") ? "history" : "fleet";
}
