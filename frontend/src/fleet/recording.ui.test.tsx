// Session recording on the wall and the orchestrator page (#353, mockup/podium-recording.html): the card's band, the Recording
// cell, the picker, and the layer with Stop, Open replay and Delete recording.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { FocusView } from "./components/FocusView";
import { RecordPicker } from "./components/RecordPicker";
import { RecordingLayer } from "./components/RecordingLayer";
import { SessionCard } from "./components/SessionCard";
import { TopBarSignIn } from "./components/SignIn";
import { makeAgent, makeRecording, makeSession } from "./fixtures";
import { RespondError, type RespondApi } from "./respondApi";
import { RespondProvider } from "./useRespond";
import type { RecordingGrant, RespondMe, SessionView } from "./types";

const at = (h: number, m: number) => new Date(2026, 9, 20, h, m).getTime();
const NOW = at(12, 0);
const CFG = { staleAfterMs: 15_000, dropAfterMs: 60_000, lingerMs: 8_000, detachedHideAfterMs: 60_000 };
const ME: RespondMe = { enabled: true, signedIn: true, name: "Ed", admin: false };
const OUT: RespondMe = { enabled: true, signedIn: false, name: null, admin: false };

const grantOf = (loops: string[], over: Partial<RecordingGrant> = {}): RecordingGrant => ({
  state: "recording",
  consent: { admin: true, chosen: true, owner: true },
  loops,
  limit: null,
  startedBy: "Ed",
  startedAt: at(11, 42),
  stoppedBy: null,
  stoppedAt: null,
  keptUntil: at(17, 42),
  bytes: 0,
  ...over,
});

function fakeApi(over: Partial<RespondApi> = {}, me: RespondMe = ME) {
  return {
    me: vi.fn(async () => me),
    signIn: vi.fn(async () => ({ ok: true as const, name: "Ed", admin: false })),
    signOut: vi.fn(async () => ({ ok: true as const })),
    ask: vi.fn(),
    answer: vi.fn(),
    message: vi.fn(),
    discard: vi.fn(),
    recordingStart: vi.fn(async (_id: string, loops: string[]) => ({ ok: true as const, grant: grantOf(loops) })),
    recordingStop: vi.fn(async () => ({ ok: true as const, grant: grantOf([], { state: "stopped" }) })),
    recordingDelete: vi.fn(async () => ({ ok: true as const, entries: 3, bytes: 100 })),
    ...over,
  } as unknown as RespondApi & { recordingStart: ReturnType<typeof vi.fn>; recordingStop: ReturnType<typeof vi.fn>; recordingDelete: ReturnType<typeof vi.fn> };
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });

const AGENTS = [makeAgent({ id: "p", description: "Port the endpoints" }), makeAgent({ id: "f", parentId: "p", kind: "fork", description: "Try the second approach" })];

async function page(over: Partial<SessionView> = {}, opts: { api?: ReturnType<typeof fakeApi>; on?: boolean; provider?: boolean } = {}) {
  const api = opts.api ?? fakeApi();
  const s = makeSession({ owner: "Ed", agents: AGENTS, ...over });
  const view = <FocusView s={s} now={NOW} config={CFG} sort={{ key: null, dir: 1 }} onSort={() => {}} selectedAgent={null} flashAgent={null} onAgent={() => {}} />;
  const out = render(opts.provider === false ? view : <RespondProvider api={api} flagsOn={false} recordingOn={opts.on ?? true}>{view}</RespondProvider>);
  await flush();
  return { ...out, api, s };
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "#/");
});

const cell = (container: HTMLElement) => container.querySelector<HTMLElement>(".fact.rec")!;

describe("the card's recording band", () => {
  const card = (rec: SessionView["recording"]) => render(<SessionCard s={makeSession({ recording: rec })} now={NOW} config={CFG} entering={false} leaving={false} onOpen={() => {}} />).container;

  it("shows a second band with the words and who started it while a recording captures, with no way to close it", () => {
    const c = card(makeRecording());
    const band = c.querySelector(".band.recording")!;
    expect(band.textContent).toContain("Recording 2 of 3 loops");
    expect(band.textContent).toContain("Maya Okafor started it");
    expect(band.querySelector(".dot")).not.toBeNull();
    expect(band.querySelector("button, [role='switch']")).toBeNull();
    expect(c.querySelectorAll(".band")).toHaveLength(2);
  });

  it("shows no recording band for a card that is not recorded, or one whose recording is only kept", () => {
    expect(card(null).querySelector(".band.recording")).toBeNull();
    expect(card(makeRecording({ state: "stopped" })).querySelector(".band.recording")).toBeNull();
  });
});

describe("the Recording cell", () => {
  it("is the last of twelve and a button, like Resume and Fork, while the session is not recorded", async () => {
    const { container } = await page();
    const cells = [...container.querySelectorAll(".facts > .fact")];
    expect(cells).toHaveLength(12);
    expect(cells[11]).toBe(cell(container));
    const b = within(cell(container)).getByRole("button", { name: "Record this session" });
    expect(b.textContent).toBe("RecordingRecord");
    expect(cell(container)).toHaveClass("copy");
    expect(cell(container).querySelector(".rec-i")).not.toHaveClass("live", "kept");
  });

  it("states the recording in shape, word and color, with a pulsing disc only while it records", async () => {
    const { container } = await page({ recording: makeRecording() });
    expect(cell(container).querySelector(".v")).toHaveClass("recording");
    expect(cell(container).textContent).toBe("RecordingRecording");
    expect(cell(container).querySelector(".rec-i")).toHaveClass("live");
    expect(cell(container).getAttribute("title")).toBe("Recording. Deleted at 17:42 today.");
    expect(within(cell(container)).queryByRole("button")).toBeNull();
  });

  it("shows a ring without a disc when the recording is only kept, and an idle disc when the owner has not allowed it", async () => {
    const kept = await page({ recording: makeRecording({ state: "stopped" }) });
    expect(cell(kept.container).textContent).toBe("RecordingKept until 17:42");
    expect(cell(kept.container).querySelector(".rec-i")).toHaveClass("kept");
    expect(cell(kept.container).querySelector(".v")).not.toHaveClass("recording");
    cleanup();
    const chosen = await page({ recording: makeRecording({ ownerAllows: false }) });
    expect(cell(chosen.container).textContent).toBe("RecordingChosen");
    expect(cell(chosen.container).querySelector(".rec-i")).not.toHaveClass("live", "kept");
  });

  it("reads Not recorded, without a button, when the Admin's flag is off, when there is no sign-in state, and for a session that ended", async () => {
    for (const run of [() => page({}, { on: false }), () => page({}, { provider: false }), () => page({ status: "done" })]) {
      const { container } = await run();
      expect(cell(container).textContent).toBe("RecordingNot recorded");
      expect(within(cell(container)).queryByRole("button")).toBeNull();
      cleanup();
    }
    const off = await page({}, { on: false });
    expect(cell(off.container).getAttribute("title")).toMatch(/off on this server/);
    cleanup();
    const done = await page({ status: "done" });
    expect(cell(done.container).getAttribute("title")).toMatch(/ended without being recorded/);
  });
});

describe("the picker", () => {
  const open = async (over: Partial<SessionView> = {}, opts: Parameters<typeof page>[1] = {}) => {
    const out = await page(over, opts);
    const button = within(cell(out.container)).getByRole("button", { name: "Record this session" });
    fireEvent.click(button);
    return { ...out, button, dialog: screen.getByRole("dialog", { name: "Record this session" }) };
  };

  it("lists the orchestrator and each agent and fork with a box, all ticked, and names what is kept", async () => {
    const { dialog } = await open();
    const rows = within(dialog).getAllByRole("checkbox");
    expect(rows.map((r) => (r as HTMLInputElement).checked)).toEqual([true, true, true]);
    expect(within(dialog).getByText("The orchestrator")).toBeInTheDocument();
    expect(within(dialog).getByText("Agent, launched by the orchestrator")).toBeInTheDocument();
    expect(within(dialog).getByText("Fork of Port the endpoints")).toBeInTheDocument();
    expect(dialog.textContent).toMatch(/Nothing before it is kept/);
    expect(dialog.textContent).toMatch(/Prompts, file contents, command output and tool results/);
    expect(screen.getByText(/orchestrator, refactor\/invoice-v2/)).toBeInTheDocument();
  });

  it("starts with the loops that are ticked and says when it started", async () => {
    const { dialog, api, s } = await open();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Try the second approach/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Start recording" }));
    await flush();
    expect(api.recordingStart).toHaveBeenCalledWith(s.id, ["@orchestrator", "p"]);
    expect(dialog.textContent).toMatch(/Recording started at 11:42\./);
    expect(dialog.textContent).toMatch(/Recording api-refactor, Port the endpoints\./);
    expect(dialog.textContent).toMatch(/Nothing before now was kept/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("will not start with nothing ticked", async () => {
    const { dialog, api } = await open();
    for (const box of within(dialog).getAllByRole("checkbox")) fireEvent.click(box);
    expect(within(dialog).getByRole("button", { name: "Start recording" })).toBeDisabled();
    expect(api.recordingStart).not.toHaveBeenCalled();
  });

  it("says what went wrong, and what to try, when Start is refused", async () => {
    const api = fakeApi({ recordingStart: vi.fn(async () => { throw new RespondError(409, { error: "the recording stopped for its limit; delete it to start again" }); }) });
    const { dialog } = await open({}, { api });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start recording" }));
    await flush();
    expect(within(dialog).getByRole("alert").textContent).toBe("Could not start the recording: the recording stopped for its limit; delete it to start again. Try again.");
    expect(within(dialog).getByRole("button", { name: "Start recording" })).not.toBeDisabled();
  });

  it("names the sessionRecording option, with nothing to press, when the owner has not allowed it", async () => {
    const api = fakeApi({ recordingStart: vi.fn(async (_id: string, loops: string[]) => ({ ok: true as const, grant: grantOf(loops, { consent: { admin: true, chosen: true, owner: false } }) })) });
    const { dialog } = await open({}, { api });
    fireEvent.click(within(dialog).getByRole("button", { name: "Start recording" }));
    await flush();
    expect(dialog.textContent).toMatch(/does not allow recording/);
    expect(dialog.textContent).toMatch(/Ed has not turned on the sessionRecording option/);
    expect(dialog.textContent).toMatch(/\/plugin configure podium-reporter@eengelking-marketplace/);
    expect(within(dialog).getByRole("button", { name: "Start recording" })).toBeDisabled();
    for (const box of within(dialog).getAllByRole("checkbox")) expect(box).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says up front, before Start, that the owner has not allowed it, when the server says so", async () => {
    const recordingConsent = vi.fn(async () => ({ ok: true as const, grant: grantOf([], { state: "off", consent: { admin: true, chosen: false, owner: false } }) }));
    const api = fakeApi({ recordingConsent });
    const { dialog, s } = await open({}, { api });
    await flush();
    expect(recordingConsent).toHaveBeenCalledWith(s.id);
    expect(dialog.textContent).toMatch(/does not allow recording/);
    expect(within(dialog).getByRole("button", { name: "Start recording" })).toBeDisabled();
    expect(api.recordingStart).not.toHaveBeenCalled();
  });

  it("offers Start as usual when the server says the owner allows it, and when the consent cannot be read", async () => {
    const yes = fakeApi({ recordingConsent: vi.fn(async () => ({ ok: true as const, grant: grantOf([], { state: "off", consent: { admin: true, chosen: false, owner: true } }) })) });
    const first = await open({}, { api: yes });
    await flush();
    expect(within(first.dialog).getByRole("button", { name: "Start recording" })).not.toBeDisabled();
    fireEvent.click(within(first.dialog).getByRole("button", { name: "Cancel" }));
    const broken = fakeApi({ recordingConsent: vi.fn(async () => { throw new RespondError(500, { error: "boom" }); }) });
    const second = await open({}, { api: broken });
    await flush();
    expect(within(second.dialog).getByRole("button", { name: "Start recording" })).not.toBeDisabled();
  });

  it("states the Admin's keep time in What is kept, and no number while it is unknown", async () => {
    const consent = (keepHours?: number) => vi.fn(async () => ({ ok: true as const, keepHours, grant: grantOf([], { state: "off", consent: { admin: true, chosen: false, owner: true } }) }));
    const known = await open({}, { api: fakeApi({ recordingConsent: consent(48) }) });
    await flush();
    expect(known.dialog.textContent).toMatch(/kept for 48 hours, then deleted/);
    fireEvent.click(within(known.dialog).getByRole("button", { name: "Cancel" }));
    const one = await open({}, { api: fakeApi({ recordingConsent: consent(1) }) });
    await flush();
    expect(one.dialog.textContent).toMatch(/kept for 1 hour, then deleted/);
    fireEvent.click(within(one.dialog).getByRole("button", { name: "Cancel" }));
    const unknown = await open({}, { api: fakeApi({ recordingConsent: consent(undefined) }) });
    await flush();
    expect(unknown.dialog.textContent).toMatch(/kept for the time the Admin set, then deleted/);
    expect(unknown.dialog.textContent).not.toMatch(/6 hours/);
  });

  it("keeps Escape, focus and the opener as the app's modal does", async () => {
    const { button } = await open();
    expect(screen.getByRole("button", { name: "Close (Esc)" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button).toHaveFocus();
  });

  it("tells a viewer who is not the owner what they can and cannot do", async () => {
    const { dialog } = await open({ owner: "Maya" });
    expect(dialog.textContent).toMatch(/Only the session's owner or an Admin can choose what to record/);
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
  });

  it("lets an Admin choose what to record in someone else's session", async () => {
    const api = fakeApi({}, { enabled: true, signedIn: true, name: "Priya", admin: true });
    const { dialog } = await open({ owner: "Maya" }, { api });
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(3);
  });

  it("asks a viewer who is signed out to sign in", async () => {
    const { dialog } = await open({}, { api: fakeApi({}, OUT) });
    expect(dialog.textContent).toMatch(/Sign in to choose what to record/);
  });
});

describe("the layer above the band", () => {
  const layer = (container: HTMLElement) => container.querySelector<HTMLElement>(".rec-bar")!;

  it("sits between the facts and the status band, and says what is kept, who started it, what is and is not recorded, and when it goes", async () => {
    const { container } = await page({ recording: makeRecording() });
    const surface = container.querySelector(".osum")!;
    expect([...surface.children].map((e) => e.className.split(" ")[0])).toEqual(["fh", "facts", "rec-bar", "band"]);
    const text = layer(container).textContent!;
    expect(text).toContain("This session is being recorded.");
    expect(text).toContain("prompts, file contents, command output and results");
    expect(text).toContain("Recording: api-refactor and schema-writer.");
    expect(text).toContain("Not recorded: docs-agent.");
    expect(text).toContain("Maya Okafor started it at 11:42.");
    expect(text).toContain("The oldest part is deleted at 17:42 today.");
    expect(layer(container).querySelector(".dot")).not.toBeNull();
    expect(layer(container).getAttribute("role")).toBe("status");
  });

  it("leaves out Not recorded when every loop is recorded, and the time when nothing is kept", async () => {
    const loops = makeRecording().loops.map((l) => ({ ...l, recorded: true }));
    const { container } = await page({ recording: makeRecording({ loops, keptUntil: null, startedBy: null, startedAt: null }) });
    expect(layer(container).textContent).not.toMatch(/Not recorded/);
    expect(layer(container).textContent).not.toMatch(/deleted at/);
    expect(layer(container).textContent).toContain("Someone started it.");
  });

  it("says nothing is captured when the owner has not allowed it", async () => {
    const { container } = await page({ recording: makeRecording({ ownerAllows: false }) });
    expect(layer(container).textContent).toMatch(/Recording is chosen, but nothing is captured\. Ed has not turned on the sessionRecording option/);
    expect(layer(container).textContent).toMatch(/Maya Okafor chose it at 11:42/);
    const none = await page({ owner: null, recording: makeRecording({ ownerAllows: false, startedAt: null, startedBy: null }) });
    expect(layer(none.container).textContent).toMatch(/The owner has not turned on/);
  });

  it("is plain text, with no buttons, for a viewer who is not the owner or an Admin, and when there is no sign-in state", async () => {
    const other = await page({ owner: "Maya", recording: makeRecording() });
    expect(within(layer(other.container)).queryByRole("button")).toBeNull();
    cleanup();
    const bare = await page({ recording: makeRecording() }, { provider: false });
    expect(within(layer(bare.container)).queryByRole("button")).toBeNull();
    expect(layer(bare.container).textContent).toContain("This session is being recorded.");
  });

  it("has no X and no switch: consent cannot be dismissed", async () => {
    const { container } = await page({ recording: makeRecording() });
    expect(layer(container).querySelector("[role='switch'], .x, [aria-label*='Close']")).toBeNull();
  });

  it("asks before it stops, then stops, and Escape or Cancel keeps it", async () => {
    const { container, api, s } = await page({ recording: makeRecording() });
    const l = within(layer(container));
    fireEvent.click(l.getByRole("button", { name: "Stop recording" }));
    const box = l.getByRole("alertdialog", { name: "Stop recording this session?" });
    expect(box.textContent).toMatch(/Capture ends now for the orchestrator and every agent and fork\. What was recorded until now is kept until 17:42 today/);
    expect(within(box).getByRole("button", { name: "Stop recording" })).toHaveFocus();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(l.queryByRole("alertdialog")).toBeNull();
    expect(api.recordingStop).not.toHaveBeenCalled();
    expect(l.getByRole("button", { name: "Stop recording" })).toHaveFocus();
    fireEvent.click(l.getByRole("button", { name: "Stop recording" }));
    fireEvent.click(l.getByRole("button", { name: "Cancel" }));
    expect(api.recordingStop).not.toHaveBeenCalled();
    fireEvent.click(l.getByRole("button", { name: "Stop recording" }));
    fireEvent.click(within(l.getByRole("alertdialog")).getByRole("button", { name: "Stop recording" }));
    await flush();
    expect(api.recordingStop).toHaveBeenCalledWith(s.id);
    expect(l.queryByRole("alertdialog")).toBeNull();
  });

  it("asks before it deletes, and the session page loses the layer once it is gone", async () => {
    const { container, api, s } = await page({ recording: makeRecording() });
    const l = within(layer(container));
    fireEvent.click(l.getByRole("button", { name: "Delete recording" }));
    const box = l.getByRole("alertdialog", { name: "Delete this recording?" });
    expect(box.textContent).toMatch(/The whole recording, 18\.0 MB, is removed for good\. Capture stops if it is still running\./);
    expect(box.textContent).toMatch(/written to the Admin log/);
    fireEvent.click(within(box).getByRole("button", { name: "Delete recording" }));
    await flush();
    expect(api.recordingDelete).toHaveBeenCalledWith(s.id);
    expect(container.querySelector(".rec-bar")).toBeNull();
  });

  it("shows the layer again for a recording started on the same session after a delete", async () => {
    const api = fakeApi();
    const tree = (startedAt: number) => (
      <RespondProvider api={api} flagsOn={false} recordingOn>
        <RecordingLayer s={makeSession({ id: "s1", owner: "Ed", recording: makeRecording({ startedAt }) })} now={NOW} />
      </RespondProvider>
    );
    const out = render(tree(at(11, 42)));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Delete recording" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete recording" }));
    await flush();
    expect(out.container.querySelector(".rec-bar")).toBeNull();
    out.rerender(tree(at(11, 42))); // the same recording is still hidden
    expect(out.container.querySelector(".rec-bar")).toBeNull();
    out.rerender(tree(at(11, 55))); // a new one has a new start
    expect(out.container.querySelector(".rec-bar")).not.toBeNull();
  });

  it("says what went wrong when a change is refused, and keeps the layer", async () => {
    const api = fakeApi({
      recordingStop: vi.fn(async () => { throw new RespondError(401, { error: "sign in" }); }),
      recordingDelete: vi.fn(async () => { throw new RespondError(500, { error: "could not delete the recording" }); }),
    });
    const { container } = await page({ recording: makeRecording() }, { api });
    const l = within(layer(container));
    fireEvent.click(l.getByRole("button", { name: "Stop recording" }));
    fireEvent.click(within(l.getByRole("alertdialog")).getByRole("button", { name: "Stop recording" }));
    await flush();
    expect(l.getByRole("alert").textContent).toBe("Could not stop the recording: you are signed out. Sign in and try again.");
    fireEvent.click(l.getByRole("button", { name: "Delete recording" }));
    fireEvent.click(within(l.getByRole("alertdialog")).getByRole("button", { name: "Delete recording" }));
    await flush();
    expect(l.getByRole("alert").textContent).toBe("Could not delete the recording: could not delete the recording. Try again.");
  });

  it("says a forbidden change is for the owner or an Admin, and names a missing recording", async () => {
    const forbidden = fakeApi({ recordingStop: vi.fn(async () => { throw new RespondError(403, {}); }), recordingDelete: vi.fn(async () => { throw new RespondError(404, { error: "this session has no recording" }); }) });
    const { container } = await page({ recording: makeRecording() }, { api: forbidden });
    const l = within(layer(container));
    fireEvent.click(l.getByRole("button", { name: "Stop recording" }));
    fireEvent.click(within(l.getByRole("alertdialog")).getByRole("button", { name: "Stop recording" }));
    await flush();
    expect(l.getByRole("alert").textContent).toMatch(/only the session's owner or an Admin can/);
    fireEvent.click(l.getByRole("button", { name: "Delete recording" }));
    fireEvent.click(within(l.getByRole("alertdialog")).getByRole("button", { name: "Delete recording" }));
    await flush();
    expect(l.getByRole("alert").textContent).toBe("Could not delete the recording: this session has no recording.");
  });

  it("falls back to a plain sentence when the server cannot be reached", async () => {
    const api = fakeApi({ recordingStop: vi.fn(async () => { throw new Error("offline"); }) });
    const { container } = await page({ recording: makeRecording() }, { api });
    const l = within(layer(container));
    fireEvent.click(l.getByRole("button", { name: "Stop recording" }));
    fireEvent.click(within(l.getByRole("alertdialog")).getByRole("button", { name: "Stop recording" }));
    await flush();
    expect(l.getByRole("alert").textContent).toBe("Could not stop the recording. Try again.");
  });

  it("opens the replay at its own address, on an entry that Back returns from", async () => {
    const { container } = await page({ recording: makeRecording() });
    fireEvent.click(within(layer(container)).getByRole("button", { name: "Open replay" }));
    expect(window.location.hash).toBe("#/?open=s1&replay");
    expect(window.history.state).toEqual({ replay: true });
  });

  describe("once capture has ended", () => {
    it("is the neutral layer with a ring, Open replay and Delete recording, and no Stop", async () => {
      const { container } = await page({ recording: makeRecording({ state: "stopped", stoppedBy: "Maya Okafor", stoppedAt: at(13, 2) }) });
      expect(layer(container)).toHaveClass("kept");
      const text = layer(container).textContent!;
      expect(text).toContain("This session was recorded.");
      expect(text).toContain("Maya Okafor stopped the recording at 13:02.");
      expect(text).toContain("What was recorded, 18.0 MB, is kept for troubleshooting until 17:42 today, then deleted. Only the owner and an Admin can open it.");
      const l = within(layer(container));
      expect(l.queryByRole("button", { name: "Stop recording" })).toBeNull();
      expect(l.getByRole("button", { name: "Open replay" })).toBeInTheDocument();
      fireEvent.click(l.getByRole("button", { name: "Delete recording" }));
      expect(l.getByRole("alertdialog").textContent).not.toMatch(/Capture stops/);
    });

    it("shows an ended session's final state with the layer, and says the session ended", async () => {
      const { container } = await page({ status: "done", recording: makeRecording({ state: "stopped" }) });
      expect(layer(container).textContent).toContain("The session ended.");
      expect(container.querySelector(".osum .band")).toHaveClass("done");
    });

    it("says why a recording stopped at its limit", async () => {
      const { container } = await page({ recording: makeRecording({ state: "limit", limit: "session" }) });
      expect(layer(container).textContent).toMatch(/It reached the limit for one session, so recording stopped\./);
      expect(layer(container).textContent).toContain("Only the owner and an Admin can open it.");
    });

    it("leaves out the time when none is kept", async () => {
      const { container } = await page({ recording: makeRecording({ state: "stopped", keptUntil: null }) });
      expect(layer(container).textContent).toMatch(/is kept for troubleshooting, then deleted/);
    });

    it("reads times against today, even when History opens the session as it ended", async () => {
      const { container } = await page({ status: "done", lastSeenAt: 1_000, recording: makeRecording({ state: "stopped" }) });
      expect(layer(container).textContent).toContain("until 17:42 today");
    });
  });

  it("lets an Admin stop a recording in someone else's session", async () => {
    const api = fakeApi({}, { enabled: true, signedIn: true, name: "Priya", admin: true });
    const { container } = await page({ owner: "Maya", recording: makeRecording() }, { api });
    expect(within(layer(container)).getByRole("button", { name: "Stop recording" })).toBeInTheDocument();
  });
});

describe("the picker's other states", () => {
  const show = async (s: SessionView, on: boolean) => {
    const onClose = vi.fn();
    render(
      <RespondProvider api={fakeApi()} flagsOn={false} recordingOn={on}>
        <RecordPicker s={s} onClose={onClose} />
      </RespondProvider>,
    );
    await flush();
    return { dialog: screen.getByRole("dialog", { name: "Record this session" }), onClose };
  };

  it("says the feature is off, with where an Admin turns it on, and has nothing to press but Close", async () => {
    const { dialog, onClose } = await show(makeSession({ owner: "Ed" }), false);
    expect(dialog.textContent).toMatch(/Session recording is off on this server\. An Admin turns it on in Admin > Settings > Feature flags\. Until then nothing is captured, stored or sent\./);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
  });

  it("says a session that ended cannot be started", async () => {
    const { dialog } = await show(makeSession({ owner: "Ed", status: "done" }), true);
    expect(dialog.textContent).toMatch(/This session has ended\. A recording can be started only on a session that is running\./);
  });
});

describe("signing in to record", () => {
  it("asks who is signed in when only recording is on, and the dialog talks about recordings", async () => {
    const api = fakeApi({}, OUT);
    render(
      <RespondProvider api={api} flagsOn={false} recordingOn>
        <TopBarSignIn />
      </RespondProvider>,
    );
    await flush();
    expect(api.me).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByText("To record, and to open the recordings of, your own sessions")).toBeInTheDocument();
    expect(screen.getByText(/can choose, open and delete a recording\./)).toBeInTheDocument();
    expect(screen.queryByText(/To answer and message/)).toBeNull();
  });

  it("keeps the other wording when something else is on too", async () => {
    render(
      <RespondProvider api={fakeApi({}, OUT)} flagsOn recordingOn>
        <TopBarSignIn />
      </RespondProvider>,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByText("To answer and message your own sessions")).toBeInTheDocument();
  });
});
