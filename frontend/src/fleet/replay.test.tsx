// A recording's replay (#353, mockup/podium-recording.html): the rows oldest first, a result under each call, the loop filter, the
// position slider, Jump to next failure, Show older, the refusals and the errors, and Delete recording.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FleetView } from "./FleetApp";
import { ReplayPage } from "./components/ReplayPage";
import { makeRecording, makeSession } from "./fixtures";
import { RespondError, type RespondApi } from "./respondApi";
import { stateFrom } from "./testState";
import { RespondProvider, useRespond } from "./useRespond";
import type { RecordingGrant, RecordingPage, RecordingRow, RespondMe } from "./types";

const at = (h: number, m: number, s = 0) => new Date(2026, 9, 20, h, m, s).getTime();
const NOW = at(12, 0);
const ME: RespondMe = { enabled: true, signedIn: true, name: "Ed", admin: false };

const grant = (over: Partial<RecordingGrant> = {}): RecordingGrant => ({
  state: "stopped",
  consent: { admin: true, chosen: true, owner: true },
  loops: ["@orchestrator", "p"],
  limit: null,
  startedBy: "Maya Okafor",
  startedAt: at(11, 42),
  stoppedBy: "Maya Okafor",
  stoppedAt: at(13, 2),
  keptUntil: at(17, 42),
  bytes: 18 * 1024 * 1024,
  ...over,
});

let n = 0;
const row = (over: Partial<RecordingRow>): RecordingRow => ({ n: ++n, seq: n, loop: "@orchestrator", at: at(11, 42), kind: "text", text: "", ...over });
const LONG_RESULT = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");

const rows = (): RecordingRow[] => [
  row({ kind: "prompt", text: "Migrate invoices to v2 schema.", at: at(11, 42) }),
  row({ kind: "thinking", at: at(11, 43) }),
  row({ kind: "text", text: "I will read the schema first, then hand the port to an agent.", at: at(11, 43, 20) }),
  row({ kind: "tool", name: "Read", text: "server/src/invoices/schema.ts", at: at(11, 44) }),
  row({ kind: "result", name: "Read", text: LONG_RESULT, at: at(11, 44, 2) }),
  row({ kind: "tool", name: "Bash", text: "npm test -w server -- invoices\nsecond line", loop: "p", at: at(11, 47) }),
  row({ kind: "result", name: "Bash", text: "FAIL list.test.ts\nTests: 1 failed", failed: true, loop: "p", at: at(11, 47, 30) }),
  row({ kind: "compact", at: at(12, 5) }),
  row({ kind: "text", text: "Done.", at: at(13, 2, 5) }),
  row({ kind: "stopped", by: "Maya Okafor", at: at(13, 2) }),
];

const LOOPS = [
  { loop: "@orchestrator", name: "api-refactor", recorded: true },
  { loop: "p", name: "a-very-long-agent-name-that-has-to-be-cut-in-a-row", recorded: true },
];

const pageOf = (over: Partial<RecordingPage> = {}): RecordingPage => ({ entries: rows(), olderBefore: null, total: 10, grant: grant(), loops: LOOPS, owner: "Ed", ...over });

function fakeApi(over: Partial<RespondApi> = {}) {
  return {
    me: vi.fn(async () => ME),
    signIn: vi.fn(),
    signOut: vi.fn(),
    ask: vi.fn(),
    answer: vi.fn(),
    message: vi.fn(),
    discard: vi.fn(),
    recordingPage: vi.fn(async () => pageOf()),
    recordingDelete: vi.fn(async () => ({ ok: true as const, entries: 10, bytes: 100 })),
    ...over,
  } as unknown as RespondApi & { recordingPage: ReturnType<typeof vi.fn>; recordingDelete: ReturnType<typeof vi.fn> };
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });

async function replay(api = fakeApi(), opts: { session?: ReturnType<typeof makeSession> | null; provider?: boolean } = {}) {
  const session = opts.session === undefined ? makeSession({ id: "s1", name: "api-refactor", status: "running" }) : opts.session;
  const view = <ReplayPage id="s1" session={session} now={NOW} />;
  const out = render(opts.provider === false ? view : <RespondProvider api={api} flagsOn={false} recordingOn>{view}</RespondProvider>);
  await flush();
  return { ...out, api };
}

beforeEach(() => {
  n = 0;
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => null })));
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "#/");
});

const feed = (c: HTMLElement) => c.querySelector<HTMLOListElement>("ol.feed")!;
const lis = (c: HTMLElement) => [...feed(c).querySelectorAll<HTMLElement>(":scope > li")];

describe("the replay page", () => {
  it("names the session and says how it was recorded, and that thinking text is not available", async () => {
    const { container } = await replay();
    expect(container.querySelector("h1")!.textContent).toBe("api-refactor");
    expect(container.querySelector(".goal")!.textContent).toBe("Replay of a recording");
    expect(container.querySelector(".fh .sub")!.textContent).toBe("Recorded 11:42 to 13:02. Maya Okafor stopped it, so nothing after 13:02 was kept. Deleted at 17:42 today.");
    expect(container.querySelector(".fh p")!.textContent).toMatch(/The model's thinking text is not available\./);
    expect(container.querySelector(".fh p")!.textContent).toMatch(/An empty place does not mean it did not think\./);
  });

  it("lists the rows oldest first, each with the loop's name, a kind and the time since the loop began", async () => {
    const { container } = await replay();
    const first = lis(container)[0]!;
    expect(first.className).toContain("you");
    expect(first.querySelector(".at")!.textContent).toBe("00:00");
    expect(first.querySelector(".k")!.getAttribute("aria-label")).toBe("Prompt");
    expect(first.querySelector(".who")!.textContent).toBe("api-refactor:");
    expect(first.querySelector(".body")!.textContent).toBe("api-refactor:Migrate invoices to v2 schema.");
    expect(feed(container).getAttribute("aria-label")).toBe("Recorded activity, oldest first");
    expect(feed(container)).toHaveAttribute("tabindex", "0");
    expect(lis(container)).toHaveLength(8);
  });

  it("widens the time column to h:mm:ss once any row is an hour in", async () => {
    const { container } = await replay();
    expect(feed(container)).toHaveClass("hours");
    expect(lis(container)[lis(container).length - 2]!.querySelector(".at")!.textContent).toBe("1:20:05");
  });

  it("keeps the short column for a short run", async () => {
    const api = fakeApi({ recordingPage: vi.fn(async () => pageOf({ entries: rows().slice(0, 3), total: 3 })) as never });
    const { container } = await replay(api);
    expect(feed(container)).not.toHaveClass("hours");
  });

  it("marks where the model thought and says its text is not available", async () => {
    const { container } = await replay();
    const think = lis(container)[1]!;
    expect(think.querySelector(".k")!.getAttribute("aria-label")).toBe("Reasoning");
    expect(think.querySelector(".hint")!.textContent).toBe("Thinking: text is not available");
  });

  it("puts a collapsed result under each call, and the whole input behind a button when it runs to more lines", async () => {
    const { container } = await replay();
    const read = lis(container)[3]!;
    expect(read.className).toContain("tool");
    expect(read.querySelector(".name")!.textContent).toBe("Read");
    expect(read.querySelector(".arg")!.textContent).toBe("server/src/invoices/schema.ts");
    const res = read.querySelector<HTMLDetailsElement>("details.res")!;
    expect(res.open).toBe(false);
    expect(res.querySelector("summary")!.textContent).toBe("Result");
    expect(res.querySelector("pre.code")!.textContent).toBe(LONG_RESULT);
    const bash = lis(container)[4]!;
    expect(bash.querySelector(".arg")!.textContent).toBe("npm test -w server -- invoices…");
    expect(bash.querySelector("details.res summary")!.textContent).toBe("Whole input (42 characters)");
  });

  it("draws a failed call in the failure box, with the call and the tail of its output", async () => {
    const { container } = await replay();
    const bash = lis(container)[4]!;
    const box = bash.querySelector(".failbox")!;
    expect(box.querySelector(".fh2")!.textContent).toBe("Bash failed");
    expect(box.textContent).toContain("Failing call · Bash");
    expect(box.querySelectorAll("pre.code")[0]!.textContent).toBe("npm test -w server -- invoices");
    expect(box.querySelectorAll("pre.code")[1]!.textContent).toBe("FAIL list.test.ts\nTests: 1 failed");
    expect(bash.querySelector("details.res summary")).not.toBeNull();
  });

  it("marks a compaction and a stop as rows of their own, the stop in Podium's voice", async () => {
    const { container } = await replay();
    const marks = lis(container).filter((l) => l.classList.contains("mark"));
    expect(marks.map((m) => m.querySelector(".body")!.textContent)).toEqual(["api-refactor:The conversation was compacted to fit the context window.", "Podium:Recording stopped by Maya Okafor. Everything up to here was kept."]);
  });

  it("says the replay is read-only and where the recording goes", async () => {
    const { container } = await replay();
    expect(container.querySelector(".sh .src")!.textContent).toMatch(/Oldest first\. Read-only: a replay never runs anything or sends anything to the session\./);
    expect(container.textContent).toContain("Kept until 17:42 today, then deleted. Only the owner and an Admin can open it.");
    expect(container.textContent).toContain("Showing all 10");
  });

  it("collapses a long text and shows all of it on request", async () => {
    const long = "word ".repeat(300);
    const api = fakeApi({ recordingPage: vi.fn(async () => pageOf({ entries: [row({ kind: "text", text: long })] })) as never });
    const { container } = await replay(api);
    const li = lis(container)[0]!;
    expect(li.querySelector(".body")!.textContent).toContain("…");
    expect(li.querySelector("details summary")!.textContent).toBe("Whole text (1,500 characters)");
    expect(li.querySelector("details pre")!.textContent).toBe(long);
  });

  it("stands a result whose call is on an older page as a row of its own", async () => {
    const api = fakeApi({ recordingPage: vi.fn(async () => pageOf({ entries: [row({ kind: "result", name: "Bash", text: "boom", failed: true })] })) as never });
    const { container } = await replay(api);
    expect(lis(container)[0]!.textContent).toContain("result of a call on an older page");
    expect(lis(container)[0]!.querySelector("details.res summary")!.textContent).toBe("Result (failed)");
  });

  it("names a loop it does not know by its id", async () => {
    const api = fakeApi({ recordingPage: vi.fn(async () => pageOf({ entries: [row({ kind: "text", text: "hi", loop: "zz" })], loops: [] })) as never });
    const { container } = await replay(api);
    expect(lis(container)[0]!.querySelector(".who")!.textContent).toBe("zz:");
  });

  it("cuts a long loop name in the filter and keeps the whole name as its title", async () => {
    await replay();
    const opt = screen.getByRole("option", { name: /a-very-long-agent/ }) as HTMLOptionElement;
    expect(opt.textContent!.length).toBe(28);
    expect(opt.textContent!.endsWith("…")).toBe(true);
    expect(opt.title).toBe("a-very-long-agent-name-that-has-to-be-cut-in-a-row");
  });
});

describe("rows sent from Podium", () => {
  const sent = (): RecordingRow[] => [
    row({ kind: "prompt", text: "Also add a test.", by: "Ed" }),
    row({ kind: "tool", name: "AskUserQuestion", text: "Which page size?" }),
    row({ kind: "decision", name: "question", by: "Maya Okafor", text: "50" }),
    row({ kind: "decision", name: "permission", failed: true, by: "Ed", text: "git push --force" }),
    row({ kind: "clear", by: "Ed" }),
    row({ kind: "novel" as never, text: "Odd." }),
  ];
  const withRows = () => fakeApi({ recordingPage: vi.fn(async () => pageOf({ entries: sent() })) as never });

  it("attributes them as the Activity feed does: You, from Podium, for the signed-in viewer, otherwise the sender", async () => {
    const { container } = await replay(withRows());
    const who = lis(container).map((l) => l.querySelector(".who")!.textContent);
    expect(who).toEqual(["You, from Podium:", "api-refactor:", "Maya Okafor, from Podium:", "You, from Podium:", "You, from Podium:", "api-refactor:"]);
  });

  it("draws a decision right after the call it answers, worded by what it did, in the Podium row's style", async () => {
    const { container } = await replay(withRows());
    const d = lis(container)[2]!;
    expect(d.className).toContain("you");
    expect(d.querySelector(".k")!.getAttribute("aria-label")).toBe("Sent from Podium");
    expect(d.querySelector(".name")!.textContent).toBe("Answered a question");
    expect(d.querySelector(".arg")!.textContent).toBe("50");
    expect(d.querySelector(".failbox")).toBeNull();
  });

  it("uses the failure styling when it failed, and counts it for Jump to next failure", async () => {
    const { container } = await replay(withRows());
    const d = lis(container)[3]!;
    expect(d.querySelector(".name")!.textContent).toBe("Denied a tool");
    expect(d.querySelector(".failbox .fh2")!.textContent).toBe("Denied a tool");
    expect(d.querySelector(".failbox pre")!.textContent).toBe("git push --force");
    fireEvent.click(screen.getByRole("button", { name: "Jump to next failure" }));
    expect(d).toHaveClass("cur");
  });

  it("names a sender it does not know, and a decision with no text has nothing after its words", async () => {
    const api = fakeApi({ recordingPage: vi.fn(async () => pageOf({ entries: [row({ kind: "decision", name: "plan", failed: true })] })) as never });
    const { container } = await replay(api);
    const d = lis(container)[0]!;
    expect(d.querySelector(".who")!.textContent).toBe("Someone, from Podium:");
    expect(d.querySelector(".arg")).toBeNull();
    expect(d.querySelector(".failbox pre")).toBeNull();
    expect(d.querySelector(".name")!.textContent).toBe("Sent a plan back");
  });

  it("draws a clear in the app's words and an unknown kind as a marked row", async () => {
    const { container } = await replay(withRows());
    expect(lis(container)[4]!.className).toContain("mark");
    expect(lis(container)[4]!.textContent).toContain("The conversation was cleared.");
    expect(lis(container)[5]!.className).toContain("mark");
    expect(lis(container)[5]!.textContent).toContain("Odd.");
  });
});

describe("moving through it", () => {
  it("sets the slider to the rows loaded, starts on the first, and moves the current row", async () => {
    const { container } = await replay();
    const slider = screen.getByRole("slider", { name: "Position" }) as HTMLInputElement;
    expect(slider.max).toBe("7");
    expect(slider.value).toBe("0");
    expect(lis(container)[0]).toHaveClass("cur");
    expect(lis(container)[0]!.getAttribute("aria-current")).toBe("true");
    expect(screen.getByText("Row 1 of 8")).toHaveAttribute("role", "status");
    fireEvent.change(slider, { target: { value: "3" } });
    expect(lis(container)[3]).toHaveClass("cur");
    expect(lis(container)[0]).not.toHaveClass("cur");
    expect(slider.getAttribute("aria-valuetext")).toBe("Row 4 of 8");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("jumps to the next failure and wraps round", async () => {
    const { container } = await replay();
    const jump = screen.getByRole("button", { name: "Jump to next failure" });
    fireEvent.click(jump);
    expect(lis(container)[4]).toHaveClass("cur");
    fireEvent.click(jump);
    expect(lis(container)[4]).toHaveClass("cur");
  });

  it("dims Jump to next failure when nothing failed", async () => {
    const api = fakeApi({ recordingPage: vi.fn(async () => pageOf({ entries: [row({ kind: "text", text: "ok" })] })) as never });
    await replay(api);
    expect(screen.getByRole("button", { name: "Jump to next failure" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Jump to next failure" }).title).toBe("No call failed.");
  });

  it("says, when it is dimmed, that older rows may hold a failure", async () => {
    const api = fakeApi({ recordingPage: vi.fn(async () => pageOf({ entries: [row({ kind: "text", text: "ok" })], olderBefore: 1 })) as never });
    await replay(api);
    expect(screen.getByRole("button", { name: "Jump to next failure" }).title).toBe("No call failed in the rows loaded. Show older rows to look further.");
  });

  it("asks for one loop when the filter changes, and says so when it has no rows", async () => {
    const api = fakeApi();
    const { container } = await replay(api);
    api.recordingPage.mockResolvedValueOnce(pageOf({ entries: [], total: 0 }));
    fireEvent.change(screen.getByLabelText("Loop"), { target: { value: "p" } });
    await flush();
    expect(api.recordingPage).toHaveBeenLastCalledWith("s1", { loop: "p" });
    expect(container.textContent).toContain("No rows for this loop.");
    expect(screen.getByText("No rows")).toBeInTheDocument();
    expect(screen.getByLabelText("Loop")).toBeInTheDocument();
  });
});

describe("Show older", () => {
  const newest = () => rows().slice(5);
  const older = () => [row({ kind: "text", text: "older one", at: at(11, 40) }), row({ kind: "text", text: "older two", at: at(11, 41) })];

  it("says how many are shown, loads the older ones above and keeps the slider on the same row", async () => {
    const api = fakeApi({ recordingPage: vi.fn().mockResolvedValueOnce(pageOf({ entries: newest(), olderBefore: 6, total: 342 })).mockResolvedValueOnce(pageOf({ entries: older(), olderBefore: null, total: 342 })) as never });
    const { container } = await replay(api);
    expect(container.querySelector(".older .count")!.textContent).toBe("Showing the newest 5 of 342");
    fireEvent.change(screen.getByRole("slider", { name: "Position" }), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    await flush();
    expect(api.recordingPage).toHaveBeenLastCalledWith("s1", { before: 6, loop: null });
    expect(lis(container)[0]!.textContent).toContain("older one");
    expect(lis(container)[4]).toHaveClass("cur");
    expect(container.querySelector(".older .count")!.textContent).toBe("Showing all 342");
    expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
  });

  it("drops an older page that arrives after the loop filter changed, and keeps the rows of the new filter", async () => {
    let finish!: (p: RecordingPage) => void;
    const late = new Promise<RecordingPage>((res) => (finish = res));
    const own = [row({ kind: "text", text: "agent row", loop: "p", at: at(11, 50) })];
    const recordingPage = vi
      .fn()
      .mockResolvedValueOnce(pageOf({ entries: newest(), olderBefore: 6, total: 342 }))
      .mockImplementationOnce(() => late)
      .mockResolvedValueOnce(pageOf({ entries: own, olderBefore: null, total: 1 }));
    const { container } = await replay(fakeApi({ recordingPage: recordingPage as never }));
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    fireEvent.change(screen.getByLabelText("Loop"), { target: { value: "p" } });
    await flush();
    finish(pageOf({ entries: older(), olderBefore: null, total: 342 }));
    await flush();
    expect(container.textContent).toContain("agent row");
    expect(container.textContent).not.toContain("older one");
    expect(lis(container)).toHaveLength(1);
  });

  it("says what went wrong when older rows cannot be loaded, and lets you try again", async () => {
    const api = fakeApi({ recordingPage: vi.fn().mockResolvedValueOnce(pageOf({ entries: newest(), olderBefore: 6 })).mockRejectedValueOnce(new RespondError(500, {})) as never });
    await replay(api);
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Could not load older rows: HTTP 500. Try again.");
    expect(screen.getByRole("button", { name: "Show older" })).not.toBeDisabled();
  });
});

describe("when it cannot be shown", () => {
  const failing = (status: number, body: Record<string, unknown> = {}) => fakeApi({ recordingPage: vi.fn(async () => { throw new RespondError(status, body); }) as never });

  it("shows Loading… first, with the header", async () => {
    let release!: (p: RecordingPage) => void;
    const api = fakeApi({ recordingPage: vi.fn(() => new Promise<RecordingPage>((r) => (release = r))) as never });
    const { container } = await replay(api);
    expect(screen.getByRole("status").textContent).toBe("Loading…");
    expect(container.querySelector("h1")).not.toBeNull();
    expect(container.querySelector(".fh .sub")).toBeNull();
    await act(async () => release(pageOf()));
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("tells a viewer who may not open it so, naming the owner", async () => {
    const { container } = await replay(failing(403, { owner: "Maya Okafor" }));
    expect(container.querySelector(".kb-blank")!.textContent).toBe("This session was recordedOnly Maya Okafor or an Admin can open the recording.");
    expect(container.querySelector("h1")).toBeNull();
  });

  it("says its owner when the owner is not named, or is Admin", async () => {
    expect((await replay(failing(403))).container.textContent).toContain("Only its owner or an Admin");
    cleanup();
    expect((await replay(failing(403, { owner: "Admin" }))).container.textContent).toContain("Only its owner or an Admin");
  });

  it("asks a viewer who is signed out to sign in", async () => {
    const { container } = await replay(failing(401));
    expect(container.querySelector(".kb-blank b")!.textContent).toBe("Sign in to open this recording");
  });

  it("opens the recording once a viewer who was asked to sign in does, without a reload, and asks for it just once", async () => {
    let signedIn = false;
    const api = fakeApi({
      me: vi.fn(async () => ({ enabled: true, signedIn, name: signedIn ? "Ed" : null, admin: false })),
      signIn: vi.fn(async () => { signedIn = true; return { ok: true as const, name: "Ed", admin: false }; }),
      recordingPage: vi.fn(async () => { if (!signedIn) throw new RespondError(401, {}); return pageOf(); }) as never,
    });
    function Probe() {
      const r = useRespond();
      return <button onClick={() => void r!.signIn("Ed", "tok")}>sign in</button>;
    }
    const { container } = render(
      <RespondProvider api={api} flagsOn={false} recordingOn>
        <Probe />
        <ReplayPage id="s1" session={null} now={NOW} />
      </RespondProvider>,
    );
    await flush();
    expect(container.querySelector(".kb-blank b")!.textContent).toBe("Sign in to open this recording");
    fireEvent.click(screen.getByRole("button", { name: "sign in" }));
    await flush();
    expect(container.querySelector(".kb-blank")).toBeNull();
    expect(lis(container)).toHaveLength(8);
    expect(api.recordingPage).toHaveBeenCalledTimes(2);
  });

  it("says there is nothing to open when the recording is gone", async () => {
    const { container } = await replay(failing(404, { error: "this session has no recording" }));
    expect(container.querySelector(".kb-blank b")!.textContent).toBe("There is no recording to open");
  });

  it("shows the error box with Try again for a failure, and loads again", async () => {
    const api = fakeApi({ recordingPage: vi.fn().mockRejectedValueOnce(new RespondError(500, {})).mockResolvedValueOnce(pageOf()) as never });
    const { container } = await replay(api);
    expect(screen.getByRole("alert").textContent).toBe("Could not load the recording: HTTP 500. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    expect(lis(container)).toHaveLength(8);
  });

  it("says the server could not be reached for a failure that is not a refusal", async () => {
    const api = fakeApi({ recordingPage: vi.fn(async () => { throw new Error("offline"); }) as never });
    await replay(api);
    expect(screen.getByRole("alert").textContent).toBe("Could not load the recording: could not reach the server. Try again.");
  });

  it("says so when the page has no way to read a recording", async () => {
    await replay(undefined, { provider: false });
    expect(screen.getByRole("alert").textContent).toBe("This page cannot open recordings. Reload it, and sign in from the top bar if you are not signed in.");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("says nothing has been recorded yet, and when it started", async () => {
    const api = fakeApi({ recordingPage: vi.fn(async () => pageOf({ entries: [], total: 0, grant: grant({ state: "recording" }) })) as never });
    const { container } = await replay(api);
    expect(container.querySelector(".kb-blank b")!.textContent).toBe("Nothing has been recorded yet");
    expect(container.querySelector(".kb-blank p")!.textContent).toContain("Recording started at 11:42 and no loop has done anything since.");
    cleanup();
    const bare = fakeApi({ recordingPage: vi.fn(async () => pageOf({ entries: [], total: 0, grant: grant({ startedAt: null }) })) as never });
    expect((await replay(bare)).container.querySelector(".kb-blank p")!.textContent).toContain("Recording started and no loop");
  });
});

describe("leaving and deleting", () => {
  it("goes back to the session's page from the back link, or to History's for one that ended", async () => {
    window.history.replaceState(null, "", "#/?open=s1&replay");
    const { unmount } = await replay();
    fireEvent.click(screen.getByRole("button", { name: "Back to api-refactor" }));
    expect(window.location.hash).toBe("#/?open=s1");
    unmount();
    window.history.replaceState(null, "", "#/?open=s1&replay");
    await replay(fakeApi(), { session: null });
    fireEvent.click(screen.getByRole("button", { name: /Back to/ }));
    expect(window.location.hash).toBe("#/history?open=s1");
  });

  it("asks before it deletes, and Escape keeps the recording", async () => {
    const { api } = await replay();
    fireEvent.click(screen.getByRole("button", { name: "Delete recording" }));
    const box = screen.getByRole("alertdialog", { name: "Delete this recording?" });
    expect(box.textContent).toMatch(/The whole recording, 18\.0 MB, is removed for good, and you go back to the orchestrator page\./);
    expect(within(box).getByRole("button", { name: "Delete recording" })).toHaveFocus();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.recordingDelete).not.toHaveBeenCalled();
  });

  it("deletes it, then leaves the replay", async () => {
    window.history.replaceState(null, "", "#/?open=s1&replay");
    const { api } = await replay();
    fireEvent.click(screen.getByRole("button", { name: "Delete recording" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete recording" }));
    await flush();
    expect(api.recordingDelete).toHaveBeenCalledWith("s1");
    expect(window.location.hash).toBe("#/?open=s1");
  });

  it("says what went wrong when the delete fails, and keeps the replay", async () => {
    const api = fakeApi({ recordingDelete: vi.fn(async () => { throw new RespondError(500, {}); }) as never });
    const { container } = await replay(api);
    fireEvent.click(screen.getByRole("button", { name: "Delete recording" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete recording" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Could not delete the recording: HTTP 500. Try again.");
    expect(lis(container)).toHaveLength(8);
  });

  it("does nothing when the page cannot delete", async () => {
    const api = fakeApi();
    delete (api as { recordingDelete?: unknown }).recordingDelete;
    const { container } = await replay(api);
    fireEvent.click(screen.getByRole("button", { name: "Delete recording" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete recording" }));
    await flush();
    expect(lis(container)).toHaveLength(8);
  });

  it("keeps showing a kept-until of its own when nothing says when it goes", async () => {
    const api = fakeApi({ recordingPage: vi.fn(async () => pageOf({ grant: grant({ keptUntil: null }) })) as never });
    const { container } = await replay(api);
    expect(container.textContent).toContain("Kept until it expires, then deleted.");
  });
});

describe("a session that is not in the fleet", () => {
  it("takes its name from its stored page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ name: "flaky-tests" }) })));
    const { container } = await replay(undefined, { session: null });
    expect(container.querySelector("h1")!.textContent).toBe("flaky-tests");
    expect(container.querySelector(".fh .sub")!.textContent).toMatch(/Maya Okafor stopped it/);
  });

  it("uses the short id when the page cannot be read, and says the session ended", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const api = fakeApi({ recordingPage: vi.fn(async () => pageOf({ grant: grant({ state: "recording", stoppedBy: null, stoppedAt: null }) })) as never });
    const { container } = await replay(api, { session: null });
    expect(container.querySelector("h1")!.textContent).toBe("s1");
    expect(container.querySelector(".fh .sub")!.textContent).toContain("The session ended.");
  });

  it("copes with a browser that cannot fetch at all", async () => {
    vi.stubGlobal("fetch", undefined);
    const { container } = await replay(undefined, { session: null });
    expect(container.querySelector("h1")!.textContent).toBe("s1");
  });
});

describe("the replay at its address in the console", () => {
  const live = makeSession({ id: "s1", name: "api-refactor", owner: "Ed", recording: makeRecording() });
  const view = (api: RespondApi, sessions = [live]) => <FleetView state={stateFrom({ sessions, features: { "activity-feed": true, "session-recording": true } })} respondApi={api} />;

  it("opens the replay in place of the orchestrator's page, even for a session the fleet no longer holds", async () => {
    window.history.replaceState(null, "", "#/?open=s1&replay");
    render(view(fakeApi(), []));
    await flush();
    expect(screen.getByText("Recorded activity")).toBeInTheDocument();
    expect(screen.queryByText(/is not in the fleet/)).toBeNull();
    expect(document.querySelector(".op")).toBeNull();
  });

  it("opens from Open replay and returns to the orchestrator's page with Back", async () => {
    window.history.replaceState(null, "", "#/?open=s1");
    render(view(fakeApi()));
    await flush();
    fireEvent.click(within(document.querySelector(".rec-bar") as HTMLElement).getByRole("button", { name: "Open replay" }));
    await flush();
    expect(window.location.hash).toBe("#/?open=s1&replay");
    expect(screen.getByText("Recorded activity")).toBeInTheDocument();
    expect(document.querySelector(".op")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to api-refactor" }));
    // Back is the browser's: the entry the replay pushed is left, and the console follows the address once the popstate arrives (later on a slow runner).
    await waitFor(() => expect(window.location.hash).toBe("#/?open=s1"));
    await waitFor(() => expect(document.querySelector(".op")).not.toBeNull());
    expect(screen.queryByText("Recorded activity")).toBeNull();
  });

  it("leaves the replay when the same session is picked in the rail", async () => {
    window.history.replaceState(null, "", "#/?open=s1&replay");
    render(view(fakeApi()));
    await flush();
    const rail = screen.getByRole("navigation", { name: "Orchestrators" });
    fireEvent.click(within(rail).getByText("api-refactor"));
    await flush();
    expect(window.location.hash).toBe("#/?open=s1");
    expect(document.querySelector(".op")).not.toBeNull();
    expect(screen.queryByText("Recorded activity")).toBeNull();
  });

  it("follows the address when it changes to a replay and back", async () => {
    window.history.replaceState(null, "", "#/?open=s1");
    render(view(fakeApi()));
    await flush();
    expect(document.querySelector(".op")).not.toBeNull();
    window.history.replaceState(null, "", "#/?open=s1&replay");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    expect(screen.getByText("Recorded activity")).toBeInTheDocument();
    window.history.replaceState(null, "", "#/?open=s1");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush();
    expect(document.querySelector(".op")).not.toBeNull();
  });
});
