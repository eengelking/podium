// A file's diff in the shared modal (#319, mockup/podium-file-diff.html): who gets a button, what the modal shows for
// each status, that a diff is drawn as text, and that focus returns to the row.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { makeSession } from "./fixtures";
import { FilesList, diffAccess } from "./components/FilesList";
import { FileDiffModal, STEP_DELAY_MS, WRAP_KEY } from "./components/FileDiffModal";
import { RespondProvider, type RespondContext } from "./useRespond";
import { RespondError, type RespondApi } from "./respondApi";
import type { FileDiffReply, FilesReport, RespondMe, SessionView } from "./types";

afterEach(cleanup);

const OWNER: RespondMe = { enabled: true, signedIn: true, name: "Ed", admin: false };
const REPORT: FilesReport = {
  files: [
    { path: "src/a.ts", status: "modified", from: null, added: 2, removed: 1 },
    { path: "docs/new.md", status: "added", from: null, added: 3, removed: 0 },
    { path: "img/logo.png", status: "modified", from: null, added: null, removed: null },
  ],
  total: 3,
  added: 5,
  removed: 1,
  since: "start",
};
const DIFF = '@@ -1,3 +1,4 @@ function f() {\n const keep = 1\n-const apiKey = "[redacted]"\n+const apiKey = process.env.KEY\n+const x = "<img src=x onerror=alert(1)>"\n tail';
const ok = (over: Partial<FileDiffReply> = {}): FileDiffReply => ({ path: "src/a.ts", status: "ok", text: DIFF, truncated: false, shownLines: 6, totalLines: 6, redactions: 1, base: "7eb90e8", ...over });

function fakeApi(fileDiff: RespondApi["fileDiff"], me: RespondMe = OWNER): RespondApi {
  return {
    me: vi.fn(async () => me),
    signIn: vi.fn(async () => ({ ok: true as const, name: "Ed", admin: false })),
    signOut: vi.fn(async () => ({ ok: true as const })),
    ask: vi.fn(),
    answer: vi.fn(),
    message: vi.fn(),
    discard: vi.fn(),
    fileDiff,
  } as unknown as RespondApi;
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });

async function show(opts: { api?: RespondApi; me?: RespondMe; diffOn?: boolean; s?: Partial<SessionView>; report?: FilesReport | null } = {}) {
  const session = makeSession({ id: "sess-ed", owner: "Ed", status: "running", fileDiff: true, ...opts.s });
  const api = opts.api ?? fakeApi(vi.fn(async () => ok()), opts.me ?? OWNER);
  const view = render(
    <RespondProvider api={api} flagsOn={false} diffOn={opts.diffOn ?? true}>
      <FilesList report={opts.report === undefined ? REPORT : opts.report} hint={null} session={session} />
    </RespondProvider>,
  );
  await flush();
  return { api, ...view };
}

describe("who gets a button", () => {
  it("is nobody while the Admin's flag is off: the list is as it always was, with no note", async () => {
    await show({ diffOn: false });
    expect(screen.queryByRole("button", { name: /Open diff of/ })).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByText("a.ts")).toBeTruthy();
  });
  it("is the session's signed-in owner, with the option on: each row a button that names its path", async () => {
    await show();
    const b = screen.getAllByRole("button", { name: /Open diff of/ });
    expect(b.map((x) => x.getAttribute("aria-label"))).toEqual(["Open diff of src/a.ts", "Open diff of docs/new.md", "Open diff of img/logo.png"]);
    expect(screen.queryByRole("note")).toBeNull();
  });
  it("says to sign in when signed out", async () => {
    await show({ me: { enabled: true, signedIn: false, name: null, admin: false } });
    expect(screen.queryByRole("button", { name: /Open diff of/ })).toBeNull();
    expect(screen.getByRole("note").textContent).toBe("Sign in to open diffs.");
  });
  it("says who can, for someone else's session, an Administrator included", async () => {
    await show({ me: { enabled: true, signedIn: true, name: "Boss", admin: true } });
    expect(screen.queryByRole("button", { name: /Open diff of/ })).toBeNull();
    expect(screen.getByRole("note").textContent).toBe("Only Ed can open diffs.");
  });
  it("compares names the way the server does: without regard to case", async () => {
    await show({ me: { enabled: true, signedIn: true, name: "ED", admin: false } });
    expect(screen.getAllByRole("button", { name: /Open diff of/ })).toHaveLength(3);
  });
  it("says so for a session with no owner, and for a reporter without the option", async () => {
    await show({ s: { owner: null } });
    expect(screen.getByRole("note").textContent).toBe("This session has no owner, so no one can open its diffs.");
    cleanup();
    await show({ s: { fileDiff: false } });
    expect(screen.getByRole("note").textContent).toBe("Turn on the fileDiff option of podium-reporter on this machine to open diffs.");
    cleanup();
    await show({ s: { fileDiff: null } });
    expect(screen.getByRole("note").textContent).toMatch(/fileDiff option/);
  });
  it("is nobody for a session that has ended", async () => {
    await show({ s: { status: "done" } });
    expect(screen.queryByRole("button", { name: /Open diff of/ })).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
  });
  it("diffAccess is none outside the provider and when the server does not take sign-ins", () => {
    expect(diffAccess(makeSession(), null)).toEqual({ kind: "none" });
    expect(diffAccess(undefined, { diffOn: true, me: OWNER } as RespondContext)).toEqual({ kind: "none" });
    expect(diffAccess(makeSession({ status: "running" }), { diffOn: true, me: { ...OWNER, enabled: false } } as RespondContext)).toEqual({ kind: "none" });
  });
});

describe("the modal", () => {
  it("asks for the file, shows Loading, then the diff side by side, and marks each [redacted] in bold", async () => {
    let done!: (r: FileDiffReply) => void;
    const fileDiff = vi.fn(() => new Promise<FileDiffReply>((r) => (done = r)));
    const { api } = await show({ api: fakeApi(fileDiff) });
    fireEvent.click(screen.getByRole("button", { name: "Open diff of src/a.ts" }));
    const dialog = screen.getByRole("dialog");
    expect(fileDiff).toHaveBeenCalledWith("sess-ed", "src/a.ts");
    expect(within(dialog).getByRole("status").textContent).toContain("Loading");
    await act(async () => done(ok()));
    expect(api.fileDiff).toHaveBeenCalledTimes(1);
    const panes = dialog.querySelectorAll(".sbs .pane");
    expect(panes).toHaveLength(2);
    expect(panes[0]!.textContent).toContain("const apiKey = \"[redacted]\"");
    expect(panes[1]!.textContent).toContain("process.env.KEY");
    expect(panes[0]!.textContent).not.toContain("process.env.KEY");
    expect(dialog.querySelector(".sbs .rd")!.textContent).toBe("[redacted]");
    expect(dialog.querySelector(".uni")).not.toBeNull();
    expect(dialog.querySelector(".foot-note")!.textContent).toBe("1 value hidden as possible secrets. Hiding is best effort, so check the diff before you share it.");
  });
  it("draws the diff as text: markup in a line is shown, never parsed", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Open diff of src/a.ts" }));
    await flush();
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("img")).toBeNull();
    expect(dialog.textContent).toContain('<img src=x onerror=alert(1)>');
  });
  it("gives the path as the title and the status, counts and base as the sub line", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Open diff of src/a.ts" }));
    await flush();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("src/a.ts");
    expect(dialog.querySelector(".sub2")!.textContent).toBe("M · +2−1 · against the starting commit 7eb90e8");
  });
  it("marks added and removed lines with + and − as well as a tint, and keeps line numbers", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Open diff of src/a.ts" }));
    await flush();
    const left = screen.getByRole("dialog").querySelectorAll(".sbs .pane")[0]!;
    expect(left.querySelector(".l.r .m")!.textContent).toBe("−");
    expect(left.querySelector(".l.r .n")!.textContent).toBe("2");
    const right = screen.getByRole("dialog").querySelectorAll(".sbs .pane")[1]!;
    expect(right.querySelector(".l.a .m")!.textContent).toBe("+");
    expect(left.querySelector(".l.f")).not.toBeNull(); // the filler beside the second added line
    expect(right.querySelector(".l.f")).toBeNull();
  });
  it("says how much was cut", async () => {
    await show({ api: fakeApi(vi.fn(async () => ok({ truncated: true, shownLines: 2000, totalLines: 10190, redactions: 0 }))) });
    fireEvent.click(screen.getByRole("button", { name: "Open diff of src/a.ts" }));
    await flush();
    expect(screen.getByRole("dialog").querySelector(".foot-note")!.textContent).toBe("Showing the first 2,000 lines of 10,190.");
  });
  it.each([
    ["binary", /No text diff for a binary file/],
    ["too-large", /over 5 MB/],
    ["withheld", /never reads the diff of files that usually hold secrets/],
  ] as const)("says plainly what a %s file is", async (status, words) => {
    await show({ api: fakeApi(vi.fn(async () => ok({ status, text: null }))) });
    fireEvent.click(screen.getByRole("button", { name: "Open diff of src/a.ts" }));
    await flush();
    expect(screen.getByRole("dialog").textContent).toMatch(words);
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("names the command to run for a diff that is too large", async () => {
    await show({ api: fakeApi(vi.fn(async () => ok({ status: "too-large", text: null }))) });
    fireEvent.click(screen.getByRole("button", { name: "Open diff of src/a.ts" }));
    await flush();
    expect(screen.getByRole("dialog").querySelector("code")!.textContent).toBe("git diff -- src/a.ts");
  });
  it("says there is nothing to draw for a file with no lines", async () => {
    await show({ api: fakeApi(vi.fn(async () => ok({ text: "", shownLines: 0, totalLines: 0, redactions: 0 }))) });
    fireEvent.click(screen.getByRole("button", { name: "Open diff of src/a.ts" }));
    await flush();
    expect(screen.getByRole("dialog").textContent).toContain("No line changes to show.");
  });
  it("shows an unavailable diff as an error with what to do", async () => {
    await show({ api: fakeApi(vi.fn(async () => ok({ status: "unavailable", text: null }))) });
    fireEvent.click(screen.getByRole("button", { name: "Open diff of src/a.ts" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Close this and open the file again.");
  });
  it.each([
    [504, {}, /did not answer in 15 seconds/],
    [429, {}, /Too many diffs are waiting/],
    [401, {}, /signed out/],
    [403, { owner: "Dana" }, /Only Dana can open this diff/],
    [403, { error: "file diff is off" }, /turned off for this session/],
    [404, {}, /session has ended/],
  ] as const)("explains a %i from the server", async (status, body, words) => {
    await show({ api: fakeApi(vi.fn(async () => Promise.reject(new RespondError(status, body)))) });
    fireEvent.click(screen.getByRole("button", { name: "Open diff of src/a.ts" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toMatch(words);
  });
  it("explains a failure to reach the server", async () => {
    await show({ api: fakeApi(vi.fn(async () => Promise.reject(new Error("offline")))) });
    fireEvent.click(screen.getByRole("button", { name: "Open diff of src/a.ts" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toMatch(/could not be loaded/);
  });
  it("closes with the X, Esc and the dimmed area, and gives focus back to the row", async () => {
    await show();
    const row = () => screen.getByRole("button", { name: "Open diff of src/a.ts" });
    for (const close of [
      () => fireEvent.click(screen.getByRole("button", { name: /^Close/ })),
      () => fireEvent.keyDown(document, { key: "Escape" }),
      () => fireEvent.mouseDown(document.querySelector(".scrim")!),
    ]) {
      row().focus();
      fireEvent.click(row());
      await flush();
      expect(screen.getByRole("dialog")).toBeTruthy();
      close();
      await flush();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(row());
    }
  });
  it("keeps the two sides level when one is scrolled sideways", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Open diff of src/a.ts" }));
    await flush();
    const [left, right] = [...screen.getByRole("dialog").querySelectorAll<HTMLElement>(".sbs .pane")];
    left!.scrollLeft = 120;
    fireEvent.scroll(left!);
    expect(right!.scrollLeft).toBe(120);
    right!.scrollLeft = 30;
    fireEvent.scroll(right!);
    expect(left!.scrollLeft).toBe(30);
  });
  it("says it could not be loaded when it is opened outside the console's provider", () => {
    render(<FileDiffModal sessionId="s" files={REPORT.files} index={0} since="start" onStep={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("alert").textContent).toMatch(/could not be loaded/);
  });
  it("asks again each time it is opened and keeps nothing between", async () => {
    const fileDiff = vi.fn(async () => ok());
    await show({ api: fakeApi(fileDiff) });
    for (let i = 0; i < 2; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Open diff of src/a.ts" }));
      await flush();
      fireEvent.keyDown(document, { key: "Escape" });
      await flush();
    }
    expect(fileDiff).toHaveBeenCalledTimes(2);
  });
  it("shows the rename source in the sub line", async () => {
    const report: FilesReport = { ...REPORT, files: [{ path: "docs/GUIDE.md", status: "renamed", from: "docs/USER.md", added: 2, removed: 1 }], total: 1 };
    await show({ report });
    fireEvent.click(screen.getByRole("button", { name: "Open diff of docs/GUIDE.md" }));
    await flush();
    expect(screen.getByRole("dialog").querySelector(".sub2")!.textContent).toContain("R · from docs/USER.md");
  });
});

describe("the Wrap lines switch (#623)", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });
  async function open() {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Open diff of src/a.ts" }));
    await flush();
    return screen.getByRole("dialog");
  }
  const sw = () => screen.getByRole("switch", { name: /Wrap lines/ });

  it("is on by default: the modal is wrapped, and the switch says Wrap lines and On", async () => {
    const dlg = await open();
    expect(dlg.classList.contains("wrapped")).toBe(true);
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(sw().getAttribute("aria-labelledby")).toBeTruthy();
    expect(dlg.querySelector(".mf .sw")?.textContent).toBe("Wrap linesOn");
  });
  it("turns wrapping off and on, with the state in a word as well as aria-checked", async () => {
    const dlg = await open();
    fireEvent.click(sw());
    expect(dlg.classList.contains("wrapped")).toBe(false);
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(dlg.querySelector(".mf .sw")?.textContent).toBe("Wrap linesOff");
    fireEvent.click(sw());
    expect(dlg.classList.contains("wrapped")).toBe(true);
  });
  it("keeps the choice for the next diff and after a reload", async () => {
    await open();
    fireEvent.click(sw());
    expect(window.localStorage.getItem(WRAP_KEY)).toBe("false");
    cleanup();
    const dlg = await open();
    expect(dlg.classList.contains("wrapped")).toBe(false);
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });
  it("falls back to wrapped when the saved choice cannot be read", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const dlg = await open();
    expect(dlg.classList.contains("wrapped")).toBe(true);
  });
  it("sits at the right of the bottom row, after the pager and the note", async () => {
    const api = fakeApi(vi.fn(async () => ok({ truncated: true, shownLines: 2000, totalLines: 10190 })));
    await show({ api });
    fireEvent.click(screen.getByRole("button", { name: "Open diff of src/a.ts" }));
    await flush();
    const row = screen.getByRole("dialog").querySelector(".mf")!;
    expect([...row.children].map((e) => e.className)).toEqual(["pager", "foot-note", "sw"]);
  });
  it("is not shown where no diff is drawn", async () => {
    const api = fakeApi(vi.fn(async () => ok({ status: "binary", text: "" })));
    await show({ api });
    fireEvent.click(screen.getByRole("button", { name: "Open diff of src/a.ts" }));
    await flush();
    expect(screen.queryByRole("switch")).toBeNull();
  });
  it("places a changed line's two halves on the same grid row, in both views", async () => {
    const dlg = await open();
    const pairs = (side: number) => [...dlg.querySelectorAll(".sbs .pane")[side]!.querySelectorAll<HTMLElement>(".l")].map((e) => e.style.getPropertyValue("--r"));
    const [left, right] = [pairs(0), pairs(1)];
    expect(left.length).toBe(right.length);
    expect(left).toEqual(left.map((_, i) => String(i + 1)));
    expect(right).toEqual(left);
    // the removed line and its replacement share a row, and each keeps its number and mark once
    const del = dlg.querySelector<HTMLElement>(".sbs .l.r")!;
    const add = dlg.querySelector<HTMLElement>(".sbs .l.a")!;
    expect(del.style.getPropertyValue("--r")).toBe(add.style.getPropertyValue("--r"));
    expect(del.querySelectorAll(".n, .m").length).toBe(2);
    // the unified column has both numbers and one mark on the first visual line
    const uni = dlg.querySelector(".uni .l.r")!;
    expect(uni.querySelectorAll(".n").length).toBe(2);
    expect(uni.querySelectorAll(".m").length).toBe(1);
  });
});

describe("stepping through the files (#630)", () => {
  const many = (n: number): FilesReport => ({
    files: Array.from({ length: n }, (_, i) => ({ path: `src/f${i + 1}.ts`, status: "modified" as const, from: null, added: i + 1, removed: 0 })),
    total: n + 10,
    added: n,
    removed: 0,
    since: "start",
  });
  const diffFor = (path: string) => ok({ path, text: `@@ -1 +1 @@\n-old ${path}\n+new ${path}` });
  const prev = () => screen.getByRole("button", { name: /^Previous file/ }) as HTMLButtonElement;
  const next = () => screen.getByRole("button", { name: /^Next file/ }) as HTMLButtonElement;
  // A step asks for its file after a short pause (STEP_DELAY_MS), so a test waits that out.
  const pause = () => act(async () => void (await new Promise((r) => setTimeout(r, STEP_DELAY_MS + 40))));
  const stepTo = async (b: HTMLElement) => {
    fireEvent.click(b);
    await pause();
  };
  const pos = (dlg: HTMLElement) => dlg.querySelector(".mf .pager span")!.textContent;
  async function openAt(report: FilesReport, name: string, fileDiff = vi.fn(async (_s: string, path: string) => diffFor(path))) {
    await show({ api: fakeApi(fileDiff), report });
    fireEvent.click(screen.getByRole("button", { name: `Open diff of ${name}` }));
    await flush();
    return { dlg: screen.getByRole("dialog"), fileDiff };
  }

  it("steps forward and back in the Files tab's order, in place, with the position and the file it opens named on each button", async () => {
    const { dlg, fileDiff } = await openAt(REPORT, "src/a.ts");
    expect(pos(dlg)).toBe("Showing file 1 of 3");
    expect(next().getAttribute("aria-label")).toBe("Next file: docs/new.md");
    expect(next().title).toBe("Next file: docs/new.md");
    await stepTo(next());
    expect(screen.getByRole("dialog")).toBe(dlg);
    expect(dlg.querySelector("h2")!.textContent).toBe("docs/new.md");
    expect(dlg.querySelector(".sub2")!.textContent).toContain("A · +3−0");
    expect(pos(dlg)).toBe("Showing file 2 of 3");
    expect(prev().getAttribute("aria-label")).toBe("Previous file: src/a.ts");
    await stepTo(prev());
    expect(dlg.querySelector("h2")!.textContent).toBe("src/a.ts");
    expect(fileDiff.mock.calls.map((c) => c[1])).toEqual(["src/a.ts", "docs/new.md", "src/a.ts"]);
  });
  it("disables Previous at the first file and Next at the last, and does not wrap", async () => {
    await openAt(REPORT, "src/a.ts");
    expect(prev().disabled).toBe(true);
    expect(next().disabled).toBe(false);
    await stepTo(next());
    await stepTo(next());
    expect(screen.getByRole("dialog").querySelector("h2")!.textContent).toBe("img/logo.png");
    expect(next().disabled).toBe(true);
    expect(prev().disabled).toBe(false);
    await stepTo(next());
    expect(screen.getByRole("dialog").querySelector("h2")!.textContent).toBe("img/logo.png");
  });
  it("shows both buttons disabled for a list of one file", async () => {
    const one: FilesReport = { ...REPORT, files: [REPORT.files[0]!], total: 1 };
    const { dlg } = await openAt(one, "src/a.ts");
    expect(pos(dlg)).toBe("Showing file 1 of 1");
    expect(prev().disabled).toBe(true);
    expect(next().disabled).toBe(true);
    expect(prev().getAttribute("aria-label")).toBe("Previous file");
  });
  it("announces the position politely", async () => {
    const { dlg } = await openAt(REPORT, "src/a.ts");
    expect(dlg.querySelector(".mf .pager span")!.getAttribute("aria-live")).toBe("polite");
  });
  it("steps through every file the report holds, not only the page the first one was opened from", async () => {
    const report = many(45);
    await show({ api: fakeApi(vi.fn(async (_s: string, path: string) => diffFor(path))), report });
    fireEvent.click(screen.getByRole("button", { name: "Open diff of src/f20.ts" }));
    await flush();
    const dlg = screen.getByRole("dialog");
    expect(pos(dlg)).toBe("Showing file 20 of 45");
    await stepTo(next());
    expect(dlg.querySelector("h2")!.textContent).toBe("src/f21.ts");
    expect(pos(dlg)).toBe("Showing file 21 of 45");
    expect(next().disabled).toBe(false);
  });
  it("keeps the Wrap lines choice, shows the diff from the top and keeps focus on the button used", async () => {
    const { dlg } = await openAt(REPORT, "src/a.ts");
    fireEvent.click(screen.getByRole("switch", { name: /Wrap lines/ }));
    dlg.querySelector<HTMLElement>(".mb")!.scrollTop = 80;
    next().focus();
    await stepTo(next());
    expect(dlg.classList.contains("wrapped")).toBe(false);
    expect(dlg.querySelector<HTMLElement>(".mb")!.scrollTop).toBe(0);
    expect(document.activeElement).toBe(next());
    window.localStorage.clear();
  });
  it("moves focus to the other button when the one used becomes disabled at an end", async () => {
    await openAt(REPORT, "docs/new.md");
    next().focus();
    await stepTo(next());
    expect(next().disabled).toBe(true);
    expect(document.activeElement).toBe(prev());
  });
  it("never leaves the old diff on screen while the next one loads or fails", async () => {
    const waiting = new Map<string, (r: FileDiffReply) => void>();
    const fileDiff = vi.fn((_s: string, path: string) => (path === "src/a.ts" ? Promise.resolve(diffFor(path)) : new Promise<FileDiffReply>((r) => waiting.set(path, r))));
    const { dlg } = await openAt(REPORT, "src/a.ts", fileDiff as never);
    expect(dlg.textContent).toContain("new src/a.ts");
    fireEvent.click(next());
    expect(dlg.textContent).not.toContain("new src/a.ts");
    expect(dlg.querySelector(".diffmb")).toBeNull();
    expect(within(dlg).getByRole("status", { name: "" }).textContent).toContain("Loading");
    expect(pos(dlg)).toBe("Showing file 2 of 3");
    expect(prev().disabled).toBe(false);
    await pause();
    await act(async () => waiting.get("docs/new.md")!(diffFor("docs/new.md")));
    expect(dlg.textContent).toContain("new docs/new.md");
  });
  it("drops a reply for a file the person has already left", async () => {
    const waiting = new Map<string, (r: FileDiffReply) => void>();
    const fileDiff = vi.fn((_s: string, path: string) => new Promise<FileDiffReply>((r) => waiting.set(path, r)));
    const { dlg } = await openAt(REPORT, "src/a.ts", fileDiff as never);
    await stepTo(next());
    await stepTo(next());
    expect(dlg.querySelector("h2")!.textContent).toBe("img/logo.png");
    await act(async () => waiting.get("src/a.ts")!(diffFor("src/a.ts")));
    await act(async () => waiting.get("docs/new.md")!(diffFor("docs/new.md")));
    expect(dlg.textContent).not.toContain("new docs/new.md");
    expect(dlg.textContent).not.toContain("new src/a.ts");
    await act(async () => waiting.get("img/logo.png")!(ok({ status: "binary", text: "" })));
    expect(dlg.textContent).toContain("No text diff for a binary file.");
  });
  it("shows a failure for the file in view, and the row still steps past it", async () => {
    const fileDiff = vi.fn(async (_s: string, path: string) => {
      if (path === "docs/new.md") throw new RespondError(429, { error: "busy" });
      return diffFor(path);
    });
    const { dlg } = await openAt(REPORT, "src/a.ts", fileDiff as never);
    await stepTo(next());
    expect(within(dlg).getByRole("alert").textContent).toMatch(/Too many diffs are waiting/);
    expect(pos(dlg)).toBe("Showing file 2 of 3");
    await stepTo(prev());
    expect(dlg.textContent).toContain("new src/a.ts");
    expect(within(dlg).queryByRole("alert")).toBeNull();
  });
  it("steps onto a binary file and shows its usual message, then goes on", async () => {
    const fileDiff = vi.fn(async (_s: string, path: string) => (path === "img/logo.png" ? ok({ status: "binary", text: "" }) : diffFor(path)));
    const { dlg } = await openAt(REPORT, "docs/new.md", fileDiff as never);
    await stepTo(next());
    expect(dlg.textContent).toContain("No text diff for a binary file.");
    expect(dlg.querySelector(".sub2")!.textContent).toContain("binary");
    expect(prev().disabled).toBe(false);
  });
  it("asks only for the file it stops on when stepped quickly, so waiting diffs do not pile up", async () => {
    const report = many(30);
    const { fileDiff } = await openAt(report, "src/f1.ts");
    const dlg = screen.getByRole("dialog");
    for (let i = 0; i < 5; i++) fireEvent.click(next());
    expect(pos(dlg)).toBe("Showing file 6 of 30");
    await pause();
    expect(fileDiff.mock.calls.map((c) => c[1])).toEqual(["src/f1.ts", "src/f6.ts"]);
    expect(dlg.textContent).toContain("new src/f6.ts");
  });
  it("keeps the Wrap lines switch in the row while the next diff loads", async () => {
    const fileDiff = vi.fn((_s: string, path: string) => (path === "src/a.ts" ? Promise.resolve(diffFor(path)) : new Promise<FileDiffReply>(() => {})));
    const { dlg } = await openAt(REPORT, "src/a.ts", fileDiff as never);
    await stepTo(next());
    expect(dlg.querySelector(".mf .sw")).not.toBeNull();
  });
  it("asks for one file at a time: no file is fetched ahead", async () => {
    const { fileDiff } = await openAt(REPORT, "src/a.ts");
    expect(fileDiff).toHaveBeenCalledTimes(1);
  });
  it("gives focus back to the row that opened it on close, after stepping", async () => {
    await openAt(REPORT, "src/a.ts");
    const row = screen.getByRole("button", { name: "Open diff of src/a.ts" });
    await stepTo(next());
    fireEvent.keyDown(document, { key: "Escape" });
    await flush();
    expect(document.activeElement).toBe(row);
  });
});

describe("loading ahead (#631)", () => {
  const withOpened = (fileDiff: RespondApi["fileDiff"]) => {
    const api = fakeApi(fileDiff) as RespondApi & { fileDiffOpened: ReturnType<typeof vi.fn> };
    api.fileDiffOpened = vi.fn(async () => ({}));
    return api;
  };
  const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  afterEach(() => setHidden(false));

  it("loads every changed file's diff when the page opens, marked as ahead, and opens a loaded one with no wait", async () => {
    const fileDiff = vi.fn(async (_id: string, path: string, _ahead?: boolean) => ok({ path }));
    const api = withOpened(fileDiff);
    await show({ api, s: { fileDiffPreload: true } });
    expect(fileDiff.mock.calls.map((c) => [c[1], c[2]])).toEqual([["src/a.ts", true], ["docs/new.md", true], ["img/logo.png", true]]);
    fileDiff.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Open diff of src/a.ts" }));
    expect(screen.queryByText(/^Loading/)).toBeNull();
    expect(screen.getAllByText(/process\.env\.KEY/).length).toBeGreaterThan(0);
    await flush();
    expect(fileDiff).not.toHaveBeenCalled();
    expect(api.fileDiffOpened).toHaveBeenCalledWith("sess-ed", "src/a.ts");
  });
  it("reads a diff only when it is opened where the reporter has not allowed reading ahead", async () => {
    const fileDiff = vi.fn(async () => ok());
    await show({ api: withOpened(fileDiff), s: { fileDiffPreload: false } });
    expect(fileDiff).not.toHaveBeenCalled();
    cleanup();
    await show({ api: withOpened(fileDiff), s: { fileDiffPreload: null } });
    expect(fileDiff).not.toHaveBeenCalled();
  });
  it("loads nothing where the viewer cannot open diffs", async () => {
    const fileDiff = vi.fn(async () => ok());
    await show({ api: withOpened(fileDiff), s: { fileDiffPreload: true, owner: "Alex" } });
    expect(fileDiff).not.toHaveBeenCalled();
  });
  it("loads nothing while the tab is hidden, and starts when it is shown", async () => {
    setHidden(true);
    const fileDiff = vi.fn(async () => ok());
    await show({ api: withOpened(fileDiff), s: { fileDiffPreload: true } });
    expect(fileDiff).not.toHaveBeenCalled();
    setHidden(false);
    await flush();
    expect(fileDiff).toHaveBeenCalled();
  });
  it("reloads a file whose content marker moved, keeping the old text on screen, and asks for a new file", async () => {
    let text = "first";
    const fileDiff = vi.fn(async (_id: string, path: string) => ok({ path, text: `@@ -1 +1 @@\n-x\n+${text}` }));
    const session = makeSession({ id: "sess-ed", owner: "Ed", status: "running", fileDiff: true, fileDiffPreload: true });
    const tree = (report: FilesReport) => (
      <RespondProvider api={withOpened(fileDiff)} flagsOn={false} diffOn>
        <FilesList report={report} hint={null} session={session} />
      </RespondProvider>
    );
    const view = render(tree(REPORT));
    await flush();
    fileDiff.mockClear();
    text = "second";
    const edited: FilesReport = { ...REPORT, files: [{ ...REPORT.files[0]!, rev: "new" }, ...REPORT.files.slice(1), { path: "z.ts", status: "added", from: null, added: 1, removed: 0 }], total: 4 };
    view.rerender(tree(edited));
    await flush();
    expect(fileDiff.mock.calls.map((c) => c[1]).sort()).toEqual(["src/a.ts", "z.ts"]);
  });
  it("throws the diffs away when the page is left, and keeps nothing in the browser", async () => {
    const before = JSON.stringify({ ...localStorage });
    const fileDiff = vi.fn(async () => ok());
    const { unmount } = await show({ api: withOpened(fileDiff), s: { fileDiffPreload: true } });
    unmount();
    fileDiff.mockClear();
    await flush();
    expect(fileDiff).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...localStorage })).toBe(before);
    expect(document.cookie).toBe("");
  });
});
