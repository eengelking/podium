// What the person is told about a recording of their session (#353, #969): when it starts, when someone stops it, when a limit does,
// and when someone chose to record a session on a machine that has not allowed it. The Claude Code reporter says the same things in
// its terminal; here they go to the person as a toast, or to the console log when no TUI is attached. Pure.
import type { RecordingGrant } from '../core/protocol.ts';
import { clockOn, timeWithDay } from '../core/recordingLines.ts';
// The stop and limit lines read the same on both harnesses and live in core (#1055); start and refused differ on purpose (see core/recordingLines.ts).
export { limitLine, stoppedLine } from '../core/recordingLines.ts';

/** Recording starts. */
export function startLine(g: RecordingGrant, now: number): string {
  const by = g.startedBy ?? 'Podium';
  const from = g.startedAt === null || g.startedAt === undefined ? 'now' : clockOn(g.startedAt, now);
  const until = g.keptUntil === null || g.keptUntil === undefined ? 'when its retention runs out' : `at ${timeWithDay(g.keptUntil, now)}`;
  return `This session is being recorded by ${by}, from ${from}. The whole history of this session and every subagent under it is kept in Podium for troubleshooting, and is deleted ${until}. Either of you can stop it from Podium. To refuse recording on this machine, remove PODIUM_SESSION_RECORDING from your environment and ~/.podium/config.env.`;
}

/** Someone chose to record this session and the person has not allowed it here. */
export function refusedLine(g: RecordingGrant): string {
  return `${g.startedBy ?? 'Someone'} chose to record this session, but session recording is off here (PODIUM_SESSION_RECORDING is not true), so nothing is recorded.`;
}
