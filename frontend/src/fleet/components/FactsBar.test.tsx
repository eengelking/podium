import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, act, within } from "@testing-library/react";
import { FactsBar } from "./FactsBar";
import { makeAgent, makeSession } from "../fixtures";
import { HOOKS_NOTE, versionNote } from "./SessionCard";

afterEach(cleanup);

function agentsTile(agents: ReturnType<typeof makeAgent>[]) {
  const { container } = render(<FactsBar s={makeSession({ agents })} now={Date.now()} onAgent={() => {}} />);
  return [...container.querySelectorAll(".fact")].find((f) => f.querySelector(".k")?.textContent === "Agents")!;
}

describe("FactsBar Agents tile (#100, #109)", () => {
  const states: [string, ReturnType<typeof makeAgent>[], string][] = [
    ["no agents", [], "1 running / 0 done"],
    ["running only", [makeAgent({ id: "a", status: "running" }), makeAgent({ id: "b", status: "running" }), makeAgent({ id: "c", status: "running" })], "4 running / 0 done"],
    ["done only", Array.from({ length: 12 }, (_, i) => makeAgent({ id: `d${i}`, status: "done" })), "1 running / 12 done"],
  ];

  it.each(states)("shows %s as one line, counts joined by a slash", (_n, agents, text) => {
    const tile = agentsTile(agents);
    expect(tile.querySelector(".v")!.textContent).toBe(text);
    expect(tile.querySelector(".n-done")).toHaveClass("n-done");
  });

  it("sizes the tile to its content and never wraps its text, so a narrow bar moves the whole tile instead", () => {
    expect(agentsTile([])).toHaveClass("agents");
  });

  it("keeps the failed button on the same line after the counts", () => {
    const v = agentsTile([makeAgent({ id: "a", status: "running" }), makeAgent({ id: "f", status: "failed" })]).querySelector(".v")!;
    expect(v.textContent).toBe("2 running / 0 done1 failed");
    expect(v.querySelector("button.blow")!.textContent).toBe("1 failed");
  });
});

describe("FactsBar cells (#109)", () => {
  const cell = (container: HTMLElement, k: string) => [...container.querySelectorAll(".fact")].find((f) => f.querySelector(".k")?.textContent === k) as HTMLElement | undefined;

  it("counts the orchestrator done when its session is done", () => {
    const { container } = render(<FactsBar s={makeSession({ status: "done", agents: [makeAgent({ status: "done" })] })} now={Date.now()} onAgent={() => {}} />);
    expect(cell(container, "Agents")!.querySelector(".v")!.textContent).toBe("0 running / 2 done");
  });

  it("says the orchestrator is counted, in the Agents tooltip", () => {
    expect(agentsTile([]).getAttribute("title")).toMatch(/orchestrator/i);
  });

  it("has no Orchestrator model cell, the agent table's first row shows it", () => {
    const { container } = render(<FactsBar s={makeSession()} now={Date.now()} onAgent={() => {}} />);
    expect(cell(container, "Orchestrator model")).toBeUndefined();
  });

  it("sums the orchestrator's time and every agent's in Agent time, apart from the wall-clock Running for", () => {
    const s = makeSession({ status: "running", startedAt: 0, agents: [makeAgent({ startedAt: 0, endedAt: 60_000 }), makeAgent({ id: "b", startedAt: 0, endedAt: 60_000 })] });
    const { container } = render(<FactsBar s={s} now={60_000} onAgent={() => {}} />);
    expect(cell(container, "Running for")!.querySelector(".v")!.textContent).toBe("1:00");
    expect(cell(container, "Agent time")!.querySelector(".v")!.textContent).toBe("3:00");
    expect(cell(container, "Agent time")!.getAttribute("title")).toMatch(/can be longer than/i);
  });

  it("keeps the session's cost and says how it is made", () => {
    const s = makeSession({ costUsd: 0.87, agents: [makeAgent({ costUsdEst: 0.21 })] });
    const { container } = render(<FactsBar s={s} now={Date.now()} onAgent={() => {}} />);
    expect(cell(container, "Est. cost")!.querySelector(".v")!.textContent).toBe("$0.87");
    expect(cell(container, "Est. cost")!.getAttribute("title")).toMatch(/every agent/i);
  });

  it("has no Context cell, the orchestrator's row in the agent table shows its context", () => {
    const { container } = render(<FactsBar s={makeSession()} now={Date.now()} onAgent={() => {}} />);
    expect(cell(container, "Context")).toBeUndefined();
    expect(container.querySelector(".facts .bar")).toBeNull();
  });
});

describe("FactsBar Reporter cell (#124)", () => {
  const reporter = (over: Parameters<typeof makeSession>[0]) => {
    const { container } = render(<FactsBar s={makeSession(over)} now={Date.now()} onAgent={() => {}} />);
    const cells = [...container.querySelectorAll(".fact")];
    return { cells, cell: cells.find((f) => f.querySelector(".k")?.textContent === "Reporter") as HTMLElement | undefined };
  };

  it("shows the reporter's version", () => {
    const { cell } = reporter({ reporterVersion: "0.11.0", compat: "ok" });
    expect(cell!.querySelector(".v")!.textContent).toBe("0.11.0");
  });

  it("says Settings hooks for a session with no mod", () => {
    const { cell } = reporter({ reporterVersion: null });
    expect(cell!.querySelector(".v")!.textContent).toBe("Settings hooks");
    expect(cell!.getAttribute("title")).toMatch(/settings hooks/i);
    expect(cell!.getAttribute("title")).toContain(HOOKS_NOTE);
  });

  it.each([["outdated", "0.3.0 · update"], ["newer", "0.99.0 · upgrade server"]] as const)("says so when the reporter is %s, in the card chip's words and tooltip", (compat, text) => {
    const v = compat === "outdated" ? "0.3.0" : "0.99.0";
    const s = makeSession({ reporterVersion: v, compat });
    const { container } = render(<FactsBar s={s} now={Date.now()} onAgent={() => {}} />);
    const cell = [...container.querySelectorAll(".fact")].find((f) => f.querySelector(".k")?.textContent === "Reporter")!;
    expect(cell.querySelector(".v")!.textContent).toBe(text);
    expect(cell.getAttribute("title")).toBe(versionNote(s)!.text);
  });

  it("sits just before Session, Resume and Fork, which end the grid", () => {
    const { cells } = reporter({ reporterVersion: "0.11.0" });
    expect(cells.slice(-4).map((c) => c.querySelector(".k")!.textContent)).toEqual(["Reporter", "Session", "Resume", "Fork"]);
  });
});

describe("FactsBar copy cells (#352)", () => {
  it("has twelve cells in fixed places, six to a row: Blowouts ends row one, and Machine, System, Reporter, Session, Resume and Fork make row two (#427)", () => {
    const { container } = render(<FactsBar s={makeSession()} now={Date.now()} onAgent={() => {}} />);
    const keys = [...container.querySelectorAll(".facts > .fact")].map((f) => f.querySelector(".k")!.textContent);
    expect(container.querySelector(".facts")).toHaveClass("six");
    expect(keys).toEqual(["Agents", "Est. cost", "Tokens", "Running for", "Agent time", "Blowouts", "Machine", "System", "Reporter", "Session", "Resume", "Fork"]);
  });

  it("gives Resume and Fork their own accessible names and popups", () => {
    render(<FactsBar s={makeSession()} now={Date.now()} onAgent={() => {}} />);
    expect(screen.getByRole("button", { name: "Copy resume command" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy fork command" })).toBeInTheDocument();
    const tips = ["Resume", "Fork"].map((g) => within(screen.getByRole("group", { name: g })).getByRole("tooltip", { hidden: true }).textContent);
    expect(tips[0]).toMatch(/Continues this same session/);
    expect(tips[0]).toMatch(/still running in another terminal/);
    expect(tips[1]).toMatch(/This session is not changed/);
    expect(tips[1]).toMatch(/Approve them again/);
    expect(tips[1]).toMatch(/30 days/);
  });

  it("wraps each popup cell in a named group that holds the button and its popup (#487)", () => {
    render(<FactsBar s={makeSession()} now={Date.now()} onAgent={() => {}} />);
    for (const [group, button] of [["Resume", "Copy resume command"], ["Fork", "Copy fork command"]]) {
      const g = screen.getByRole("group", { name: group });
      expect(within(g).getByRole("button", { name: button })).toBeInTheDocument();
      expect(within(g).getByRole("tooltip", { hidden: true })).toBeInTheDocument();
    }
  });

  it("closes the popup on Escape and brings it back when focus leaves and returns (#487)", () => {
    render(<FactsBar s={makeSession()} now={Date.now()} onAgent={() => {}} />);
    const g = screen.getByRole("group", { name: "Resume" });
    fireEvent.keyDown(within(g).getByRole("button"), { key: "Escape" });
    expect(g).toHaveClass("dismissed");
    fireEvent.blur(within(g).getByRole("button"));
    expect(g).not.toHaveClass("dismissed");
  });

  it("copies the session's own resume and fork commands", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const s = makeSession({ resumeCommand: "cd '/a b' && claude --resume r1", forkCommand: "cd '/a b' && claude --resume r1 --fork-session" });
    render(<FactsBar s={s} now={Date.now()} onAgent={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy fork command" }));
    });
    expect(writeText).toHaveBeenLastCalledWith("cd '/a b' && claude --resume r1 --fork-session");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy resume command" }));
    });
    expect(writeText).toHaveBeenLastCalledWith("cd '/a b' && claude --resume r1");
    vi.unstubAllGlobals();
  });
});

describe("FactsBar Machine and System cells (#427)", () => {
  const MAC = { name: "dana-mbp", id: "m1", os: "macOS 15.4" };
  const show = (machine: ReturnType<typeof makeSession>["machine"]) => {
    const { container } = render(<FactsBar s={makeSession({ machine })} now={Date.now()} onAgent={() => {}} />);
    const cell = (k: string) => [...container.querySelectorAll<HTMLElement>(".facts > .fact")].find((f) => f.querySelector(".k")?.textContent === k)!;
    const tip = (k: string) => cell(k).querySelector<HTMLElement>('[role="tooltip"]')!;
    return { container, cell, tip };
  };

  it("shows the machine's name and its system with the family's icon, as My reporters does", () => {
    const { cell } = show(MAC);
    expect(cell("Machine").querySelector(".v")!.textContent).toBe("dana-mbp");
    expect(cell("System").querySelector(".v")!.textContent).toBe("macOS 15.4");
    expect(cell("System").querySelector(".v svg")).not.toBeNull();
  });

  it("gives Linux and Windows their own icons from the same table My reporters uses", () => {
    const icon = (os: string) => show({ ...MAC, os }).cell("System").querySelector(".v svg")!.innerHTML;
    expect(new Set([icon("macOS 15.4"), icon("Fedora Linux 44"), icon("Windows 11")]).size).toBe(3);
  });

  it("says what each cell is in a popup, with the whole system text as the cell's popup, in the Resume and Fork popup's design", () => {
    const { cell, tip } = show({ ...MAC, os: "Fedora Linux 44 (Workstation Edition) · kernel 6.17.4" });
    expect(tip("System").textContent).toMatch(/Fedora Linux 44 \(Workstation Edition\) · kernel 6\.17\.4/);
    expect(tip("Machine").textContent).toMatch(/machine this session runs on/i);
    for (const k of ["Machine", "System"]) {
      expect(cell(k)).toHaveClass("pop", "start");
      expect(cell(k)).toHaveAttribute("tabindex", "0");
      expect(cell(k).getAttribute("aria-describedby")).toBe(tip(k).id);
    }
  });

  it("reads Not reported with the update tooltip when the reporter sent a machine but no system", () => {
    const { cell, tip } = show({ name: "studio-m2", id: "m2", os: null });
    expect(cell("System").querySelector(".v")!.textContent).toBe("Not reported");
    expect(cell("System").querySelector(".v")).toHaveClass("soft");
    expect(tip("System").textContent).toMatch(/older podium-reporter/);
    expect(tip("System").textContent).toMatch(/Updating podium-reporter fills it in/);
    expect(cell("System").textContent).not.toMatch(/undefined|null/);
  });

  it("reads Not reported in both cells, with a tooltip that does not point at an update, when no machine was sent", () => {
    const { cell, tip } = show(null);
    for (const k of ["Machine", "System"]) {
      expect(cell(k).querySelector(".v")!.textContent).toBe("Not reported");
      expect(tip(k).textContent).toMatch(/user name/i);
      expect(tip(k).textContent).toMatch(/userName/);
      expect(tip(k).textContent).not.toMatch(/Updating/);
    }
  });

  it("closes the popup on Escape and brings it back when focus leaves and returns", () => {
    const { cell } = show(MAC);
    const c = cell("System");
    fireEvent.keyDown(c, { key: "Escape" });
    expect(c).toHaveClass("dismissed");
    fireEvent.blur(c);
    expect(c).not.toHaveClass("dismissed");
  });

  it("opens its popup below the cell when the page has no room above it", () => {
    const { cell } = show(MAC);
    const c = cell("Machine");
    vi.spyOn(c, "getBoundingClientRect").mockReturnValue({ top: 4 } as DOMRect);
    fireEvent.mouseEnter(c);
    expect(c).toHaveClass("below");
  });
});
