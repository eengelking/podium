// A file's diff in the shared modal (#319, mockup/podium-file-diff.html): who gets a button, what the modal shows for
// each status, that a diff is drawn as text, and that focus returns to the row.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { makeSession } from "./fixtures";
import { FilesList, diffAccess } from "./components/FilesList";
import { FileDiffModal, WRAP_KEY } from "./components/FileDiffModal";
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
    render(<FileDiffModal sessionId="s" file={REPORT.files[0]!} since="start" onClose={() => {}} />);
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
  it("sits at the right of the bottom row, with the note at the left", async () => {
    const api = fakeApi(vi.fn(async () => ok({ truncated: true, shownLines: 2000, totalLines: 10190 })));
    await show({ api });
    fireEvent.click(screen.getByRole("button", { name: "Open diff of src/a.ts" }));
    await flush();
    const row = screen.getByRole("dialog").querySelector(".mf")!;
    expect([...row.children].map((e) => e.className)).toEqual(["foot-note", "sw"]);
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
