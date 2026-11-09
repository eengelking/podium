// What each tool did beyond being called (#721), kept the same way by every harness's reporter: failed calls, permission asks and how they
// ended, and call lengths. Counts only: never an argument, a path, a command or an error's text. Pure: no `$` here.
import { timeBucket, type ToolStat } from './protocol.ts';

/** The most tool names one loop keeps counts for, as the server takes (SPEC 7.7). */
export const MAX_TOOL_NAMES = 100;

/** What happened to one call of a tool, to be added to the tool's stat. A field left out is 0. */
export interface ToolEvent {
  failed?: boolean;
  /** The call raised a permission prompt. */
  asked?: boolean;
  /** How a prompt it raised ended. */
  allowed?: boolean;
  denied?: boolean;
  /** The prompt was answered from Podium. */
  podium?: boolean;
  /** How long the call took, in milliseconds. */
  ms?: number;
}

/**
 * Adds one event to a tool's stat in `stats`, in place, and returns `stats`. A tool that is not there yet is added only while there are fewer
 * than `maxNames` names, the same cap `toolCounts` has, so the two never name different tools.
 */
export function bumpStat(stats: Record<string, ToolStat>, tool: string, e: ToolEvent, maxNames: number): Record<string, ToolStat> {
  const has = Object.hasOwn(stats, tool);
  if (!has && Object.keys(stats).length >= maxNames) return stats;
  const s: ToolStat = has ? stats[tool]! : {};
  if (e.failed) s.failed = (s.failed ?? 0) + 1;
  if (e.asked) s.asked = (s.asked ?? 0) + 1;
  if (e.allowed) s.allowed = (s.allowed ?? 0) + 1;
  if (e.denied) s.denied = (s.denied ?? 0) + 1;
  if (e.podium) s.podium = (s.podium ?? 0) + 1;
  if (e.ms !== undefined && Number.isFinite(e.ms) && e.ms >= 0) {
    const key = String(timeBucket(e.ms));
    const times = s.times ?? (s.times = {});
    times[key] = (times[key] ?? 0) + 1;
  }
  stats[tool] = s;
  return stats;
}

/** A copy of `stats` that can be changed without changing it. */
export function copyStats(stats: Record<string, ToolStat>): Record<string, ToolStat> {
  return Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { ...v, ...(v.times ? { times: { ...v.times } } : {}) }]));
}

/** What a report sends: the names clipped by `clipName`, and a tool that has nothing left out. */
export function reportStats(stats: Record<string, ToolStat>, clipName: (name: string) => string): Record<string, ToolStat> {
  const out: Record<string, ToolStat> = {};
  for (const [name, v] of Object.entries(stats)) {
    if (!Object.keys(v).length) continue;
    out[clipName(name)] = copyStats({ x: v }).x!;
  }
  return out;
}
