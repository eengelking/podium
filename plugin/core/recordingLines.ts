// What the person is told about a recording of their session, the parts both reporters say in the same words (#353, #969, #1055):
// the times, and the lines for a stop and for a limit. Pure.
//
// `startLine` and `refusedLine` are NOT here on purpose: they differ by harness. Each names its own way to refuse recording
// (Claude Code: `sessionRecording` in /plugin configure; OpenCode: PODIUM_SESSION_RECORDING in the environment) and its own word for
// what is kept (an orchestrator and its agents and forks, or a session and its subagents). Each harness keeps its own.
import type { RecordingGrant } from './protocol.ts';

const two = (n: number): string => String(n).padStart(2, '0');

/** `HH:MM` in the session machine's local time. */
export function clockTime(at: number): string {
  const d = new Date(at);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

function dayOf(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** A moment in local time: `11:42` today, `11:42 on 2026-10-21` on another day. */
export function clockOn(at: number, now: number): string {
  return sameDay(at, now) ? clockTime(at) : `${clockTime(at)} on ${dayOf(at)}`;
}

/** A time something is kept until or deleted at: `17:42 today`, or the day when it is not today. */
export function timeWithDay(at: number, now: number): string {
  return sameDay(at, now) ? `${clockTime(at)} today` : `${clockTime(at)} on ${dayOf(at)}`;
}

/** Someone stopped the recording. */
export function stoppedLine(g: RecordingGrant, now: number): string {
  const by = g.stoppedBy ?? 'Podium';
  const when = g.stoppedAt === null || g.stoppedAt === undefined ? 'an unknown time' : clockOn(g.stoppedAt, now);
  const until = g.keptUntil === null || g.keptUntil === undefined ? 'its retention runs out' : timeWithDay(g.keptUntil, now);
  return `Recording stopped by ${by} at ${when}. What was recorded until then is kept until ${until}.`;
}

/** The session's size limit or the server's disk budget stopped it. */
export function limitLine(g: RecordingGrant): string {
  const what = g.limit === 'budget' ? "the server's disk budget" : `its ${Math.round(g.bytes / 1_048_576)} MB limit`;
  return `Recording stopped: this session reached ${what}. Nothing after this point is kept.`;
}
