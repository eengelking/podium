// An Admin paging through a person's stored Activity tells the person (#1074, mockup/podium-admin-read-notices.html, screen "Stored Activity"): the notice
// under the status band for the owner only, its X, and the ping an Admin's open stored view sends so the owner's notice lasts as long as the Admin reads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FocusView } from "./components/FocusView";
import { ActivityFeed } from "./components/ActivityFeed";
import { ReportDocs } from "./components/ReportDocs";
import { makeAgent, makeSession } from "./fixtures";
import { PING_MS, SessionReadsProvider } from "./sessionReads";
import { RespondProvider } from "./useRespond";
import type { RespondApi, SessionReadersReply } from "./respondApi";
import type { ActivityHistoryNote, ActivityHistoryPage, LifecycleConfig, RespondMe } from "./types";
import type { ActivityReply, FetchActivity, FetchHistory } from "./useActivityFeed";

const NOW = 1_791_648_000_000;
const CFG: LifecycleConfig = { staleAfterMs: 15_000, dropAfterMs: 60_000, lingerMs: 8_000, detachedHideAfterMs: 60_000 };
const DANA: RespondMe = { enabled: true, signedIn: true, name: "Dana", admin: false };
const ROOT: RespondMe = { enabled: true, signedIn: true, name: "Root", admin: true };

const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });

function api(me: RespondMe, readers: SessionReadersReply["readers"] = {}) {
  return {
    me: vi.fn(async () => me),
    signIn: vi.fn(),
    signOut: vi.fn(),
    sessionReadRecords: vi.fn(async () => ({ ok: true as const, serverTime: NOW, adminReads: [{ admin: "Root", startedAt: NOW - 3_600_000, lastSeenAt: NOW - 3_500_000, kind: "read" as const }], adminReading: [] })),
    sessionReads: vi.fn(async (): Promise<SessionReadersReply> => ({ ok: true, serverTime: NOW, readers })),
    sessionReading: vi.fn(async () => ({ ok: true as const })),
  } as unknown as RespondApi & { sessionReading: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the notice under the status band", () => {
  const page = async (a: RespondApi, owner: string | null = "Dana") => {
    const out = render(
      <RespondProvider api={a} flagsOn>
        <SessionReadsProvider rev={1}>
          <FocusView s={makeSession({ id: "s1", name: "stored-run", owner })} now={NOW} config={CFG} sort={{ key: null, dir: 1 }} onSort={() => {}} selectedAgent={null} flashAgent={null} onAgent={() => {}} />
        </SessionReadsProvider>
      </RespondProvider>,
    );
    await flush();
    return out;
  };
  const live = { activity: { s1: [{ admin: "Root", since: NOW - 20_000, until: Date.now() + 25_000 }] } };

  it("tells the owner in red, below the band, while an Admin pages, and a quiet line after", async () => {
    const { container } = await page(api(DANA, live));
    const note = container.querySelector("[data-testid='read-notice']")!;
    expect(note.textContent).toContain("Root (an Admin) is paging through the stored Activity of stored-run.");
    expect(note.classList.contains("crit")).toBe(true);
    const osum = container.querySelector(".osum")!;
    // The agent's whole text and live Activity notes (#1082) come last.
    expect(osum.lastElementChild!.getAttribute("data-testid")).toBe("read-notes-live");
    // The ask notes (#1073) come first and the Activity notes after them, both after the band.
    const kids = [...osum.children];
    expect(kids.indexOf(osum.querySelector("[data-testid='read-notes-activity']")!)).toBeGreaterThan(kids.indexOf(osum.querySelector(".band")!));
    const quiet = await page(api(DANA, {}));
    expect(quiet.container.querySelector("[data-testid='read-notes-activity'] [data-testid='read-record']")!.textContent).toContain("Root (an Admin) read the stored Activity of stored-run on");
  });

  it("has no X on the live notice", async () => {
    const { container } = await page(api(DANA, live));
    expect(container.querySelector("[data-testid='read-notice']")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Close notice: Admin reading your stored Activity" })).toBeNull();
  });

  it("shows nothing to the Admin who reads, to another person, or on a session nobody owns", async () => {
    for (const [me, owner] of [
      [ROOT, "Dana"],
      [{ ...DANA, name: "Alex" }, "Dana"],
      [ROOT, "Admin"],
      [DANA, null],
    ] as const) {
      const { container, unmount } = await page(api(me, live), owner);
      expect(container.querySelector("[data-testid='read-notes-activity']")).toBeNull();
      unmount();
    }
  });
});

describe("the ping of an Admin's open stored Activity", () => {
  const note: ActivityHistoryNote = { policy: "all", total: 3, since: NOW - 100_000, keptUntil: null, canRead: true, owner: "Dana" };
  const reply: ActivityReply = { entries: [], since: NOW, live: true, enabled: true, serverTime: NOW, history: note };
  const page: ActivityHistoryPage = { entries: [{ seq: 1, at: NOW - 1000, kind: "tool", text: "Edit a" }], olderBefore: null, total: 3, since: NOW - 100_000, keptUntil: null };

  async function feed(me: RespondMe, owner: string, canRead = true) {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const a = api(me);
    const s = makeSession({ id: "s1", owner, reporterVersion: "0.13.0", activityFeed: true, agents: [makeAgent({ id: "a1", startedAt: NOW })] });
    const fetchActivity = vi.fn<FetchActivity>(async () => ({ ...reply, history: { ...note, canRead } }));
    const fetchHistory = vi.fn<FetchHistory>(async () => page);
    render(
      <RespondProvider api={a} flagsOn>
        <ActivityFeed s={s} loop="a1" title="t" startedAt={NOW} active={false} now={NOW} adminOn fetchActivity={fetchActivity} fetchHistory={fetchHistory} />
      </RespondProvider>,
    );
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(PING_MS + 1);
    });
    return a;
  }

  it("pings the loop every 15 seconds while an Admin has another person's stored Activity open", async () => {
    const a = await feed(ROOT, "Dana");
    expect(a.sessionReading).toHaveBeenCalledWith("s1", "activity", "a1");
  });

  it("pings the live feed too (#1082): an Admin whose live fetch came back reads another person's agent, even when the stored history cannot be read", async () => {
    const a = await feed(ROOT, "Dana", false);
    expect(a.sessionReading).toHaveBeenCalledWith("s1", "live", "a1");
    expect(a.sessionReading).not.toHaveBeenCalledWith("s1", "activity", "a1");
  });

  it("does not ping for the owner, for an Admin reading their own session, or when the history cannot be read", async () => {
    expect((await feed(DANA, "Dana")).sessionReading).not.toHaveBeenCalled();
    cleanup();
    expect((await feed(ROOT, "Root")).sessionReading).not.toHaveBeenCalled();
    cleanup();
    expect((await feed(ROOT, "Dana", false)).sessionReading).not.toHaveBeenCalledWith("s1", "activity", "a1");
  });
});

describe("the ping of an Admin's open whole-text view (#1082)", () => {
  async function docs(me: RespondMe, owner: string) {
    vi.useFakeTimers();
    const a = api(me);
    const agent = makeAgent({ id: "a1", promptChars: 20, startedAt: NOW });
    const s = makeSession({ id: "s1", owner, agents: [agent] });
    render(
      <RespondProvider api={a} flagsOn>
        <ReportDocs s={s} a={agent} fetchText={async () => ({ prompt: "p", answer: null })} />
      </RespondProvider>,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Task prompt/ }));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(PING_MS + 1);
    });
    return a;
  }

  it("pings the agent while an Admin has another person's full text open", async () => {
    expect((await docs(ROOT, "Dana")).sessionReading).toHaveBeenCalledWith("s1", "text", "a1");
  });

  it("does not ping for the owner or for an Admin's own session", async () => {
    expect((await docs(DANA, "Dana")).sessionReading).not.toHaveBeenCalled();
    cleanup();
    expect((await docs(ROOT, "Root")).sessionReading).not.toHaveBeenCalled();
  });
});
