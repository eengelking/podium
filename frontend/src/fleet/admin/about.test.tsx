// Admin > About (#862): what the server and its reporters are running, and the Copy details button.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AdminView } from "./AdminView";
import { fakeServer } from "./fakeAdmin";
import { aboutText, rangeText, reporterLabel, upText, type AboutView } from "./aboutText";

class QuietSource {
  onerror = null;
  readyState = 1;
  addEventListener() {}
  close() {}
}
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("EventSource", QuietSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openAbout(opts: Parameters<typeof fakeServer>[0] = {}) {
  const srv = fakeServer({ unlocked: true, ...opts });
  render(<AdminView />);
  fireEvent.click(await screen.findByRole("button", { name: "About" }));
  await screen.findByRole("heading", { level: 2, name: "Podium server" });
  return srv;
}

const cells = (table: HTMLElement) => within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));

const table = (heading: string) => within(screen.getByRole("region", { name: heading })).getByRole("table");

describe("Admin About page", () => {
  it("is the last page of the Server group and opens with one header, About, with Copy details in it", async () => {
    await openAbout();
    expect(screen.getByRole("button", { name: "About" })).toHaveAttribute("aria-current", "page");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("About");
    expect(screen.getByRole("button", { name: "Copy details" })).toBeEnabled();
  });

  it("shows the server, what it is built with and the database from what the server answered, with no Build row for a release", async () => {
    await openAbout();
    const server = cells(table("Podium server"));
    expect(server.map((r) => r[0])).toEqual(["Version", "Running as", "Started", "System"]);
    expect(server[0]).toEqual(["Version", "1.1.0"]);
    expect(server[1]).toEqual(["Running as", "Stand-alone"]);
    expect(server[2]![1]).toMatch(/ · up 3 days 4 h$/);
    expect(server[3]).toEqual(["System", "darwin arm64"]);
    const stack = cells(table("Built with"));
    expect(stack.map((r) => r[0])).toEqual(["Node.js", "Express", "React", "TypeScript"]);
    expect(stack[0]).toEqual(["Node.js", "v24.11.0"]);
    expect(stack[1]).toEqual(["Express", "5.3.0"]);
    expect(stack[2]![1]).toMatch(/^\d+\.\d+\.\d+/);
    expect(stack[3]![1]).toMatch(/^\d+\.\d+\.\d+/);
    expect(cells(table("Database"))).toEqual([["Adapter", "SQLite"], ["Engine version", "3.50.4"], ["Schema version", "52"], ["Size", "412.0 MB"]]);
  });

  it("adds a Build row when the server is not a release, and leaves out a size the database cannot tell", async () => {
    const srv = fakeServer({ unlocked: true });
    srv.about.server.build = "430d135c";
    srv.about.database.sizeBytes = null;
    render(<AdminView />);
    fireEvent.click(await screen.findByRole("button", { name: "About" }));
    await screen.findByRole("heading", { level: 2, name: "Podium server" });
    expect(cells(table("Podium server"))[1]).toEqual(["Build", "430d135c"]);
    expect(cells(table("Database")).map((r) => r[0])).toEqual(["Adapter", "Engine version", "Schema version"]);
  });

  it("lists each reporter version with the range this server reads and its machines, flagging one outside it in words as well as color", async () => {
    await openAbout();
    expect(cells(table("Reporters"))).toEqual([
      ["Claude Code reporter", "1.5.0", "0.2 to 1.5", "5"],
      ["Claude Code reporter", "⚠ 1.3.2 outdated", "0.2 to 1.5", "2"],
      ["OpenCode reporter", "1.5.0", "1.4 to 1.5", "1"],
    ]);
  });

  it("says no reporter is connected, and keeps the server on the page", async () => {
    const srv = fakeServer({ unlocked: true });
    srv.about.reporters = [];
    render(<AdminView />);
    fireEvent.click(await screen.findByRole("button", { name: "About" }));
    expect(await screen.findByText("No reporter is connected")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Reporters" })).queryByRole("table")).toBeNull();
    expect(table("Podium server")).toBeInTheDocument();
  });

  it("reads the page again every half minute, so a reporter that connects appears", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const srv = await openAbout();
      const reads = () => srv.calls.filter((c) => c === "GET /about").length;
      const first = reads();
      await vi.advanceTimersByTimeAsync(30_000);
      await waitFor(() => expect(reads()).toBe(first + 1));
    } finally {
      vi.useRealTimers();
    }
  });

  it("says what went wrong when the page cannot be read", async () => {
    const srv = fakeServer({ unlocked: true });
    srv.aboutFails = true;
    render(<AdminView />);
    fireEvent.click(await screen.findByRole("button", { name: "About" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this page");
    expect(screen.getByRole("button", { name: "Copy details" })).toBeDisabled();
  });
});

describe("Admin About page, when a refresh fails", () => {
  it("keeps what it last read and says the refresh failed, then clears the message when a refresh works", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const srv = await openAbout();
      srv.aboutFails = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not refresh this page");
      expect(screen.getByRole("alert")).toHaveTextContent("It shows what was last read.");
      expect(table("Podium server")).toBeInTheDocument();
      srv.aboutFails = false;
      await vi.advanceTimersByTimeAsync(30_000);
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Copy details", () => {
  it("copies the whole page as plain text and reads Copied", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: write } });
    await openAbout();
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    await screen.findByText("Copied");
    const text = write.mock.calls[0]![0] as string;
    expect(text).toContain("Podium 1.1.0");
    expect(text).toContain("Running as: stand-alone");
    expect(text).toContain("Node.js v24.11.0 · Express 5.3.0 · React ");
    expect(text).toContain("Database: SQLite 3.50.4 · schema 52 · 412.0 MB");
    expect(text).toContain("Reporters (8 machines):");
    expect(text).toContain("  Claude Code reporter 1.3.2 x2 (outdated; this server reads 0.2 to 1.5)");
    expect(text).not.toMatch(/⚠/);
  });

  it("reads Copy failed when the clipboard refuses", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error("no")) } });
    await openAbout();
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    expect(await screen.findByText("Copy failed")).toBeInTheDocument();
  });
});

describe("About text helpers", () => {
  const about = (over: Partial<AboutView> = {}): AboutView => ({
    server: { version: "1.6.0", build: "abc1234", runtime: "container", startedAt: 0, system: "linux arm64" },
    stack: { node: "24.11.0", express: "5.3.0" },
    database: { engine: "PostgreSQL", version: "17.2", schemaVersion: 9, sizeBytes: null },
    reporters: [],
    serverTime: 90 * 60_000,
    ...over,
  });

  it("writes the build, the container, no size and no reporters", () => {
    const text = aboutText(about());
    expect(text.split("\n")[0]).toBe("Podium 1.6.0 (build abc1234)");
    expect(text).toContain("Running as: container · started ");
    expect(text).toContain(" · up 1 h 30 min · linux arm64");
    expect(text).toContain("Database: PostgreSQL 17.2 · schema 9\n");
    expect(text.endsWith("Reporters: none connected")).toBe(true);
  });

  it("names a reporter it does not know as sent, and a reporter with no range as not checked", () => {
    expect(reporterLabel("podium-reporter-claudecode")).toBe("Claude Code reporter");
    expect(reporterLabel("podium-reporter-newthing")).toBe("podium-reporter-newthing");
    expect(rangeText(null)).toBe("not checked");
    expect(rangeText({ min: "0.2.0", max: "1.5.3" })).toBe("0.2 to 1.5");
  });

  it("counts uptime in the two largest units", () => {
    expect(upText(0)).toBe("0 min");
    expect(upText(-5)).toBe("0 min");
    expect(upText(2 * 60_000)).toBe("2 min");
    expect(upText(5 * 3_600_000 + 12 * 60_000)).toBe("5 h 12 min");
    expect(upText(86_400_000 + 3_600_000)).toBe("1 day 1 h");
    expect(upText(3 * 86_400_000)).toBe("3 days 0 h");
  });
});
