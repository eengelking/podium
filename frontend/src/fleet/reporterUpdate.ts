// How to update each harness's reporter (#967). The server names a reporter by its wire name; `podium-reporter` alone is the Claude Code
// reporter from before it had a name of its own, so it means the same.

export type ReporterKind = "claudecode" | "opencode" | "other";

export function reporterKind(name: string): ReporterKind {
  if (name === "podium-reporter" || name === "podium-reporter-claudecode") return "claudecode";
  return name === "podium-reporter-opencode" ? "opencode" : "other";
}

/** The sentence that says what to run to update the named reporter, for a session's own note. */
export function updateSentence(name: string): string {
  switch (reporterKind(name)) {
    case "claudecode":
      return "Update the Claude Code reporter: run claude plugin update podium-reporter@eengelking-marketplace, then /reload-plugins in that session.";
    case "opencode":
      return "Update the OpenCode reporter: run opencode plugin update, then opencode service restart.";
    default:
      return `Update ${name}.`;
  }
}

/** The shorter form for the Admin list, where the reporter's name is already beside it. */
export function updateHint(name: string): string {
  switch (reporterKind(name)) {
    case "claudecode":
      return "Update the Claude Code reporter.";
    case "opencode":
      return "Update the OpenCode reporter.";
    default:
      return `Update ${name}.`;
  }
}
