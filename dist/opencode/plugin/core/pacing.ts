// How often a large report goes out (#752, SPEC 6.7). Every report is the whole session, so a session with 200 agents posts about 140 KB
// each second while it works. Most of what changes between two such reports is a counter: tokens, cost, a call count, the last tool. This is
// the one rule both reporters share (the Claude Code and the OpenCode reporter send through the same `Transport`): a large report whose
// only changes are counters waits a little longer, and anything else goes at once. Nothing is dropped, only sent later, and the report
// format is the same, so there is no protocol change (SPEC 6.8).
import type { Report } from './protocol.ts';

/** A report this size or smaller is never held: the saving is too small to be worth a counter that is a second old. */
export const HOLD_FROM_BYTES = 32 * 1024;
/** The hold grows by one second for each this many bytes of the last report, up to the heartbeat. */
const HOLD_STEP_MS = 1000;

/** Fields that only count or measure, and so may be a few seconds old on the wall without the person missing anything. */
const SESSION_COUNTERS = ['tokens', 'usageByModel', 'costUsd', 'context', 'loop'] as const;
const AGENT_COUNTERS = ['tokens', 'usageByModel', 'costUsdEst', 'context', 'lastTool', 'toolCalls', 'toolCounts', 'toolStats', 'steps'] as const;

function without(o: object, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...o };
  for (const k of keys) delete out[k];
  return out;
}

/**
 * Everything in a report except its counters, its send time and its events, as one string. Two reports with the same key differ
 * only in counters. A field this does not know is part of the key, so a field added later is sent at once until it is listed above.
 */
export function attentionKey(r: Report): string {
  return JSON.stringify({
    ...r,
    sentAt: 0,
    events: 0,
    signals: 0, // the count of each hook and field the harness sent (#724), which moves with every event
    session: without(r.session, SESSION_COUNTERS),
    agents: r.agents.map((a) => without(a, AGENT_COUNTERS)),
  });
}

/** How long a report that only counted waits after the last one, by the size of that last report: none up to 32 KB, then a second more for each 32 KB, never past the heartbeat. */
export function holdMs(lastBytes: number, heartbeatMs: number): number {
  if (lastBytes <= HOLD_FROM_BYTES) return 0;
  return Math.min(heartbeatMs, Math.ceil(lastBytes / HOLD_FROM_BYTES) * HOLD_STEP_MS);
}
