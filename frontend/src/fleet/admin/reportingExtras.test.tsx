// Admin > Reporting sections #724 adds to existing pages: projects and branches per person (Usage), skills (Tools), platform and reporter version (People and groups).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AdminView } from "./AdminView";
import { fakeServer } from "./fakeAdmin";
import { skillEntries } from "./ReportingExtras";

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

async function open(name: string, table: string) {
  const s = fakeServer({ unlocked: true });
  render(<AdminView />);
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${name}`) }));
  const t = await screen.findByRole("table", { name: table });
  return { s, table: t };
}

describe("Usage: projects and branches per person", () => {
  it("lists each person's projects and branches, with a dash for no project, and a total row", async () => {
    const { table } = await open("Usage", "Projects and branches per person");
    const rows = within(table).getAllByRole("row");
    expect(rows[1]!.textContent).toContain("Maya Okafor");
    expect(rows[1]!.textContent).toContain("acme/podium");
    expect(rows[3]!.textContent).toContain("Cai Lindqvist");
    expect(rows[3]!.textContent).toContain("–");
    expect(within(table).getByRole("row", { name: /Everyone in the filter/ }).textContent).toContain("27");
    expect(screen.getByRole("button", { name: "Download projects and branches per person CSV" })).toBeEnabled();
  });
});

describe("Tools: skills", () => {
  it("draws a column for each harness beside the total and the people who used the skill", async () => {
    const { table } = await open("Tools", "Skills");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Skill", "Claude Code", "OpenCode", "Total", "People"]);
    const first = within(table).getAllByRole("row")[1]!;
    expect(first.textContent).toBe("code-review38442" + "5");
    expect(screen.getByText(/Podium's reporters see skills, not other slash commands/)).toBeInTheDocument();
  });

  it("adds the sessions of a skill across harnesses, most used first", () => {
    const reply = {
      report: "tools", from: "a", to: "b", tz: "x", oldestDay: null, columns: [], total: null,
      rows: [{ skill: "b", harness: "opencode", sessions: 1 }, { skill: "a", harness: "claude-code", sessions: 2 }, { skill: "b", harness: "claude-code", sessions: 3 }],
      bySkill: [{ skill: "a", sessions: 2, people: 1 }, { skill: "b", sessions: 4, people: 3 }],
    };
    expect(skillEntries(reply).map((e) => [e.skill, e.sessions, e.people])).toEqual([["b", 4, 3], ["a", 2, 1]]);
  });
});

describe("People and groups: platform and reporter version", () => {
  it("lists reporters by harness, platform and version with a status, and narrows by harness", async () => {
    const { s, table } = await open("People and groups", "Reporters by platform and version");
    const rows = within(table).getAllByRole("row");
    expect(rows[1]!.textContent).toContain("Claude Code");
    expect(rows[1]!.textContent).toContain("macOS");
    expect(rows[1]!.textContent).toContain("Current");
    expect(rows[3]!.textContent).toContain("Not reported");
    fireEvent.change(screen.getAllByLabelText("Harness").at(-1)!, { target: { value: "opencode" } });
    await waitFor(() => expect(s.calls.some((c) => c.includes("breakdown=platform") && c.includes("harness=opencode"))).toBe(true));
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Reporters by platform and version" })).getAllByRole("row")).toHaveLength(3));
  });
});
