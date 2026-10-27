import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { HistoryView, localDay } from "./HistoryView";
import { makeAgent, makeSession, makeState } from "./fixtures";
import type { PeersApi, RespondApi } from "./respondApi";
import type { HistoryRow } from "./types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "#/history");
});

const row: HistoryRow = {
  id: "s1", name: "api-refactor", project: "~/dev/billing", model: "claude-opus-5-5", modelFamily: "opus",
  startedAt: 1_000_000, endedAt: 4_600_000, durationSec: 3600, costUsd: 12.84, blowouts: 2, agents: 3, endReason: "prompt_input_exit", clearedFrom: null, clearedInto: null,
};

function stubEventSource() {
  vi.stubGlobal("EventSource", class { onerror = null; readyState = 1; addEventListener() {} close() {} });
}

function server(rows: HistoryRow[], sessionOver: Parameters<typeof makeSession>[0] = {}, total = rows.length) {
  const calls: string[] = [];
  stubEventSource();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes("/history?day=")) {
      const q = new URL(url, "http://x").searchParams;
      return new Response(JSON.stringify({ day: q.get("day"), sessions: rows, total, page: Number(q.get("page")), pageSize: Number(q.get("pageSize")) }), { status: 200 });
    }
    if (url.endsWith("/sessions/s1")) return new Response(JSON.stringify(makeSession({ ...sessionOver, status: "done", agents: [makeAgent({ id: "a1", description: "Map call sites", status: "done" })] })), { status: 200 });
    return new Response("{}", { status: 404 });
  }));
  return calls;
}

describe("history page", () => {
  it("draws the shared top bar: Fleet, Board, no History button, and the connection pill (#452)", async () => {
    server([row]);
    const { container } = render(<HistoryView initialDay="2026-10-10" />);
    const bar = container.querySelector("header.top") as HTMLElement;
    expect(bar.querySelector(".pill")?.textContent).toBe("History");
    const buttons = [...bar.querySelectorAll("a.btn")].map((a) => a.textContent);
    expect(buttons).toEqual(["Fleet", "Board"]);
    expect(screen.queryByRole("link", { name: "Live fleet" })).toBeNull();
    expect(bar.textContent).toMatch(/reporters? live|connecting|disconnected/i);
    await screen.findByRole("button", { name: "api-refactor" });
  });

  it("links the two parts of a conversation split by /clear (#206)", async () => {
    server([{ ...row, clearedInto: "9c1e2f4a5b6c7d8e", clearedFrom: "238da512ffeeddcc" }]);
    render(<HistoryView initialDay="2026-10-10" />);
    expect(await screen.findByRole("button", { name: "continued in 9c1e2f4a" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "after /clear of 238da512" })).toBeInTheDocument();
  });

  it("puts each /clear link on its own line under the end reason, so none is cut off (#208)", async () => {
    server([{ ...row, clearedInto: "9c1e2f4a5b6c7d8e", clearedFrom: "238da512ffeeddcc" }]);
    render(<HistoryView initialDay="2026-10-10" />);
    const into = await screen.findByRole("button", { name: "continued in 9c1e2f4a" });
    const from = screen.getByRole("button", { name: "after /clear of 238da512" });
    expect(into.parentElement).toHaveClass("clr");
    expect(from.parentElement).toHaveClass("clr");
    expect(into.closest("td")?.textContent).not.toContain("·");
  });

  it("shows Signed in as and a My reporters link with its waiting count while messaging is on (#452)", async () => {
    server([row]);
    const quiet = { onerror: null, readyState: 1, addEventListener() {}, close() {} };
    const respondApi = { me: vi.fn(async () => ({ enabled: true, signedIn: true, name: "Ed", admin: false })) } as unknown as RespondApi;
    const peersApi = { read: vi.fn(async () => ({ requests: [{ id: "a" }, { id: "b" }] })) } as unknown as PeersApi;
    const fleetOptions = {
      open: () => quiet,
      fetchState: async () => makeState({ features: { respond: true, "activity-feed": true, "peer-messaging": true } }),
    };
    render(<HistoryView initialDay="2026-10-10" fleetOptions={fleetOptions} respondApi={respondApi} peersApi={peersApi} />);
    expect(await screen.findByText("Ed")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "My reporters · 2 waiting" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("lists a day's ended sessions with summary columns", async () => {
    const calls = server([row]);
    render(<HistoryView initialDay="2026-10-10" />);
    expect(await screen.findByRole("button", { name: "api-refactor" })).toBeInTheDocument();
    expect(calls.find((c) => c.includes("/history?"))).toBe("/api/fleet/history?day=2026-10-10&page=1&pageSize=50");
    const cells = [...document.querySelectorAll("tbody td")].map((td) => td.textContent);
    expect(cells).toEqual(["api-refactor", "~/dev/billing", "Opus 5.5", expect.any(String), "1h 00m", "$12.84", "2", "3", "prompt_input_exit"]);
    expect(screen.getByText("1 sessions ended")).toBeInTheDocument();
  });

  // Each of these renders the whole fleet or Admin tree and clicks through it: about 0.1 s on a quiet machine, but past the 5 s default on a CI runner
  // running coverage (#681). The limit is wide for the same reason as the Admin paging test, and the work is unchanged.
  it("opens a read-only orchestrator page from stored rows, with agent detail, and goes back", async () => {
    server([row]);
    render(<HistoryView initialDay="2026-10-10" />);
    fireEvent.click(await screen.findByRole("button", { name: "api-refactor" }));
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("api-refactor");
    fireEvent.click(document.querySelector('button.trow[data-agent="a1"]')!);
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Map call sites");
    fireEvent.click(screen.getByRole("button", { name: /Back to 2026-10-10/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "api-refactor" })).toBeInTheDocument());
  }, 30_000);

  it("shows the orchestrator's steps, tools and skills on its page when the session reported them (#75)", async () => {
    server([row], { loop: { skills: ["code-review"], lastTool: "Edit", toolCalls: 5, toolCounts: { Edit: 3, Read: 2 }, steps: { done: 7, total: null } } });
    render(<HistoryView initialDay="2026-10-10" />);
    fireEvent.click(await screen.findByRole("button", { name: "api-refactor" }));
    await screen.findByRole("heading", { level: 1 });
    fireEvent.click(document.querySelector("button.trow.root")!);
    const side = document.querySelector(".side") as HTMLElement;
    expect(side.textContent).toContain("7 model requests");
    expect(side.textContent).toContain("Tools used (5 calls)");
    expect(side.textContent).toContain("code-review");
  });

  it("changes day, and says so when nothing ended", async () => {
    const calls = server([]);
    render(<HistoryView initialDay="2026-10-10" />);
    expect(await screen.findByText("No sessions ended on 2026-10-10.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Day"), { target: { value: "2026-10-09" } });
    await waitFor(() => expect(calls).toContain("/api/fleet/history?day=2026-10-09&page=1&pageSize=50"));
    expect(localDay(new Date(2026, 0, 5).getTime())).toBe("2026-01-05");
  });

  describe("paging (#195)", () => {
    it("counts the whole day in the header, not the rows on the page", async () => {
      server([row], {}, 120);
      render(<HistoryView initialDay="2026-10-10" />);
      expect(await screen.findByText("120 sessions ended")).toBeInTheDocument();
      expect(screen.getByText("Showing 1 to 50 of 120")).toBeInTheDocument();
      expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    });

    it("asks the server for the next page and keeps it in the address", async () => {
      const calls = server([row], {}, 120);
      render(<HistoryView initialDay="2026-10-10" />);
      fireEvent.click(await screen.findByRole("button", { name: "Next" }));
      await waitFor(() => expect(calls).toContain("/api/fleet/history?day=2026-10-10&page=2&pageSize=50"));
      expect(window.location.hash).toBe("#/history?day=2026-10-10&page=2&size=50");
      expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    });

    it("goes back to page 1 when the rows per page or the day changes", async () => {
      const calls = server([row], {}, 120);
      render(<HistoryView initialDay="2026-10-10" />);
      fireEvent.click(await screen.findByRole("button", { name: "Next" }));
      await screen.findByText("Page 2 of 3");
      fireEvent.change(screen.getByLabelText("Rows per page"), { target: { value: "25" } });
      await waitFor(() => expect(calls).toContain("/api/fleet/history?day=2026-10-10&page=1&pageSize=25"));
      fireEvent.click(await screen.findByRole("button", { name: "Next" }));
      await screen.findByText("Page 2 of 5");
      fireEvent.change(screen.getByLabelText("Day"), { target: { value: "2026-10-09" } });
      await waitFor(() => expect(calls).toContain("/api/fleet/history?day=2026-10-09&page=1&pageSize=25"));
    });

    it("starts from the page named in the address", async () => {
      window.history.replaceState(null, "", "#/history?day=2026-10-08&page=3&size=25");
      const calls = server([row], {}, 120);
      render(<HistoryView />);
      await screen.findByRole("button", { name: "api-refactor" });
      expect(calls.find((c) => c.includes("/history?"))).toBe("/api/fleet/history?day=2026-10-08&page=3&pageSize=25");
    });

    it("returns to the same page when the browser goes back from an opened session", async () => {
      server([row], {}, 120);
      render(<HistoryView initialDay="2026-10-10" />);
      fireEvent.click(await screen.findByRole("button", { name: "Next" }));
      await screen.findByText("Page 2 of 3");
      fireEvent.click(screen.getByRole("button", { name: "api-refactor" }));
      expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("api-refactor");
      expect(window.location.hash).toContain("open=s1");
      window.history.back();
      expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
      expect(window.location.hash).not.toContain("open=");
    });

    it("keeps the table on screen while the next page loads, but not across a change of day (#273)", async () => {
      let release: (r: Response) => void = () => {};
      let n = 0;
      stubEventSource();
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (!url.includes("/history?")) return new Response("{}", { status: 404 });
        const q = new URL(url, "http://x").searchParams;
        const body = (name: string) => new Response(JSON.stringify({ day: q.get("day"), sessions: [{ ...row, name }], total: 120, page: Number(q.get("page")), pageSize: 50 }), { status: 200 });
        if (++n === 1) return body("api-refactor");
        return new Promise<Response>((resolve) => { release = () => resolve(body("page-two")); });
      }));
      render(<HistoryView initialDay="2026-10-10" />);
      fireEvent.click(await screen.findByRole("button", { name: "Next" }));
      await waitFor(() => expect(n).toBe(2));
      expect(screen.getByRole("button", { name: "api-refactor" })).toBeInTheDocument();
      expect(screen.queryByText("Loading…")).toBeNull();
      release(new Response());
      expect(await screen.findByRole("button", { name: "page-two" })).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("Day"), { target: { value: "2026-10-09" } });
      await waitFor(() => expect(n).toBe(3));
      expect(await screen.findByText("Loading…")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "page-two" })).toBeNull();
      release(new Response());
    });

    it("shows no pager when nothing ended, and keeps the error message", async () => {
      server([]);
      render(<HistoryView initialDay="2026-10-10" />);
      expect(await screen.findByText("No sessions ended on 2026-10-10.")).toBeInTheDocument();
      expect(screen.queryByText(/Rows per page/)).toBeNull();
      cleanup();
      stubEventSource();
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
      render(<HistoryView initialDay="2026-10-10" />);
      expect(await screen.findByText(/Cannot reach the Podium server/)).toBeInTheDocument();
    });
  });
});
