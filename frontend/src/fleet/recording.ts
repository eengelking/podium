// What the console says about a session recording (#353, mockup/podium-recording.html), worked out from one SessionView, the
// Admin's flag and who is signed in. Pure: the components draw what these say.
import { MAIN_LOOP } from "../../../server/src/fleet/protocol";
import { fleetHash, replayHash } from "../route";
import { isMine } from "./respond";
import type { AgentView, RecordingGrant, RecordingLoopInfo, RecordingView, RespondMe, SessionView } from "./types";

export { MAIN_LOOP };
export { fmtBytes as sizeWords } from "./admin/activityFormat";

const pad = (n: number) => String(n).padStart(2, "0");

/** The time of day, "11:42". */
export function fmtAt(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A time as the notice words it: "17:42 today" for the same day as `now`, otherwise "2026-10-21 03:10". `today` leaves the word off. */
export function fmtWhen(t: number, now: number, today = true): string {
  if (new Date(t).toDateString() === new Date(now).toDateString()) return today ? `${fmtAt(t)} today` : fmtAt(t);
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmtAt(t)}`;
}

/** Whether the viewer may choose what to record, stop it, open it or delete it: the session's owner or an Admin, signed in. */
export function mayRecord(s: Pick<SessionView, "owner">, me: RespondMe | null): boolean {
  return isMine(s, me);
}

/** Whether the session still runs. A recording can be started only on one that does (SPEC 7.1). */
export const isLiveSession = (s: Pick<SessionView, "status">) => s.status !== "done";

/** One row of the picker: the orchestrator, then each agent and fork, with what it is. */
export interface PickRow {
  loop: string;
  label: string;
  detail: string;
}

/** The loops a person can choose among, from the session's agents. The orchestrator is first. */
export function pickRows(s: Pick<SessionView, "name" | "agents">): PickRow[] {
  const byId = new Map(s.agents.map((a) => [a.id, a]));
  const parent = (a: AgentView) => {
    const p = a.parentId && a.parentId !== a.id ? byId.get(a.parentId) : undefined;
    return p ? p.description : "the orchestrator";
  };
  return [
    { loop: MAIN_LOOP, label: s.name, detail: "The orchestrator" },
    ...s.agents.map((a) => ({
      loop: a.id,
      label: a.description,
      detail: a.kind === "fork" ? `Fork of ${parent(a)}` : `Agent, launched by ${parent(a)}`,
    })),
  ];
}

/** A list in words: "a", "a and b", "a, b and c". */
export function joinWords(list: readonly string[]): string {
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** The names of the recorded loops and of the ones that are not. */
export function loopNames(loops: readonly RecordingLoopInfo[]): { recorded: string[]; not: string[] } {
  return { recorded: loops.filter((l) => l.recorded).map((l) => l.name), not: loops.filter((l) => !l.recorded).map((l) => l.name) };
}

const startedBy = (v: Pick<RecordingView, "startedBy">) => v.startedBy ?? "Someone";

/** The card's recording band: a head and a small line under it. Nothing for a recording that is only kept. */
export function bandWords(v: RecordingView, now: number): { head: string; small: string } | null {
  if (v.state !== "recording") return null;
  const names = loopNames(v.loops);
  const all = v.loops.length;
  const until = v.keptUntil !== null ? ` Deleted at ${fmtWhen(v.keptUntil, now, false)}.` : "";
  if (!v.ownerAllows) return { head: "Recording chosen, nothing captured", small: `${startedBy(v)} started it, but the owner has not allowed it in the reporter.${until}` };
  if (names.recorded.length >= all) return { head: "Recording everything", small: `${startedBy(v)} started it.${until}` };
  return { head: `Recording ${names.recorded.length} of ${all} ${all === 1 ? "loop" : "loops"}`, small: `${joinWords(names.recorded)}. ${startedBy(v)} started it.${until}` };
}

/** Who stopped a kept recording and why, after "This session was recorded.". */
export function stoppedWords(v: RecordingView, ended: boolean): string {
  if (v.state === "limit") return v.limit === "budget" ? "The disk budget was reached, so recording stopped." : "It reached the limit for one session, so recording stopped.";
  if (v.stoppedBy) return `${v.stoppedBy} stopped the recording${v.stoppedAt !== null ? ` at ${fmtAt(v.stoppedAt)}` : ""}.`;
  return ended ? "The session ended." : "Recording stopped.";
}

/** The replay header's line: when it was recorded, by whom, why it ended, and when it goes. */
export function replayLine(g: RecordingGrant, ended: boolean, now: number): string {
  const from = g.startedAt !== null ? fmtAt(g.startedAt) : null;
  const to = g.stoppedAt !== null ? fmtAt(g.stoppedAt) : null;
  const span = from && to ? `Recorded ${from} to ${to}.` : from ? `Recorded from ${from}${g.startedBy ? ` by ${g.startedBy}` : ""}.` : "Recorded.";
  let why = "";
  if (g.state === "limit") why = ` It stopped at the ${g.limit === "budget" ? "disk budget" : "limit for one session"}, so later work was not kept.`;
  else if (g.state === "stopped") why = g.stoppedBy ? ` ${g.stoppedBy} stopped it, so nothing after ${to ?? "that"} was kept.` : " The session ended.";
  else if (ended) why = " The session ended.";
  const gone = g.keptUntil !== null ? ` Deleted at ${fmtWhen(g.keptUntil, now)}.` : "";
  return `${span}${why}${gone}`;
}

/** The Recording cell's value when it is not a button, and its title. */
export function cellWords(v: RecordingView, now: number): { text: string; title: string } {
  const until = v.keptUntil !== null ? fmtWhen(v.keptUntil, now) : null;
  if (v.state === "recording") {
    if (!v.ownerAllows) return { text: "Chosen", title: "Chosen, but the owner has not turned on sessionRecording in the reporter, so nothing is captured." };
    return { text: "Recording", title: `Recording.${until ? ` Deleted at ${until}.` : ""}` };
  }
  return { text: v.keptUntil !== null ? `Kept until ${fmtWhen(v.keptUntil, now, false)}` : "Kept", title: `Capture has ended. The recording is kept${until ? ` until ${until}` : ""}, then deleted.` };
}

/** Opens a session's replay. The entry it pushes is marked, so Back from the replay returns to the page it was opened from. */
export function openReplay(id: string): void {
  window.history.pushState({ replay: true }, "", replayHash(id));
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** Leaves a replay: Back when the console pushed it, otherwise the session's page (or History's, for one that ended). */
export function leaveReplay(id: string, live: boolean): void {
  if ((window.history.state as { replay?: boolean } | null)?.replay) {
    window.history.back();
    return;
  }
  window.location.hash = live ? fleetHash(id) : `#/history?open=${encodeURIComponent(id)}`;
}

/** What the picker says, from what the Record button knows. */
export type PickerState = "ok" | "started" | "noown" | "adminoff" | "other" | "signin" | "ended";

export function pickerState(opts: {
  flagOn: boolean;
  me: RespondMe | null;
  s: Pick<SessionView, "owner" | "status" | "recording">;
  grant: RecordingGrant | null;
  /** What the server said before Start about the owner's `sessionRecording` option; null when it has not said (yet). */
  ownerAllows?: boolean | null;
}): PickerState {
  const { flagOn, me, s, grant } = opts;
  if (!flagOn) return "adminoff";
  if (!me?.signedIn) return "signin";
  if (!isMine(s, me)) return "other";
  if (!isLiveSession(s)) return "ended";
  if (grant && !grant.consent.owner) return "noown";
  if (!grant && opts.ownerAllows === false) return "noown";
  if (!grant && s.recording && s.recording.state === "recording" && !s.recording.ownerAllows) return "noown";
  if (grant && grant.state === "recording") return "started";
  return "ok";
}
