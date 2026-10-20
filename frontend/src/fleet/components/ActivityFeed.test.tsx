import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { ActivityFeed } from "./ActivityFeed";
import { fmtDay } from "../format";
import { RespondError, type RespondApi } from "../respondApi";
import { RespondProvider } from "../useRespond";
import type { ActivityHistoryNote, ActivityHistoryPage } from "../types";
import { SidePanel } from "./SidePanel";
import { ORCHESTRATOR_ROW as MAIN_LOOP } from "../logic";
import { EVERY_KEY, type ActivityReply, type FetchActivity, type FetchHistory } from "../useActivityFeed";
import { makeAgent, makeSession } from "../fixtures";
import type { SessionView } from "../types";

const T0 = 1_000_000;
const entry = (seq: number, over: Partial<ActivityReply["entries"][number]> = {}) => ({ seq, at: T0 + seq * 1000, kind: "tool" as const, text: `Read f${seq}`, ...over });
const reply = (entries: ActivityReply["entries"], over: Partial<ActivityReply> = {}): ActivityReply => ({ entries, since: T0, live: true, enabled: true, serverTime: T0, ...over });

/** A fetch that answers with each reply in turn, then keeps answering with the last one. */
function fetcher(...replies: ActivityReply[]) {
  const queue = [...replies];
  return vi.fn<FetchActivity>(async () => (queue.length > 1 ? queue.shift()! : queue[0] ?? reply([])));
}

function show(opts: { session?: Partial<SessionView>; active?: boolean; fetch?: ReturnType<typeof fetcher>; adminOn?: boolean } = {}) {
  const a = makeAgent({ id: "a1", startedAt: T0 });
  const s = makeSession({ reporterVersion: "0.13.0", activityFeed: true, agents: [a], ...opts.session });
  const fetchActivity = opts.fetch ?? fetcher(reply([]));
  const r = render(<ActivityFeed s={s} loop="a1" title="Map call sites · general-purpose" startedAt={T0} active={opts.active ?? true} now={T0} adminOn={opts.adminOn} fetchActivity={fetchActivity} />);
  const rerender = (adminOn: boolean) =>
    r.rerender(<ActivityFeed s={s} loop="a1" title="Map call sites · general-purpose" startedAt={T0} active={opts.active ?? true} now={T0} adminOn={adminOn} fetchActivity={fetchActivity} />);
  return { ...r, fetchActivity, rerender };
}

const flush = () => act(async () => {
  await vi.advanceTimersByTimeAsync(0);
});
const wait = (ms: number) => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
});

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  try {
    window.localStorage.clear();
  } catch {
    // no storage in this environment
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setHidden(false);
  document.body.classList.remove("modal-open");
});

describe("Activity feed", () => {
  it("fetches when the panel opens and then every 5 s by default, for that session and loop", async () => {
    const { fetchActivity } = show();
    await flush();
    expect(fetchActivity).toHaveBeenCalledTimes(1);
    expect(fetchActivity).toHaveBeenLastCalledWith("s1", "a1", 5);
    await wait(4999);
    expect(fetchActivity).toHaveBeenCalledTimes(1);
    await wait(1);
    expect(fetchActivity).toHaveBeenCalledTimes(2);
  });

  it("uses the interval the viewer picks, and remembers it", async () => {
    const { fetchActivity } = show();
    await flush();
    fireEvent.change(screen.getByRole("combobox", { name: "Refresh interval" }), { target: { value: "20" } });
    await flush();
    expect(window.localStorage.getItem(EVERY_KEY)).toBe("20");
    const n = fetchActivity.mock.calls.length;
    await wait(19_999);
    expect(fetchActivity.mock.calls.length).toBe(n);
    await wait(1);
    expect(fetchActivity).toHaveBeenLastCalledWith("s1", "a1", 20);
    cleanup();
    const again = show();
    await flush();
    expect(again.fetchActivity).toHaveBeenLastCalledWith("s1", "a1", 20);
    expect(screen.getByRole("combobox", { name: "Refresh interval" })).toHaveValue("20");
  });

  it("stops fetching once the panel closes", async () => {
    const { fetchActivity, unmount } = show();
    await flush();
    unmount();
    await wait(60_000);
    expect(fetchActivity).toHaveBeenCalledTimes(1);
  });

  it("does not fetch while the tab is hidden, and fetches again when it is shown", async () => {
    const { fetchActivity } = show();
    await flush();
    act(() => setHidden(true));
    await wait(30_000);
    expect(fetchActivity).toHaveBeenCalledTimes(1);
    act(() => setHidden(false));
    await flush();
    expect(fetchActivity).toHaveBeenCalledTimes(2);
  });

  it("starts from now: entries already held when the viewer arrived are not shown, later ones are, newest last", async () => {
    show({ fetch: fetcher(reply([entry(1), entry(2)]), reply([entry(1), entry(2), entry(3), entry(4, { kind: "text", text: "Two failures." })])) });
    await flush();
    expect(screen.getByText(/Watching from now/)).toBeInTheDocument();
    expect(screen.queryByText("f1")).toBeNull();
    await wait(5000);
    const rows = screen.getByRole("list", { name: "Recent activity, newest last" }).querySelectorAll("li");
    expect([...rows].map((li) => li.textContent)).toEqual([expect.stringContaining("Read f3"), expect.stringContaining("Two failures.")]);
    expect(rows[0]!.querySelector(".name")!.textContent).toBe("Read");
    expect(screen.getByText("Last 2 of 2 since you started watching")).toBeInTheDocument();
  });

  it("marks redacted text", async () => {
    show({ fetch: fetcher(reply([]), reply([entry(1, { text: "Bash curl -H x-api-key: [redacted] http://x" })])) });
    await flush();
    await wait(5000);
    expect(document.querySelector(".feed .rd")!.textContent).toBe("[redacted]");
  });

  it("says how to turn the option on, and fetches nothing, when it is off", async () => {
    const { fetchActivity } = show({ session: { activityFeed: false } });
    await flush();
    expect(screen.getByText(/Recent tool calls and text appear here while the agent works/)).toBeInTheDocument();
    expect(screen.getByText(/activityFeed/)).toBeInTheDocument();
    expect(fetchActivity).not.toHaveBeenCalled();
  });

  it("tells a reporter older than 0.13.0 to update, and fetches nothing", async () => {
    const { fetchActivity } = show({ session: { reporterVersion: "0.12.0", activityFeed: null } });
    await flush();
    expect(screen.getByText(/podium-reporter 0.13.0 or later/)).toBeInTheDocument();
    expect(fetchActivity).not.toHaveBeenCalled();
  });

  it("shows nothing for a session reported by settings hooks", () => {
    show({ session: { reporter: "hooks", reporterVersion: null } });
    expect(screen.queryByText("Activity")).toBeNull();
  });

  it("for a finished agent fetches once, offers no interval, and says no more will come", async () => {
    const { fetchActivity } = show({ active: false });
    await flush();
    await wait(60_000);
    expect(fetchActivity).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("combobox", { name: "Refresh interval" })).toBeNull();
    expect(screen.getByText("Agent finished, no more updates")).toBeInTheDocument();
  });
});

describe("Activity feed turned off by the Admin", () => {
  const OFF = /The activity feed is turned off by the Admin\./;
  const off = (over: Partial<ActivityReply> = {}) => reply([], { enabled: false, since: null, ...over });

  it("shows the Admin note with no feed, no interval and no Expand, and keeps checking at the normal interval", async () => {
    const { fetchActivity } = show({ fetch: fetcher(off()) });
    await flush();
    expect(screen.getByText(OFF)).toBeInTheDocument();
    expect(screen.getByText(/Someone with Admin access can turn it back on in Admin > Settings > Feature flags\. Nothing is fetched or kept while it is off\./)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Recent activity, newest last" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Refresh interval" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
    expect(screen.queryByText(/activityFeed/)).toBeNull();
    await wait(5000);
    expect(fetchActivity).toHaveBeenCalledTimes(2);
  });

  it("resumes the feed without a reload once a reply says it is on again, starting from then", async () => {
    show({ fetch: fetcher(reply([]), reply([entry(1)]), off(), reply([entry(1), entry(2)], { since: T0 + 9000 }), reply([entry(1), entry(2), entry(3)], { since: T0 + 9000 })) });
    await flush();
    await wait(5000);
    expect(document.querySelectorAll(".feed li:not(.empty)")).toHaveLength(1);
    await wait(5000);
    expect(screen.getByText(OFF)).toBeInTheDocument();
    await wait(5000);
    expect(screen.queryByText(OFF)).toBeNull();
    // what was shown before it went off is gone, and what the new lease held when the viewer came back is not backfilled
    expect(screen.getByText(/Watching from now/)).toBeInTheDocument();
    await wait(5000);
    const rows = [...document.querySelectorAll(".feed li")].map((li) => li.textContent);
    expect(rows).toEqual([expect.stringContaining("Read f3")]);
  });

  it("shows the Admin note at once when the console learns the flag is off, and fetches again as soon as it is back on", async () => {
    const { fetchActivity, rerender } = show();
    await flush();
    expect(fetchActivity).toHaveBeenCalledTimes(1);
    rerender(false);
    expect(screen.getByText(OFF)).toBeInTheDocument();
    await flush();
    expect(fetchActivity).toHaveBeenCalledTimes(2);
    rerender(true);
    await flush();
    expect(fetchActivity).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(OFF)).toBeNull();
  });

  it("the Admin note wins over the reporter option being off", async () => {
    const { fetchActivity } = show({ session: { activityFeed: false }, adminOn: false });
    await flush();
    expect(screen.getByText(OFF)).toBeInTheDocument();
    expect(screen.queryByText(/Recent tool calls and text appear here/)).toBeNull();
    expect(fetchActivity).not.toHaveBeenCalled();
  });

  it("with the flag on, the reporter-option note is unchanged", async () => {
    show({ session: { activityFeed: false }, adminOn: true });
    await flush();
    expect(screen.getByText(/Recent tool calls and text appear here while the agent works/)).toBeInTheDocument();
    expect(screen.queryByText(OFF)).toBeNull();
  });

  it("an open modal shows the same note when the flag goes off, with no feed and no interval", async () => {
    show({ fetch: fetcher(reply([]), off()) });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    const d = screen.getByRole("dialog");
    await wait(5000);
    expect(d).toHaveTextContent(OFF);
    expect(d.querySelector(".feed")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Refresh interval" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the Admin flag reaches both panels from the side panel", () => {
  const panel = (selectedAgent: string, activityFeedOn: boolean) => {
    const s = makeSession({ reporterVersion: "0.13.0", activityFeed: false, agents: [makeAgent({ id: "a1", startedAt: T0 })] });
    return render(
      <SidePanel events={[]} sessions={{ s1: s }} gone={{}} selected={s} selectedAgent={selectedAgent} shown={12} onShown={() => {}} isNew={() => false} onOpenEvent={() => {}} onAgent={() => {}} onBack={() => {}} now={T0} activityFeedOn={activityFeedOn} />,
    );
  };

  it.each([["agent", "a1"], ["orchestrator", MAIN_LOOP]])("the %s panel shows the Admin note when the flag is off, and the reporter note when it is on", (_n, loop) => {
    panel(loop, false);
    expect(screen.getByText(/The activity feed is turned off by the Admin\./)).toBeInTheDocument();
    cleanup();
    panel(loop, true);
    expect(screen.queryByText(/turned off by the Admin/)).toBeNull();
    expect(screen.getByText(/Recent tool calls and text appear here while/)).toBeInTheDocument();
  });
});

describe("Activity modal", () => {
  it("opens over a blurred app and closes with Esc, returning focus to Expand", async () => {
    show({ fetch: fetcher(reply([]), reply([entry(1)])) });
    await flush();
    const expand = screen.getByRole("button", { name: "Expand" });
    expand.focus();
    fireEvent.click(expand);
    const d = screen.getByRole("dialog");
    expect(d).toHaveAttribute("aria-modal", "true");
    expect(d).toHaveAccessibleName("Activity");
    expect(document.body.classList.contains("modal-open")).toBe(true);
    expect(screen.getByRole("button", { name: "Close (Esc)" })).toHaveFocus();
    await wait(5000);
    expect(d.querySelectorAll(".feed li")).toHaveLength(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.classList.contains("modal-open")).toBe(false);
    expect(expand).toHaveFocus();
  });

  it("closes with the X and with a click on the dimmed area, not on the dialog", async () => {
    show();
    await flush();
    const open = () => fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    open();
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close (Esc)" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    open();
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps fetching on one schedule while the modal is open", async () => {
    const { fetchActivity } = show();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    await wait(5000);
    expect(fetchActivity).toHaveBeenCalledTimes(2);
  });

  describe("footer (#146)", () => {
    const footer = (c: HTMLElement) => c.querySelector(".feedfoot.stat")!;

    it("words the update time the same way from the first second, so its width does not change as the clock ticks", async () => {
      const { container } = show();
      await flush();
      const seen: string[] = [];
      for (const at of [0, 1000, 2000, 3000]) {
        vi.setSystemTime(at + Date.now() - (Date.now() % 1000));
        await wait(at === 0 ? 0 : 1000);
        seen.push(footer(container).children[1]!.textContent!);
      }
      expect(seen.some((t) => /just now/i.test(t))).toBe(false);
      for (const t of seen) expect(t).toMatch(/^Updated \d+s ago$/);
    });

    it("keeps each text in its own single-line cell, the count one carrying the full text as a tooltip", async () => {
      const entries = Array.from({ length: 14 }, (_, i) => entry(i + 1));
      const { container } = show({ fetch: fetcher(reply(entries)) });
      await flush();
      const [count, when] = Array.from(footer(container).children) as HTMLElement[];
      expect(footer(container).children).toHaveLength(2);
      expect(count!.className).toContain("count");
      expect(count!.getAttribute("title")).toBe(count!.textContent);
      expect(when!.className).toContain("when");
    });

    it("keeps the note under the footer out of the status row", async () => {
      const { container } = show();
      await flush();
      expect(container.querySelectorAll(".feedfoot")).toHaveLength(2);
      expect(container.querySelectorAll(".feedfoot.stat")).toHaveLength(1);
    });

    it("gives the modal the same footer", async () => {
      show();
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "Expand" }));
      expect(screen.getByRole("dialog").querySelector(".feedfoot.stat")!.children).toHaveLength(2);
    });
  });
});

describe("stored history (#432)", () => {
  const SINCE = Date.parse("2026-10-12T12:00:00");
  const UNTIL = Date.parse("2026-11-11T12:00:00");
  const NOTE_TAIL = "Only the owner and the Admin can open it. Secrets are removed before they leave the session.";
  const note = (over: Partial<ActivityHistoryNote> = {}): ActivityHistoryNote => ({ policy: "after", total: 412, since: SINCE, keptUntil: UNTIL, canRead: true, owner: "Ed", ...over });
  const stored = (seq: number, over: Partial<ActivityReply["entries"][number]> = {}) => ({ seq, at: T0 - 100_000 + seq * 1000, kind: "tool" as const, text: `Edit s${seq}`, ...over });
  const page = (seqs: number[], olderBefore: number | null): ActivityHistoryPage => ({ entries: seqs.map((n) => stored(n)), olderBefore, total: 412, since: SINCE, keptUntil: UNTIL });
  const history = (...pages: ActivityHistoryPage[]) => {
    const queue = [...pages];
    return vi.fn<FetchHistory>(async () => (queue.length > 1 ? queue.shift()! : queue[0]!));
  };
  const rows = () => [...screen.getByRole("list", { name: "Recent activity, newest last" }).querySelectorAll("li")].map((li) => li.textContent);

  function showKept(opts: { fetch: ReturnType<typeof fetcher>; history: ReturnType<typeof history>; active?: boolean; isMain?: boolean }) {
    const s = makeSession({ reporterVersion: "0.13.0", activityFeed: true, agents: [makeAgent({ id: "a1", startedAt: T0 })] });
    return render(<ActivityFeed s={s} loop="a1" title="Map call sites" startedAt={T0} active={opts.active ?? true} now={T0} isMain={opts.isMain} adminOn fetchActivity={opts.fetch} fetchHistory={opts.history} />);
  }

  it("ended and kept: shows the newest stored page, the count and the date it goes, no refresh control, and a Show older row", async () => {
    const h = history(page([10, 11, 12], 10));
    const { container } = showKept({ fetch: fetcher(reply([], { live: true, history: note() })), history: h, active: false, isMain: true });
    await flush();
    expect(h).toHaveBeenCalledWith("s1", "a1", null, 20);
    expect(rows()).toEqual([expect.stringContaining("Edit s10"), expect.stringContaining("Edit s11"), expect.stringContaining("Edit s12")]);
    expect(screen.getByText(`412 stored entries since ${fmtDay(SINCE)}`)).toBeInTheDocument();
    expect(screen.getByText("Session ended, no more updates")).toBeInTheDocument();
    expect(screen.getByText(`Kept until ${fmtDay(UNTIL)}, then purged. ${NOTE_TAIL}`)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Refresh interval" })).toBeNull();
    expect(container.querySelector(".feedfoot.stat.older")!.textContent).toBe("Showing the newest 3Show older");
    await wait(60_000);
    expect(h).toHaveBeenCalledTimes(1);
  });

  it("live and kept: keeps the refresh control and counts one entry in the singular", async () => {
    showKept({ fetch: fetcher(reply([], { history: note({ keptUntil: null, policy: "all", total: 1 }) })), history: history(page([1], null)) });
    await flush();
    expect(screen.getByText(`1 stored entry since ${fmtDay(SINCE)}`)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Refresh interval" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
  });

  it("under purge-when-the-session-ends says so, and leaves out a missing date", async () => {
    showKept({ fetch: fetcher(reply([], { history: note({ keptUntil: null, policy: "end", since: null }) })), history: history(page([1], null)) });
    await flush();
    expect(screen.getByText("412 stored entries")).toBeInTheDocument();
    expect(screen.getByText(`Kept until the session ends, then removed. ${NOTE_TAIL}`)).toBeInTheDocument();
  });

  it("loads older pages on request and shows each entry once, with no cap", async () => {
    const h = history(page([30, 31, 32], 30), page([27, 28, 29, 30], 27), page([1, 2], null));
    const { container } = showKept({ fetch: fetcher(reply([], { history: note() })), history: h });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    await flush();
    expect(h).toHaveBeenLastCalledWith("s1", "a1", 30, 20);
    expect(rows().map((t) => t!.replace(/^.*(Edit s\d+).*$/, "$1"))).toEqual(["Edit s27", "Edit s28", "Edit s29", "Edit s30", "Edit s31", "Edit s32"]);
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    await flush();
    expect(h).toHaveBeenLastCalledWith("s1", "a1", 27, 20);
    expect(rows()).toHaveLength(8);
    expect(container.querySelector(".feedfoot.stat.older")).toBeNull();
  });

  it("shows live entries after the stored page without a copy of one the page holds, and keeps more than 20", async () => {
    const dup = entry(1, { at: stored(12).at, text: "Edit s12" });
    const many = Array.from({ length: 25 }, (_, i) => entry(i + 2, { at: T0 + i * 1000, text: `Live ${i + 2}` }));
    showKept({ fetch: fetcher(reply([], { history: note() }), reply([dup], { history: note({ total: 413 }) }), reply([dup, ...many], { history: note({ total: 438 }) })), history: history(page([11, 12], null)) });
    await flush();
    await wait(5000);
    expect(rows()).toHaveLength(2);
    await wait(5000);
    expect(rows()).toHaveLength(27);
    expect(screen.getByText(`438 stored entries since ${fmtDay(SINCE)}`)).toBeInTheDocument();
    expect(rows().filter((t) => t!.includes("Edit s12"))).toHaveLength(1);
  });

  it("another viewer: never asks for the entries, says who can open them, and shows nothing", async () => {
    const h = history(page([1], null));
    const { container } = showKept({ fetch: fetcher(reply([], { history: note({ canRead: false }) })), history: h });
    await flush();
    expect(h).not.toHaveBeenCalled();
    expect(rows()).toEqual(["History is kept for this session. Only Ed and the Admin can open it."]);
    expect(screen.getByText("Nothing to show")).toBeInTheDocument();
    expect(screen.getByText("Stored activity can hold anything an agent read or ran, so it is not shown to other viewers.")).toBeInTheDocument();
    expect(container.querySelector(".feedfoot.stat.older")).toBeNull();
  });

  it("a viewer who is not signed in is told to sign in as the owner or an Admin", async () => {
    const api = { me: vi.fn(async () => ({ enabled: true, signedIn: false })) } as unknown as RespondApi;
    const s = makeSession({ reporterVersion: "0.13.0", activityFeed: true });
    render(
      <RespondProvider api={api} flagsOn>
        <ActivityFeed s={s} loop="a1" title="t" startedAt={T0} active now={T0} adminOn fetchActivity={fetcher(reply([], { history: note({ canRead: false, owner: null }) }))} fetchHistory={history(page([1], null))} />
      </RespondProvider>,
    );
    await flush();
    expect(rows()).toEqual(["History is kept for this session. Sign in as its owner or an Admin to open it."]);
  });

  it.each([401, 403])("a %i from the history route shows the other-viewer state and is not asked again", async (status) => {
    const h = vi.fn<FetchHistory>(async () => {
      throw new RespondError(status, { error: "no" });
    });
    showKept({ fetch: fetcher(reply([], { history: note() })), history: h });
    await flush();
    expect(rows()).toEqual(["History is kept for this session. Only Ed and the Admin can open it."]);
    expect(screen.getByText("Nothing to show")).toBeInTheDocument();
    await wait(15_000);
    expect(h).toHaveBeenCalledTimes(1);
  });

  it("a 403 on Show older drops to the other-viewer state", async () => {
    const h = vi.fn<FetchHistory>(async (_s, _l, before) => {
      if (before) throw new RespondError(403, {});
      return page([5, 6], 5);
    });
    showKept({ fetch: fetcher(reply([], { history: note() })), history: h });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    await flush();
    expect(rows()).toEqual(["History is kept for this session. Only Ed and the Admin can open it."]);
  });

  it("another failure of the history route is retried on the next fetch, and one on Show older is reported", async () => {
    let calls = 0;
    const h = vi.fn<FetchHistory>(async (_s, _l, before) => {
      calls += 1;
      if (calls === 1 || before) throw new Error("HTTP 500");
      return page([5, 6], 5);
    });
    showKept({ fetch: fetcher(reply([], { history: note() })), history: h });
    await flush();
    expect(screen.queryByText("Could not reach the server, retrying")).toBeNull();
    await wait(5000);
    expect(rows()).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    await flush();
    expect(screen.getByText("Could not reach the server, retrying")).toBeInTheDocument();
    expect(rows()).toHaveLength(2);
  });

  it("a 500 from the history route does not hold back the live entries", async () => {
    const h = vi.fn<FetchHistory>(async () => {
      throw new Error("HTTP 500");
    });
    showKept({ fetch: fetcher(reply([], { history: note() }), reply([entry(1)], { history: note() })), history: h });
    await flush();
    await wait(5000);
    expect(rows()).toEqual([expect.stringContaining("Read f1")]);
    expect(h).toHaveBeenCalledTimes(2);
  });

  it("under keep-everything says the history stays until the session is removed, with no day count", async () => {
    showKept({ fetch: fetcher(reply([], { history: note({ keptUntil: null, policy: "all" }) })), history: history(page([1], null)) });
    await flush();
    expect(screen.getByText(`Kept until the session is removed from Podium. ${NOTE_TAIL}`)).toBeInTheDocument();
    expect(screen.queryByText(/30 days/)).toBeNull();
  });

  describe("a loop change while a page is pending", () => {
    const deferred = <T,>() => {
      let resolve!: (v: T) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
      return { promise, resolve, reject };
    };
    const el = (loop: string, fetch: ReturnType<typeof fetcher>, h: ReturnType<typeof history>) => {
      const s = makeSession({ reporterVersion: "0.13.0", activityFeed: true, agents: [makeAgent({ id: "a1", startedAt: T0 })] });
      return <ActivityFeed s={s} loop={loop} title="t" startedAt={T0} active now={T0} adminOn fetchActivity={fetch} fetchHistory={h} />;
    };

    it("drops the newest page that arrives late", async () => {
      const late = deferred<ActivityHistoryPage>();
      const h = vi.fn<FetchHistory>((_s, l) => (l === "a1" ? late.promise : Promise.resolve(page([50, 51], null))));
      const f = fetcher(reply([], { history: note() }));
      const r = render(el("a1", f, h));
      await flush();
      r.rerender(el("a2", f, h));
      await flush();
      expect(rows()).toEqual([expect.stringContaining("s50"), expect.stringContaining("s51")]);
      await act(async () => late.resolve(page([30, 31], null)));
      await flush();
      expect(rows()).toEqual([expect.stringContaining("s50"), expect.stringContaining("s51")]);
    });

    it.each(["resolves", "fails"])("drops an older page that %s late, and Show older works again on the new loop", async (how) => {
      const late = deferred<ActivityHistoryPage>();
      const h = vi.fn<FetchHistory>(async (_s, l, before) => {
        if (l === "a1") return before ? late.promise : page([30, 31], 30);
        return before ? page([40, 41], null) : page([50, 51], 50);
      });
      const f = fetcher(reply([], { history: note() }));
      const r = render(el("a1", f, h));
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "Show older" }));
      await flush();
      r.rerender(el("a2", f, h));
      await flush();
      await act(async () => (how === "resolves" ? late.resolve(page([20, 21], null)) : late.reject(new RespondError(403, {}))));
      await flush();
      expect(rows()).toEqual([expect.stringContaining("s50"), expect.stringContaining("s51")]);
      expect(screen.queryByText("Nothing to show")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Show older" }));
      await flush();
      expect(h).toHaveBeenLastCalledWith("s1", "a2", 50, 20);
      expect(rows()).toHaveLength(4);
    });
  });

  it("keeps the viewer's place when older entries are prepended", async () => {
    let height = 100;
    let top = 0;
    const proto = HTMLElement.prototype;
    Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(proto, "scrollTop", { configurable: true, get: () => top, set: (v: number) => void (top = v) });
    try {
      const h = vi.fn<FetchHistory>(async (_s, _l, before) => {
        if (before) height = 160;
        return before ? page([28, 29], null) : page([30, 31], 30);
      });
      showKept({ fetch: fetcher(reply([], { history: note() })), history: h });
      await flush();
      expect(top).toBe(100);
      fireEvent.click(screen.getByRole("button", { name: "Show older" }));
      await flush();
      expect(rows()).toHaveLength(4);
      expect(top).toBe(160);
    } finally {
      delete (proto as unknown as Record<string, unknown>).scrollHeight;
      delete (proto as unknown as Record<string, unknown>).scrollTop;
    }
  });

  it("drops what it showed when a reply says the history is gone or the feed is off", async () => {
    showKept({ fetch: fetcher(reply([], { history: note() }), reply([])), history: history(page([1, 2], null)) });
    await flush();
    expect(rows()).toHaveLength(2);
    await wait(5000);
    expect(screen.getByText(/Watching from now/)).toBeInTheDocument();
    expect(screen.queryByText(/stored entr/)).toBeNull();
  });

  it("resets with the admin turning the feed off", async () => {
    showKept({ fetch: fetcher(reply([], { history: note() }), reply([], { enabled: false })), history: history(page([1, 2], null)) });
    await flush();
    await wait(5000);
    expect(screen.getByText("The activity feed is turned off by the Admin.")).toBeInTheDocument();
  });

  it("the modal shows the same rows, count and note", async () => {
    showKept({ fetch: fetcher(reply([], { history: note() })), history: history(page([1, 2], 1)) });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(`412 stored entries since ${fmtDay(SINCE)}`)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Show older" })).toBeInTheDocument();
    expect(within(dialog).getByText(`Kept until ${fmtDay(UNTIL)}, then purged. ${NOTE_TAIL}`)).toBeInTheDocument();
  });

  it("a reply without history reads exactly as before and never asks the history route", async () => {
    const h = history(page([1], null));
    const { container } = showKept({ fetch: fetcher(reply([entry(1)]), reply([entry(1), entry(2)])), history: h });
    await flush();
    expect(screen.getByText(/Watching from now/)).toBeInTheDocument();
    expect(screen.getByText("Nothing yet")).toBeInTheDocument();
    expect(screen.getByText("Kept only while someone is watching. Closing this clears it. Secrets are removed before they leave the session.")).toBeInTheDocument();
    await wait(5000);
    expect(screen.getByText("Last 1 of 1 since you started watching")).toBeInTheDocument();
    expect(container.querySelector(".older")).toBeNull();
    expect(h).not.toHaveBeenCalled();
  });

  it("a plain session without a history fetcher falls back to the console's route (not asked under the default policy)", async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => reply([]) }));
    vi.stubGlobal("fetch", f);
    const s = makeSession({ reporterVersion: "0.13.0", activityFeed: true });
    render(<ActivityFeed s={s} loop="a1" title="t" startedAt={T0} active now={T0} adminOn />);
    await flush();
    expect(f).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
