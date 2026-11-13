// Admin > Reporting sections for cost, tokens, model and effort mix and context at the end (#723): cost per call and per session and the sessions that used each tool
// (Tools), and the mix and context fullness (Sessions), with the Harness filter and each table's export. The token section on Spend is in spendReporting.test.tsx.
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

async function open(page: "Sessions" | "Tools", table: string, server = fakeServer({ unlocked: true })) {
  render(<AdminView />);
  fireEvent.click(await screen.findByRole("button", { name: page }));
  await screen.findByRole("table", { name: table });
  return server;
}
const row = (table: HTMLElement, text: string) => within(table).getByText(text).closest("tr")!;

describe("the Tools page: cost", () => {
  it("asks for cost by model and by tool for the period and the harness", async () => {
    const s = await open("Tools", "Cost per call by model");
    await screen.findByRole("table", { name: "Sessions that used each tool" });
    expect(s.calls).toEqual(expect.arrayContaining([`GET /reports/costs?${PERIOD}&breakdown=model`, `GET /reports/costs?${PERIOD}&breakdown=tool`]));
  });

  it("draws cost per call and per session, a dash for a model with no price, and says a tool has no cost of its own", async () => {
    await open("Tools", "Cost per call by model");
    const table = screen.getByRole("table", { name: "Cost per call by model" });
    expect(row(table, "Opus 5.5")).toHaveTextContent("Claude Code964,118$412.80$0.10$4.30");
    expect(row(table, "mystery-model")).toHaveTextContent("Claude Code3122–––");
    expect(row(table, "Priced total")).toHaveTextContent("964,118$412.80$0.10$4.30");
    expect(screen.getByText("calls on a model without a price, left out")).toBeInTheDocument();
    expect(screen.getByText(/A tool has no cost of its own\./)).toBeInTheDocument();
  });

  it("draws the average spend of the sessions that called each tool, with a dash when none was priced", async () => {
    await open("Tools", "Sessions that used each tool");
    const table = screen.getByRole("table", { name: "Sessions that used each tool" });
    expect(row(table, "Bash")).toHaveTextContent("Bash248$2.7131");
    expect(row(table, "WebFetch")).toHaveTextContent("WebFetch52–27");
    expect(screen.getByRole("region", { name: "What sessions that used a tool cost" })).toHaveTextContent("not what the tool cost");
  });

  it("downloads each table as it is shown", async () => {
    const s = await open("Tools", "Cost per call by model");
    fireEvent.click(screen.getByRole("button", { name: "Download cost per call CSV" }));
    await waitFor(() => expect(s.calls.some((c) => c.includes("/reports/costs?") && c.includes("breakdown=model") && c.includes("format=csv"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Download sessions by tool JSON" }));
  });
});

describe("the Sessions page: mix and context", () => {
  it("draws the model mix as shares of each period, and switches to effort", async () => {
    const s = await open("Sessions", "Model mix by period");
    const table = screen.getByRole("table", { name: "Model mix by period" });
    expect(row(table, "2026-10-05")).toHaveTextContent("6050%33%17%");
    expect(within(table).getByRole("columnheader", { name: "No model" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Effort" }));
    const effort = await screen.findByRole("table", { name: "Effort mix by period" });
    expect(within(effort).getByRole("columnheader", { name: "Not reported" })).toBeInTheDocument();
    expect(s.calls.some((c) => c.includes("breakdown=mix") && c.includes("mixof=effort"))).toBe(true);
  });

  it("counts sessions by how full the context was, and compacted and cleared sessions, and says what is left out", async () => {
    await open("Sessions", "Context fullness at the end");
    const table = screen.getByRole("table", { name: "Context fullness at the end" });
    expect(row(table, "Under 50%")).toHaveTextContent("6053%");
    expect(row(table, "Above 80%")).toHaveTextContent("1412%");
    expect(screen.getByText("sessions compacted on their own").previousSibling).toHaveTextContent("18");
    expect(screen.getByText("sessions continued after /clear").previousSibling).toHaveTextContent("7");
    expect(screen.getByText(/6 sessions reported no context size and are left out/)).toBeInTheDocument();
  });

  it("narrows to one harness", async () => {
    const s = await open("Sessions", "Context fullness at the end");
    fireEvent.change(screen.getByLabelText("Harness"), { target: { value: "opencode" } });
    await waitFor(() => expect(s.calls.some((c) => c.includes("breakdown=context") && c.includes("harness=opencode"))).toBe(true));
    await waitFor(() => expect(screen.getByRole("table", { name: "Context fullness at the end" })).toHaveTextContent("Total, OpenCode"));
  });
});
