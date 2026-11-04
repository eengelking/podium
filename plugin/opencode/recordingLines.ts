// What the person is told about a recording of their session (#353, #969): when it starts, when someone stops it, when a limit does,
// and when someone chose to record a session on a machine that has not allowed it. The Claude Code reporter says the same things in
// its terminal; here they go to the person as a toast, or to the console log when no TUI is attached. Pure.
import type { RecordingGrant } from '../core/protocol.ts';

const two = (n: number): string => String(n).padStart(2, '0');
const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const clock = (d: Date): string => `${two(d.getHours())}:${two(d.getMinutes())}`;
const day = (d: Date): string => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

/** A moment in local time: `11:42` today, `11:42 on 2026-10-21` on another day. */
function clockOn(at: number, now: number): string {
  const d = new Date(at);
  return sameDay(d, new Date(now)) ? clock(d) : `${clock(d)} on ${day(d)}`;
}

/** A time something is kept until: `17:42 today`, or the day when it is not today. */
function untilOn(at: number, now: number): string {
  const d = new Date(at);
  return sameDay(d, new Date(now)) ? `${clock(d)} today` : `${clock(d)} on ${day(d)}`;
}

/** Recording starts. */
export function startLine(g: RecordingGrant, now: number): string {
  const by = g.startedBy ?? 'Podium';
  const from = g.startedAt === null || g.startedAt === undefined ? 'now' : clockOn(g.startedAt, now);
  const until = g.keptUntil === null || g.keptUntil === undefined ? 'when its retention runs out' : `at ${untilOn(g.keptUntil, now)}`;
  return `This session is being recorded by ${by}, from ${from}. The whole history of this session and every subagent under it is kept in Podium for troubleshooting, and is deleted ${until}. Either of you can stop it from Podium. To refuse recording on this machine, remove PODIUM_SESSION_RECORDING from your environment and ~/.podium/config.env.`;
}

/** Someone stopped the recording. */
export function stoppedLine(g: RecordingGrant, now: number): string {
  const by = g.stoppedBy ?? 'Podium';
  const when = g.stoppedAt === null || g.stoppedAt === undefined ? 'an unknown time' : clockOn(g.stoppedAt, now);
  const until = g.keptUntil === null || g.keptUntil === undefined ? 'its retention runs out' : untilOn(g.keptUntil, now);
  return `Recording stopped by ${by} at ${when}. What was recorded until then is kept until ${until}.`;
}

/** The session's size limit or the server's disk budget stopped it. */
export function limitLine(g: RecordingGrant): string {
  const what = g.limit === 'budget' ? "the server's disk budget" : `its ${Math.round(g.bytes / 1_048_576)} MB limit`;
  return `Recording stopped: this session reached ${what}. Nothing after this point is kept.`;
}

/** Someone chose to record this session and the person has not allowed it here. */
export function refusedLine(g: RecordingGrant): string {
  return `${g.startedBy ?? 'Someone'} chose to record this session, but session recording is off here (PODIUM_SESSION_RECORDING is not true), so nothing is recorded.`;
}
