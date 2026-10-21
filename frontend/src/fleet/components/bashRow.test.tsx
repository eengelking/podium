// A Bash row that opens to its whole command and output (#431, mockup/podium-feed-expand.html), in the feed's list.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FeedList } from "./ActivityFeed";
import { ActivityOutputFlag, missingOutput, useRowAnchor } from "./BashRow";
import type { FeedEntry, FeedState } from "../useActivityFeed";
import { useRef } from "react";

const T0 = 1_000_000;
const entry = (seq: number, over: Partial<FeedEntry> = {}): FeedEntry => ({ seq, at: T0 + seq * 1000, kind: "tool", text: "Bash npm test", command: "npm test", ...over });
const feed = (entries: FeedEntry[]): FeedState => ({ entries, stored: null, loadOlder: async () => {}, seen: entries.length, fetchedAt: T0, failed: false, live: true, adminOff: false });

function show(entries: FeedEntry[], opts: { admin?: boolean | null; machine?: boolean | null } = {}) {
  const ui = (list: FeedEntry[]) => (
    <ActivityOutputFlag.Provider value={opts.admin === undefined ? true : opts.admin}>
      <FeedList feed={feed(list)} startedAt={T0} empty="none" machineOutput={opts.machine === undefined ? true : opts.machine} />
    </ActivityOutputFlag.Provider>
  );
  const r = render(ui(entries));
  return { ...r, again: (list: FeedEntry[]) => r.rerender(ui(list)) };
}

const rowOf = (i = 0) => document.querySelectorAll<HTMLLIElement>(".feed li")[i]!;
const tgl = (i = 0) => rowOf(i).querySelector<HTMLButtonElement>("button.tgl")!;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a Bash row", () => {
  it("is closed by default, with a real button that names what it controls", () => {
    show([entry(1)]);
    expect(rowOf()).toHaveClass("can");
    expect(rowOf()).not.toHaveClass("open");
    expect(tgl()).toHaveAttribute("aria-expanded", "false");
    expect(tgl().getAttribute("aria-controls")).toBeTruthy();
    expect(rowOf().querySelector(".xp")).toBeNull();
    expect(tgl().textContent).toContain("Bash");
    expect(tgl().textContent).toContain("npm test");
  });

  it("opens from a click anywhere on the row, and closes from another", () => {
    show([entry(1, { command: "npm test -- --watch=false" })]);
    fireEvent.click(rowOf().querySelector(".at")!);
    expect(rowOf()).toHaveClass("open");
    expect(tgl()).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(tgl().getAttribute("aria-controls")!)).toBe(rowOf().querySelector(".xp"));
    expect(rowOf().querySelector("pre.xcmd")!.textContent).toBe("npm test -- --watch=false");
    fireEvent.click(rowOf().querySelector(".k")!);
    expect(rowOf()).not.toHaveClass("open");
    expect(rowOf().querySelector(".xp")).toBeNull();
  });

  it("opens and closes from the button, as a key press does (a click with no pointer detail)", () => {
    show([entry(1)]);
    fireEvent.click(tgl(), { detail: 0 });
    expect(tgl()).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(tgl(), { detail: 0 });
    expect(tgl()).toHaveAttribute("aria-expanded", "false");
  });

  it("does not close when the opened part is clicked, so text there can be selected", () => {
    show([entry(1)]);
    fireEvent.click(tgl());
    fireEvent.click(rowOf().querySelector("pre.xcmd")!);
    fireEvent.click(rowOf().querySelector(".xh")!);
    expect(rowOf()).toHaveClass("open");
  });

  it("leaves a click that ends a text selection in the row alone, but a key press still toggles", () => {
    show([entry(1)]);
    const text = rowOf().querySelector(".arg")!;
    vi.spyOn(window, "getSelection").mockReturnValue({ isCollapsed: false, anchorNode: text.firstChild } as unknown as Selection);
    fireEvent.click(text, { detail: 1 });
    expect(rowOf()).not.toHaveClass("open");
    fireEvent.click(tgl(), { detail: 0 });
    expect(rowOf()).toHaveClass("open");
  });

  it("opens on a selection somewhere else on the page", () => {
    show([entry(1)]);
    vi.spyOn(window, "getSelection").mockReturnValue({ isCollapsed: false, anchorNode: document.body } as unknown as Selection);
    fireEvent.click(rowOf().querySelector(".at")!);
    expect(rowOf()).toHaveClass("open");
  });

  it("closes from Collapse and puts the focus back on the line", () => {
    show([entry(1)]);
    fireEvent.click(tgl());
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(rowOf()).not.toHaveClass("open");
    expect(tgl()).toHaveFocus();
  });

  it("says the size of a cut line to a screen reader and in the Command label", () => {
    const text = `Bash ${"x".repeat(295)}`;
    show([entry(1, { text, command: "y".repeat(1842) })]);
    expect(tgl().lastElementChild!.textContent).toBe(" Show whole command, 1,842 characters");
    expect(tgl().querySelector(".cut")!.textContent).toBe("…");
    fireEvent.click(tgl());
    expect(rowOf().querySelector(".xh")!.textContent).toContain("Command, 1,842 characters");
  });

  it("names 'Show command' with no output and 'Show output' with some", () => {
    show([entry(1), entry(2, { output: "ok", done: true })]);
    expect(tgl(0).lastElementChild!.textContent).toBe(" Show command");
    expect(tgl(1).lastElementChild!.textContent).toBe(" Show output");
  });

  it("marks [redacted] in the command and the output, and leaves a cut-off marker as plain muted text", () => {
    show([entry(1, { command: "curl -H 'Authorization: Bearer [redacted]'", output: "token=[redacted]\n\n[cut off at 20,000 characters]", done: true, outputCut: true })]);
    fireEvent.click(tgl());
    expect(rowOf().querySelector("pre.xcmd .rd")!.textContent).toBe("[redacted]");
    expect(rowOf().querySelector("pre.xout .rd")!.textContent).toBe("[redacted]");
    expect(rowOf().querySelector("pre.xout .mark")!.textContent).toBe("[cut off at 20,000 characters]");
  });

  it("draws text from a session as text, never as HTML", () => {
    show([entry(1, { command: "echo '<img src=x onerror=alert(1)>'", output: "<b>bold</b>", done: true })]);
    fireEvent.click(tgl());
    expect(rowOf().querySelector("img")).toBeNull();
    expect(rowOf().querySelector("pre.xout b")).toBeNull();
    expect(rowOf().querySelector("pre.xout")!.textContent).toBe("<b>bold</b>");
  });

  it("shows a cut line with no whole command (an older reporter) with no chevron and the reason", () => {
    show([entry(1, { text: `Bash ${"z".repeat(295)}`, command: undefined })]);
    expect(rowOf()).not.toHaveClass("can");
    expect(rowOf().querySelector("button")).toBeNull();
    expect(rowOf().querySelector(".chev")).toBeNull();
    expect(rowOf().querySelector(".nofull")!.textContent).toBe("cut at 300 characters; this reporter sends no more");
    fireEvent.click(rowOf());
    expect(rowOf()).not.toHaveClass("open");
  });

  it("leaves a short Bash row with no command, and every other tool row, as plain text", () => {
    show([entry(1, { text: "Bash ls", command: undefined }), entry(2, { text: `Read ${"p".repeat(300)}` })]);
    expect(rowOf(0).querySelector("button")).toBeNull();
    expect(rowOf(0).querySelector(".nofull")).toBeNull();
    expect(rowOf(1).querySelector("button")).toBeNull();
    expect(rowOf(1)).not.toHaveClass("can");
  });
});

describe("exit status", () => {
  it("is a bare check with its words for a screen reader for a call that succeeded", () => {
    show([entry(1, { output: "ok", done: true })]);
    const state = tgl().querySelector(".state .exit.ok")!;
    expect(state).toHaveAttribute("title", "Succeeded");
    expect(state.textContent).toBe("Succeeded, exit 0");
    expect(state.querySelector(".sr-only")).not.toBeNull();
    fireEvent.click(tgl());
    expect(rowOf().querySelector(".xh .exit.ok")).not.toBeNull();
  });

  it("is a cross and 'Exit N, failed' for a failed call with a code", () => {
    show([entry(1, { output: "boom", done: true, failed: true, exitCode: 2 })]);
    expect(tgl().querySelector(".state .exit.bad")!.textContent).toBe("Exit 2, failed");
    fireEvent.click(tgl());
    expect(rowOf().querySelector(".xh .exit.bad")!.textContent).toBe("Exit 2, failed");
    expect(rowOf().querySelector(".xh .exit.bad svg")).not.toBeNull();
  });

  it("is a cross and the one word 'Failed' when a call failed and no code is known", () => {
    show([entry(1, { output: "boom", done: true, failed: true })]);
    expect(tgl().querySelector(".state .exit.bad")!.textContent).toBe("Failed");
    fireEvent.click(tgl());
    expect(rowOf().querySelector(".xh .exit.bad")!.textContent).toBe("Failed");
  });

  it("counts a code that is not 0 as a failure even when the flag is missing", () => {
    show([entry(1, { output: "x", done: true, exitCode: 1 })]);
    expect(tgl().querySelector(".state .exit.bad")!.textContent).toBe("Exit 1, failed");
  });

  it("shows no status for a call that has not finished", () => {
    show([entry(1)]);
    expect(tgl().querySelector(".exit")).toBeNull();
    fireEvent.click(tgl());
    expect(rowOf().querySelector(".xh .exit")).toBeNull();
  });
});

describe("the output block", () => {
  it("shows the output wrapped in a block with no scroll box of its own, with Copy output", () => {
    show([entry(1, { output: "line one\nline two", done: true })]);
    fireEvent.click(tgl());
    const out = rowOf().querySelector("pre.xout")!;
    expect(out.textContent).toBe("line one\nline two");
    expect(out).toHaveAttribute("aria-label", "Output");
    expect(screen.getByRole("button", { name: "Copy output" })).toBeInTheDocument();
  });

  it("says a command that printed nothing printed nothing", () => {
    show([entry(1, { output: "", done: true })]);
    fireEvent.click(tgl());
    expect(rowOf().querySelector(".feedoff b")!.textContent).toBe("The command printed nothing.");
    expect(screen.queryByRole("button", { name: "Copy output" })).toBeNull();
  });

  it("shows a <persisted-output> stub as the text it is", () => {
    show([entry(1, { output: "<persisted-output>Output too large. Full output saved to: /tmp/x</persisted-output>", done: true })]);
    fireEvent.click(tgl());
    expect(rowOf().querySelector("pre.xout")!.textContent).toContain("<persisted-output>Output too large");
  });

  it("says why there is none, in words, in the order the mockups give", () => {
    const reason = (entries: FeedEntry[], opts: Parameters<typeof show>[1] = {}) => {
      const r = show(entries, opts);
      fireEvent.click(tgl());
      const box = rowOf().querySelector(".feedoff")!;
      const out = [box.querySelector("b")!.textContent, box.querySelector(".ghost")!.textContent];
      r.unmount();
      return out;
    };
    expect(reason([entry(1)], { admin: false })).toEqual(["Output is turned off by the Admin.", "Someone with Admin access can turn it on in Admin > Settings > Feature flags."]);
    expect(reason([entry(1)], { machine: false })).toEqual(["Output is turned off for this machine.", "Turn on the activityOutput option (Send a Bash command’s output) of podium-reporter, then run /reload-plugins in that session."]);
    expect(reason([entry(1)], { machine: null })[0]).toBe("Output is turned off for this machine.");
    expect(reason([entry(1)])).toEqual(["Output was not collected.", "Output is only collected while this panel is open."]);
    expect(reason([entry(1, { key: "h7" })], { admin: false })).toEqual(["Output is not kept in history.", "Only the command is stored. Output is shown while someone is watching the session and is gone after."]);
    // A page that does not know the flag (History) does not blame the Admin.
    expect(reason([entry(1)], { admin: null })[0]).toBe("Output was not collected.");
    // A stored entry the live window also holds is told as a live one is.
    expect(reason([entry(1, { key: "h7", live: true })])[0]).toBe("Output was not collected.");
  });

  it("builds the same words without a component", () => {
    expect(missingOutput({ stored: false, adminOn: true, machineOn: true }).title).toBe("Output was not collected.");
  });
});

describe("Copy", () => {
  const withClipboard = (writeText: (t: string) => Promise<void>) => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  afterEach(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));

  it("copies the command exactly as shown and reads Copied with a check for 1.6 s", async () => {
    const writeText = vi.fn(async () => {});
    withClipboard(writeText);
    show([entry(1, { command: "echo [redacted]", output: "a\nb", done: true })]);
    fireEvent.click(tgl());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    });
    expect(writeText).toHaveBeenCalledWith("echo [redacted]");
    const btn = rowOf().querySelector<HTMLButtonElement>(".xh .btn")!;
    expect(btn.textContent).toBe("Copied");
    expect(btn.querySelector("svg")).not.toBeNull();
    // Copying must not close the row.
    expect(rowOf()).toHaveClass("open");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1599);
    });
    expect(btn.textContent).toBe("Copied");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(btn.textContent).toBe("Copy command");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy output" }));
    });
    expect(writeText).toHaveBeenLastCalledWith("a\nb");
  });

  it("shows nothing at all when the clipboard refuses", async () => {
    withClipboard(async () => {
      throw new Error("denied");
    });
    show([entry(1)]);
    fireEvent.click(tgl());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    });
    expect(screen.getByRole("button", { name: "Copy command" })).toBeInTheDocument();
    expect(screen.queryByText("Copied")).toBeNull();
    expect(screen.queryByText(/failed/i)).toBeNull();
  });
});

describe("open rows across a refresh", () => {
  it("keeps a row open when its entry is sent again with output, and does not open its neighbour", () => {
    const r = show([entry(1), entry(2, { command: "ls" })]);
    fireEvent.click(tgl(1));
    expect(rowOf(1)).toHaveClass("open");
    r.again([entry(1), entry(2, { command: "ls", output: "a.txt", done: true })]);
    expect(rowOf(1)).toHaveClass("open");
    expect(rowOf(1).querySelector("pre.xout")!.textContent).toBe("a.txt");
    expect(rowOf(0)).not.toHaveClass("open");
  });

  it("keeps the open row with its entry when an entry before it leaves the window, and forgets one that left", () => {
    const r = show([entry(1), entry(2, { command: "two" }), entry(3, { command: "three" })]);
    fireEvent.click(tgl(1));
    r.again([entry(2, { command: "two" }), entry(3, { command: "three" }), entry(4, { command: "four" })]);
    expect(rowOf(0)).toHaveClass("open");
    expect(rowOf(0).querySelector("pre.xcmd")!.textContent).toBe("two");
    expect(rowOf(1)).not.toHaveClass("open");
    // An entry that left and came back as a new one is closed.
    r.again([entry(3, { command: "three" }), entry(4, { command: "four" })]);
    r.again([entry(1, { key: "x" }), entry(3, { command: "three" })]);
    expect(rowOf(0)).not.toHaveClass("open");
  });

  it("keeps an open stored row open when its live twin arrives with output", () => {
    const r = show([entry(1, { key: "h5" })]);
    fireEvent.click(tgl());
    r.again([entry(1, { key: "h5", live: true, output: "done", done: true })]);
    expect(rowOf()).toHaveClass("open");
    expect(rowOf().querySelector("pre.xout")!.textContent).toBe("done");
  });
});

describe("the list's place when a row opens or closes", () => {
  let height = 1000;
  let scrollTop = 0;
  const tops = new Map<Element, number>();
  beforeEach(() => {
    vi.useRealTimers();
    height = 1000;
    scrollTop = 0;
    tops.clear();
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 300 });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", { configurable: true, get: () => scrollTop, set: (v: number) => void (scrollTop = v) });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const t = tops.get(this) ?? 0;
      return { top: t, bottom: t, left: 0, right: 0, width: 0, height: 0, x: 0, y: t, toJSON: () => ({}) };
    });
  });
  afterEach(() => {
    for (const k of ["scrollHeight", "clientHeight", "scrollTop"]) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  });

  it("stays at the end of a list that follows the newest row when a row opens", () => {
    show([entry(1), entry(2)]);
    expect(scrollTop).toBe(1000);
    height = 1400;
    fireEvent.click(tgl(1));
    expect(scrollTop).toBe(1400);
  });

  it("follows the newest row when its output arrives", () => {
    const r = show([entry(1)]);
    height = 1300;
    r.again([entry(1, { output: "x".repeat(500), done: true })]);
    expect(scrollTop).toBe(1300);
  });
});

describe("useRowAnchor", () => {
  function Probe(props: { following: boolean; onAnchor: (a: ReturnType<typeof useRowAnchor>) => void }) {
    const ref = useRef<HTMLOListElement>(null);
    props.onAnchor(useRowAnchor(ref, props.following));
    return (
      <ol ref={ref}>
        <li />
      </ol>
    );
  }

  it("does nothing with no row noted, and moves the list by the difference after one", () => {
    let a!: ReturnType<typeof useRowAnchor>;
    render(<Probe following={false} onAnchor={(x) => (a = x)} />);
    const list = document.querySelector("ol")!;
    const li = document.querySelector("li")!;
    let top = 0;
    let scrollTop = 100;
    Object.defineProperty(list, "scrollTop", { configurable: true, get: () => scrollTop, set: (v: number) => void (scrollTop = v) });
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue({ top: 0 } as DOMRect);
    vi.spyOn(li, "getBoundingClientRect").mockImplementation(() => ({ top }) as DOMRect);
    a.after();
    expect(scrollTop).toBe(100);
    top = 40;
    a.before(li);
    top = 70;
    a.after();
    expect(scrollTop).toBe(130);
    // A row whose top was above the list comes back to the top of it.
    top = -300;
    a.before(li);
    top = -250;
    a.after();
    expect(scrollTop).toBe(130 - 250);
  });
});
