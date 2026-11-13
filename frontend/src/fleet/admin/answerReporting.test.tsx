// Admin > Reporting > Sessions (#725): the sections for the answers sent from Podium and how long sessions waited for them, with the harness filter,
// the dash before counting began, and each table's export.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AdminView } from "./AdminView";
import { fakeServer } from "./fakeAdmin";

class QuietSource {
  onerror = null;
  readyState = 1;
  addEventListener() {}
  close() {}
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("EventSource", QuietSource);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 20, 12));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PERIOD = "from=2026-09-21&to=2026-10-20";

async function openSessions(server = fakeServer({ unlocked: true })) {
  render(<AdminView />);
  fireEvent.click(await screen.findByRole("button", { name: "Sessions" }));
  await screen.findByRole("table", { name: "Answers sent through Podium by day" });
  await screen.findByRole("table", { name: "Wait before an answer, by kind" });
  return server;
}
const row = (table: HTMLElement, text: string) => within(table).getByText(text).closest("tr")!;

describe("answers sent through Podium", () => {
  it("asks for both sections for the period, by the unit the page has", async () => {
    const s = await openSessions();
    expect(s.calls).toEqual(expect.arrayContaining([`GET /reports/sessiontime?${PERIOD}&by=day&breakdown=answers`, `GET /reports/sessiontime?${PERIOD}&by=day&breakdown=answerwait`]));
  });

  it("draws the kinds per period, the whole period and each harness, and says when counting began", async () => {
    await openSessions();
    const table = screen.getByRole("table", { name: "Answers sent through Podium by day" });
    expect(row(table, "2026-10-05")).toHaveTextContent("2026-10-0533135758");
    expect(row(table, "2026-10-12")).toHaveTextContent("2026-10-122592844");
    expect(row(table, "Whole period, all harnesses")).toHaveTextContent("5822715102");
    expect(row(table, "Claude Code")).toHaveTextContent("5320712" + "92");
    expect(row(table, "OpenCode")).toHaveTextContent("520310");
    expect(screen.getByText("answers sent, since 2026-10-05").previousElementSibling).toHaveTextContent("102");
    expect(screen.getByText("tool permissions").previousElementSibling).toHaveTextContent("58");
    expect(screen.getByText("questions answered").previousElementSibling).toHaveTextContent("22");
    expect(screen.getByText("plans answered").previousElementSibling).toHaveTextContent("7");
    expect(screen.getAllByText(/Answers are recorded from 2026-10-05,/)).toHaveLength(2);
    expect(screen.getByText(/Only the kind and the time of each answer are kept, never what was said/)).toBeInTheDocument();
  });

  it("shows a dash, in the muted ink, for a period before counting began, and not a zero", async () => {
    await openSessions();
    const table = screen.getByRole("table", { name: "Answers sent through Podium by day" });
    const early = row(table, "2026-09-21");
    expect(early).toHaveTextContent("2026-09-21–––––");
    for (const cell of within(early).getAllByRole("cell").slice(1)) expect(cell).toHaveClass("muted");
  });

  it("names the chart's figures for a screen reader", async () => {
    await openSessions();
    expect(screen.getByRole("img", { name: "Answers sent through Podium per day: 4 periods from 2026-09-21 to 2026-10-12, highest 58 on 2026-10-05, 102 in all." })).toBeInTheDocument();
  });

  it("pages the period table, newest first", async () => {
    await openSessions();
    const table = screen.getByRole("table", { name: "Answers sent through Podium by day" });
    const firsts = within(table).getAllByRole("row").slice(1, 5).map((r) => within(r).getAllByRole("cell")[0]!.textContent);
    expect(firsts).toEqual(["2026-10-12", "2026-10-05", "2026-09-28", "2026-09-21"]);
    expect(screen.getAllByText("Showing 1 to 4 of 4")).toHaveLength(2);
  });
});

describe("how long sessions waited for an answer", () => {
  it("gives the median and the 90th percentile in minutes and seconds, by kind, with a dash for a message", async () => {
    await openSessions();
    expect(screen.getByText("median wait", { selector: ".cap" }).previousElementSibling).toHaveTextContent("0:32");
    expect(screen.getByText("90th percentile", { selector: ".cap" }).previousElementSibling).toHaveTextContent("5:20");
    const table = screen.getByRole("table", { name: "Wait before an answer, by kind" });
    expect(row(table, "Permission for a tool")).toHaveTextContent("580:182:10");
    expect(row(table, "A question")).toHaveTextContent("221:409:00");
    expect(row(table, "A plan")).toHaveTextContent("73:0511:00");
    const message = row(table, "A message");
    expect(message).toHaveTextContent("A message–––");
    for (const cell of within(message).getAllByTitle("A message is sent to a session that is not waiting, so it has no wait")) expect(cell).toHaveClass("muted");
    expect(row(table, "Whole period, all harnesses")).toHaveTextContent("580:325:20");
    expect(row(table, "Claude Code")).toHaveTextContent("510:305:00");
    expect(row(table, "OpenCode")).toHaveTextContent("70:456:30");
  });

  it("gives each period, with a dash before counting began", async () => {
    await openSessions();
    const table = screen.getByRole("table", { name: "Wait before an answer, by day" });
    expect(row(table, "2026-09-28")).toHaveTextContent("2026-09-28–––");
    expect(row(table, "2026-10-05")).toHaveTextContent("510:406:20");
    expect(screen.getByText(/The median and the 90th percentile are read from time classes/)).toBeInTheDocument();
  });
});

describe("the filters", () => {
  it("narrows both sections to a harness, and each table's footer says which", async () => {
    const s = await openSessions();
    fireEvent.change(screen.getByLabelText("Harness"), { target: { value: "opencode" } });
    await waitFor(() => expect(s.calls.some((c) => c.includes("breakdown=answers") && c.includes("harness=opencode"))).toBe(true));
    await waitFor(() => expect(s.calls.some((c) => c.includes("breakdown=answerwait") && c.includes("harness=opencode"))).toBe(true));
    const answers = await screen.findByRole("table", { name: "Answers sent through Podium by day" });
    await waitFor(() => expect(within(answers).getByText("Whole period, OpenCode")).toBeInTheDocument());
    expect(within(answers).queryByText("Claude Code")).toBeNull();
    expect(within(screen.getByRole("table", { name: "Wait before an answer, by kind" })).getByText("Whole period, OpenCode")).toBeInTheDocument();
  });

  it("holds both sections back, with the line that says why, while a person, group or model filter is set", async () => {
    const server = fakeServer({ unlocked: true });
    server.groups.push({ id: 1, name: "Platform" });
    const s = await openSessions(server);
    const before = s.calls.filter((c) => c.includes("breakdown=answer")).length;
    fireEvent.change(screen.getByLabelText("Group"), { target: { value: "Platform" } });
    await waitFor(() => expect(screen.queryByRole("table", { name: "Answers sent through Podium by day" })).toBeNull());
    expect(screen.queryByRole("table", { name: "Wait before an answer, by kind" })).toBeNull();
    expect(s.calls.filter((c) => c.includes("breakdown=answer")).length).toBe(before);
  });

  it("downloads each table as it is shown: the exact query with the format added", async () => {
    const s = await openSessions();
    fireEvent.click(screen.getByRole("button", { name: "Download answers sent CSV" }));
    await waitFor(() => expect(s.calls.some((c) => c.includes("breakdown=answers") && c.includes("format=csv"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Download wait before an answer JSON" }));
    expect(screen.getByRole("button", { name: "Download wait before an answer CSV" })).toBeEnabled();
  });
});

describe("a period with no answer that has a wait", () => {
  /** The two sections answered with `reply` for a breakdown that starts with `answers`, and everything else as the fake server has it. */
  function answerWith(reply: (breakdown: string) => unknown) {
    const server = fakeServer({ unlocked: true });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const breakdown = /breakdown=(answers|answerwait)\b/.exec(url)?.[1];
      if (!breakdown || url.includes("format=")) return real(input, init);
      return new Response(JSON.stringify({ report: "sessiontime", from: "2026-09-21", to: "2026-10-20", by: "day", tz: "Europe/Berlin", basedOn: "rollups and live", oldestDay: "2026-03-02", harnesses: ["claude-code"], columns: [], ...(reply(breakdown) as object) }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    return server;
  }
  const dash = { permission: null, question: null, plan: null, message: null, all: null };

  it("still draws the figures and the note when counting began part way through and only messages were sent", async () => {
    answerWith((b) =>
      b === "answers"
        ? { partial: true, answersSince: "2026-10-05", rows: [], total: { permission: 0, question: 0, plan: 0, message: 12, all: 12 }, periods: [{ period: "2026-09-21", ...dash }], byHarness: [] }
        : { partial: true, answersSince: "2026-10-05", rows: [], total: { answers: 0, medianS: null, p90S: null }, periods: [{ period: "2026-09-21", answers: null, medianS: null, p90S: null }], kinds: [{ kind: "message", answers: 12, medianS: null, p90S: null }], byHarness: [] },
    );
    render(<AdminView />);
    fireEvent.click(await screen.findByRole("button", { name: "Sessions" }));
    const kinds = await screen.findByRole("table", { name: "Wait before an answer, by kind" });
    expect(within(kinds).getByText("A message").closest("tr")).toHaveTextContent("A message–––");
    expect(await screen.findAllByText(/Answers are recorded from 2026-10-05,/)).toHaveLength(2);
  });

  it("says so, once for each section, when nothing was answered at all", async () => {
    answerWith((b) =>
      b === "answers"
        ? { partial: false, answersSince: "2026-03-02", rows: [], total: { permission: 0, question: 0, plan: 0, message: 0, all: 0 }, periods: [], byHarness: [] }
        : { partial: false, answersSince: "2026-03-02", rows: [], total: { answers: 0, medianS: null, p90S: null }, periods: [], kinds: [{ kind: "message", answers: 0, medianS: null, p90S: null }], byHarness: [] },
    );
    render(<AdminView />);
    fireEvent.click(await screen.findByRole("button", { name: "Sessions" }));
    expect(await screen.findAllByText("No answers were sent from Podium in this period.")).toHaveLength(2);
    expect(screen.queryByRole("table", { name: "Wait before an answer, by kind" })).toBeNull();
  });
});
