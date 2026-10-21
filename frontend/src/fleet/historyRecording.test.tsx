// A recording that is kept after its session ended is reached from History (#353): the row says so, and the session's read-only
// page shows its final state with the recording's layer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { HistoryView } from "./HistoryView";
import { makeAgent, makeRecording, makeSession } from "./fixtures";
import type { RespondApi } from "./respondApi";
import type { HistoryRow } from "./types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "#/history");
});

const KEPT = new Date(2026, 9, 21, 3, 10).getTime();
const row: HistoryRow = {
  id: "s1", name: "api-refactor", project: "~/dev/billing", model: "claude-opus-5-5", modelFamily: "opus",
  startedAt: 1_000_000, endedAt: 4_600_000, durationSec: 3600, costUsd: 12.84, blowouts: 2, agents: 3, endReason: "prompt_input_exit", clearedFrom: null, clearedInto: null,
};
const second = { ...row, id: "s2", name: "docs-rewrite" };

function server(rows: (typeof row)[], recording: ReturnType<typeof makeRecording> | null) {
  vi.stubGlobal("EventSource", class { onerror = null; readyState = 1; addEventListener() {} close() {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/history?day=")) {
      const q = new URL(url, "http://x").searchParams;
      return new Response(JSON.stringify({ day: q.get("day"), sessions: rows, total: rows.length, page: 1, pageSize: 50 }), { status: 200 });
    }
    if (url.endsWith("/sessions/s1")) return new Response(JSON.stringify(makeSession({ owner: "Ed", status: "done", recording, agents: [makeAgent({ id: "a1", description: "Map call sites", status: "done" })] })), { status: 200 });
    return new Response("{}", { status: 404 });
  }));
}

const me = (name = "Ed", admin = false) => ({ me: vi.fn(async () => ({ enabled: true, signedIn: true, name, admin })), recordingDelete: vi.fn(async () => ({ ok: true, entries: 1, bytes: 1 })) }) as unknown as RespondApi & { recordingDelete: ReturnType<typeof vi.fn> };

describe("History and a kept recording", () => {
  it("says under the session's name until when its recording is kept, and opens the session from it", async () => {
    server([{ ...row, recording: { keptUntil: KEPT } }, second], null);
    render(<HistoryView initialDay="2026-10-10" />);
    const link = await screen.findByRole("button", { name: "recording kept until 2026-10-21 03:10" });
    expect(link.parentElement).toHaveClass("clr");
    expect(link.title).toBe("Open the recording of this session");
    expect(link.closest("td")).toBe(screen.getByRole("button", { name: "api-refactor" }).closest("td"));
    expect(screen.getAllByText(/recording kept/)).toHaveLength(1);
    fireEvent.click(link);
    expect(await screen.findByRole("button", { name: /Back to/ })).toBeInTheDocument();
    expect(window.location.hash).toContain("open=s1");
  });

  it("says a recording is kept when it is not known until when", async () => {
    server([{ ...row, recording: { keptUntil: null } }], null);
    render(<HistoryView initialDay="2026-10-10" />);
    expect(await screen.findByRole("button", { name: "recording kept" })).toBeInTheDocument();
  });

  it("opens an ended session on its final state, with the kept layer, Open replay and Delete recording for its owner", async () => {
    server([{ ...row, recording: { keptUntil: KEPT } }], makeRecording({ state: "stopped", stoppedBy: "Maya Okafor", keptUntil: KEPT }));
    const api = me();
    const { container } = render(<HistoryView initialDay="2026-10-10" respondApi={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "api-refactor" }));
    const layer = await vi.waitFor(() => {
      const el = container.querySelector<HTMLElement>(".rec-bar.kept");
      if (!el) throw new Error("no layer yet");
      return el;
    });
    expect(container.querySelector(".osum .band")).toHaveClass("done");
    expect(layer.textContent).toContain("Maya Okafor stopped the recording");
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(within(layer).getByRole("button", { name: "Open replay" })).toBeInTheDocument();
    fireEvent.click(within(layer).getByRole("button", { name: "Delete recording" }));
    fireEvent.click(within(within(layer).getByRole("alertdialog")).getByRole("button", { name: "Delete recording" }));
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(api.recordingDelete).toHaveBeenCalledWith("s1");
    expect(container.querySelector(".rec-bar")).toBeNull();
  });

  it("shows no layer for a session that was never recorded", async () => {
    server([row], null);
    const { container } = render(<HistoryView initialDay="2026-10-10" respondApi={me()} />);
    fireEvent.click(await screen.findByRole("button", { name: "api-refactor" }));
    await screen.findByRole("button", { name: /Back to/ });
    expect(container.querySelector(".rec-bar")).toBeNull();
  });
});
