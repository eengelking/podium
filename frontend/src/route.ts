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
