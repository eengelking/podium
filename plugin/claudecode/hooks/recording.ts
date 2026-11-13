// Session recording on the machine (#353, SPEC 5.3 "Session recording from the reporter", 6.4 "Session recording"). Pure: no `$` here.
//
// The `Recorder` holds what a recording needs between hooks: whether capture is on (the server's grant, the owner's option), the
// per-loop numbering of entries, a bounded queue of redacted entries and the batching of them. Nothing is captured, stored or
// queued while capture is off. register.ts feeds it from the hooks and sends its batches from the flush timer.
import type { RecordingGrant } from '../../core/protocol.ts';
// The recorder itself moved to core for the OpenCode reporter (#969); everything that was exported from here still is.
export * from '../../core/recording.ts';
// The times and the stop and limit lines read the same on both harnesses and live in core (#1055); start and refused differ on purpose (see core/recordingLines.ts).
import { clockOn, timeWithDay } from '../../core/recordingLines.ts';
export { clockOn, timeWithDay, stoppedLine, limitLine } from '../../core/recordingLines.ts';

/**
 * The text of a prompt the mod submitted for a message from Podium, as the turn's first text. Claude Code starts the turn for such a
 * prompt with the text inside its own frame ("The <plugin> plugin sent a message:", the text on lines of its own, then an
 * explanation), and the server marks an entry as from Podium only when it holds exactly the text it delivered. `sent` lists the
 * texts the mod submitted and not yet seen back; a match, bare or framed on lines of its own, is taken out of it and returned as
 * sent. Any other text, one that merely contains a sent text included, comes back as it is.
 */
export function unframeSent(text: string, sent: string[]): string {
  const i = sent.findIndex((s) => s.length > 0 && (text === s || text.includes(`\n${s}\n`)));
  if (i < 0) return text;
  const [s] = sent.splice(i, 1);
  return s ?? text;
}


// ---- the owner's terminal (SPEC 5.3) -------------------------------------------------------------

/** Recording starts (and again after /clear and a compaction). */
export function startLine(g: RecordingGrant, now: number): string {
  const by = g.startedBy ?? 'Podium';
  const from = g.startedAt === null || g.startedAt === undefined ? 'now' : clockOn(g.startedAt, now);
  const until = g.keptUntil === null || g.keptUntil === undefined ? 'when its retention runs out' : `at ${timeWithDay(g.keptUntil, now)}`;
  return `This session is being recorded by ${by}, from ${from}. The whole history of this orchestrator and every agent and fork under it is kept in Podium for troubleshooting, and is deleted ${until}. Either of you can stop it from Podium. To refuse recording on this machine, set sessionRecording to off in /plugin configure.`;
}

/** Someone chose to record this session and the option is off here. */
export function refusedLine(g: RecordingGrant): string {
  return `${g.startedBy ?? 'Someone'} chose to record this session, but sessionRecording is off here, so nothing is recorded.`;
}
