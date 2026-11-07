// Admin > About (#862): the page's data, and the plain text its Copy details button puts on the clipboard.
import { fmtBytes } from "./activityFormat";

export interface AboutReporter {
  reporterName: string;
  version: string;
  machines: number;
  compat: "ok" | "outdated" | "newer" | "unknown";
  support: { min: string; max: string } | null;
}

/** What `GET /about` answers. */
export interface AboutView {
  server: { version: string; build: string | null; runtime: "container" | "standalone"; startedAt: number; system: string };
  stack: { node: string; express: string };
  database: { engine: string; version: string; schemaVersion: number; sizeBytes: number | null };
  reporters: AboutReporter[];
  serverTime: number;
}

/** The versions of React and TypeScript the console was built with; "unknown" outside a build that sets them. */
export const CONSOLE_BUILD = {
  react: typeof __PODIUM_REACT__ === "string" ? __PODIUM_REACT__ : "unknown",
  typescript: typeof __PODIUM_TYPESCRIPT__ === "string" ? __PODIUM_TYPESCRIPT__ : "unknown",
};

const REPORTER_LABEL: Record<string, string> = {
  "podium-reporter-claudecode": "Claude Code reporter",
  "podium-reporter-opencode": "OpenCode reporter",
};
/** The reporter as a person names it; a name this console does not know is shown as sent. */
export const reporterLabel = (name: string): string => (Object.hasOwn(REPORTER_LABEL, name) ? REPORTER_LABEL[name]! : name);

export const RUNTIME_LABEL: Record<AboutView["server"]["runtime"], string> = { container: "Container", standalone: "Stand-alone" };

/** How long the server has been up, to the two largest units: "3 days 4 h", "5 h 12 min", "2 min". */
export function upText(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  if (d > 0) return `${d} day${d === 1 ? "" : "s"} ${h} h`;
  if (h > 0) return `${h} h ${min % 60} min`;
  return `${min} min`;
}

/** The range this server reads, as major.minor ("0.2 to 1.5", the part it compares); a reporter it has no range for says so. */
export function rangeText(support: AboutReporter["support"]): string {
  if (!support) return "not checked";
  const mm = (v: string) => v.split(".").slice(0, 2).join(".");
  return `${mm(support.min)} to ${mm(support.max)}`;
}

/** When the server started, as a short local date and time. */
export const startedText = (t: number) =>
  new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Everything on the page as plain text, for a bug report or a chat. */
export function aboutText(a: AboutView): string {
  const s = a.server;
  const lines = [
    `Podium ${s.version}${s.build ? ` (build ${s.build})` : ""}`,
    `Running as: ${RUNTIME_LABEL[s.runtime].toLowerCase()} · started ${startedText(s.startedAt)} · up ${upText(a.serverTime - s.startedAt)} · ${s.system}`,
    `Node.js v${a.stack.node} · Express ${a.stack.express} · React ${CONSOLE_BUILD.react} · TypeScript ${CONSOLE_BUILD.typescript}`,
    `Database: ${a.database.engine} ${a.database.version} · schema ${a.database.schemaVersion}${a.database.sizeBytes === null ? "" : ` · ${fmtBytes(a.database.sizeBytes)}`}`,
  ];
  if (a.reporters.length === 0) lines.push("Reporters: none connected");
  else {
    lines.push(`Reporters (${a.reporters.reduce((n, r) => n + r.machines, 0)} machines):`);
    for (const r of a.reporters) {
      const note = r.compat === "outdated" || r.compat === "newer" ? ` (${r.compat}; this server reads ${rangeText(r.support)})` : "";
      lines.push(`  ${reporterLabel(r.reporterName)} ${r.version} x${r.machines}${note}`);
    }
  }
  return lines.join("\n");
}
