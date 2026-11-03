import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { SessionCard } from "./SessionCard";
import { FocusHeader } from "./FocusHeader";
import { ModelChip, NO_PRICE_TITLE } from "./Chips";
import { AgentRow } from "./AgentRow";
import { AgentDetail } from "./AgentDetail";
import { AgentTree } from "./AgentTree";
import { OrchestratorDetail } from "./OrchestratorDetail";
import { makeAgent, makeSession } from "../fixtures";

afterEach(cleanup);

const CFG = { staleAfterMs: 15_000, dropAfterMs: 60_000, lingerMs: 8_000, detachedHideAfterMs: 60_000 };
const card = (s = makeSession(), showHarness?: boolean) =>
  render(<SessionCard s={s} now={2_000_000} config={CFG} entering={false} leaving={false} onOpen={() => {}} showHarness={showHarness} />);
const cells = (container: HTMLElement) => [...container.querySelectorAll(".z3 .c .k")].map((k) => k.textContent);

describe("the harness badge on a card (#853)", () => {
  it("is drawn with the harness name and a shape when the wall is mixed", () => {
    const { container } = card(makeSession({ harness: "opencode" }), true);
    const badge = container.querySelector(".mdl .chip.hx")!;
    expect(badge.textContent).toBe("OpenCode");
    expect(badge).toHaveAttribute("title", "Harness: OpenCode");
    expect(badge.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(badge.querySelector("svg")).toHaveAttribute("data-shape", "diamond");
    expect(container.querySelector(".mdl .chip.hx")!.nextElementSibling).toHaveClass("chip");
  });

  it("is not drawn on a wall of one harness, so Claude Code looks as before", () => {
    const { container } = card(makeSession({ harness: "claude-code" }), false);
    expect(container.querySelector(".chip.hx")).toBeNull();
    expect(card(makeSession(), undefined).container.querySelector(".chip.hx")).toBeNull();
  });

  it("names a harness it has no entry for by its id, with the plain square", () => {
    const { container } = card(makeSession({ harness: "acme-runner" }), true);
    expect(container.querySelector(".chip.hx")!.textContent).toBe("acme-runner");
    expect(container.querySelector(".chip.hx svg")).toHaveAttribute("data-shape", "square");
  });
});

describe("fields a harness does not report are absent, not zero (#853)", () => {
  it("keeps the Context cell and the effort meter for Claude Code", () => {
    const { container } = card(makeSession({ harness: "claude-code" }));
    expect(cells(container)).toEqual(["Cost", "Tokens", "Time", "Context"]);
    expect(container.querySelector(".eff")).not.toBeNull();
    expect(container.querySelector(".z3.three")).toBeNull();
  });

  it("drops the Context cell, makes the footer three cells wide and drops the effort meter for OpenCode", () => {
    const { container } = card(makeSession({ harness: "opencode" }));
    expect(cells(container)).toEqual(["Cost", "Tokens", "Time"]);
    expect(container.querySelector(".z3.three")).not.toBeNull();
    expect(container.querySelector(".eff")).toBeNull();
    expect(screen.queryByText(/context/i)).toBeNull();
  });

  it("says once on the orchestrator page that the harness does not report context size", () => {
    render(<FocusHeader s={makeSession({ harness: "opencode" })} kind="running" now={2_000_000} />);
    expect(screen.getByText("OpenCode does not report context size.")).toBeInTheDocument();
    cleanup();
    render(<FocusHeader s={makeSession({ harness: "claude-code" })} kind="running" now={2_000_000} />);
    expect(screen.queryByText(/does not report context/)).toBeNull();
  });

  it("draws the badge in the page header when the wall is mixed", () => {
    const { container } = render(<FocusHeader s={makeSession({ harness: "opencode" })} kind="running" now={2_000_000} showHarness />);
    expect(container.querySelector(".fh .chip.hx")!.textContent).toBe("OpenCode");
  });
});

describe("a cost the harness reported (#853)", () => {
  it("says where it came from under the figure, and says nothing for Podium's estimate", () => {
    const { container } = card(makeSession({ harness: "opencode", costSource: "harness", costUsd: 0.31 }));
    expect(container.querySelector(".z3 .c .src")!.textContent).toBe("from OpenCode");
    cleanup();
    expect(card(makeSession({ costSource: "estimate" })).container.querySelector(".z3 .c .src")).toBeNull();
  });
});

describe("a model that is not a Claude model, without Claude wording (#853)", () => {
  it("titles the chip with the model name alone", () => {
    render(<ModelChip family="other" model="gpt-5.1" />);
    expect(screen.getByText("gpt-5.1").closest(".chip")).toHaveAttribute("title", "gpt-5.1");
  });

  it("explains a missing price without naming Claude", () => {
    expect(NO_PRICE_TITLE).toBe("Podium has no price for this model and the harness reported none");
  });
});

describe("what a session's harness declares (#940)", () => {
  it("hides the Context cell for a harness that declares context false, whatever its id, and says so on the page", () => {
    const s = makeSession({ harness: "future-harness", capabilities: { context: false, commands: [] } });
    expect(cells(card(s).container)).not.toContain("Context");
    cleanup();
    render(<FocusHeader s={s} kind="running" now={2_000_000} />);
    expect(screen.getByText(/does not report context/)).toBeInTheDocument();
  });

  it("shows the Context cell for a harness the table says cannot report it when it declares context true", () => {
    const s = makeSession({ harness: "opencode", capabilities: { context: true, commands: [] } });
    expect(cells(card(s).container)).toContain("Context");
  });

  it("follows the table for a field the session does not declare, and for a session that declared nothing", () => {
    expect(cells(card(makeSession({ harness: "opencode", capabilities: { commands: [] } })).container)).not.toContain("Context");
    cleanup();
    expect(cells(card(makeSession({ harness: "opencode", capabilities: null })).container)).not.toContain("Context");
    cleanup();
    expect(cells(card(makeSession()).container)).toContain("Context");
  });

  it("hides the effort meter for a harness that declares effort false", () => {
    const { container } = card(makeSession({ capabilities: { effort: false, commands: [] } }));
    expect(container.querySelector(".eff")).toBeNull();
  });

  it("reads the label on the model chip, with the model id as its title, and the family name when there is none", () => {
    render(<ModelChip family="other" model="gpt-5.1-2026" label="GPT-5.1" />);
    expect(screen.getByText("GPT-5.1").closest(".chip")).toHaveAttribute("title", "gpt-5.1-2026");
    cleanup();
    render(<ModelChip family="other" model="gpt-5.1-2026" label={null} />);
    expect(screen.getByText("gpt-5.1-2026")).toBeInTheDocument();
  });
});

describe("an agent's model label (#945)", () => {
  const gpt = makeAgent({ id: "g1", model: "gpt-5.1-2026", modelFamily: "other", modelLabel: "GPT-5.1", modelProvider: "openai" });
  const row = (a = gpt) =>
    render(<AgentRow a={a} guides={[]} selected={false} flash={false} onSelect={() => {}} now={2_000_000} />);
  const panel = (a = gpt) =>
    render(<AgentDetail s={makeSession({ agents: [a] })} a={a} now={2_000_000} onBack={() => {}} onAgent={() => {}} />);

  it("reads the label on the tree row, with the model id as the title", () => {
    const { container } = row();
    const chip = container.querySelector(".chip")!;
    expect(chip.textContent).toBe("GPT-5.1");
    expect(chip).toHaveAttribute("title", "gpt-5.1-2026");
  });

  it("reads the label in the panel, with the model id as the title", () => {
    panel();
    expect(screen.getByText("GPT-5.1").closest(".chip")).toHaveAttribute("title", "gpt-5.1-2026");
  });

  it("keeps the family name for an agent with no label, so a Claude Code agent is unchanged", () => {
    const claude = makeAgent({ id: "c1", model: "claude-sonnet-5-5", modelFamily: "sonnet", modelLabel: null });
    expect(row(claude).container.querySelector(".chip")!.textContent).toBe("Sonnet 5.5");
    cleanup();
    panel(claude);
    expect(screen.getAllByText("Sonnet 5.5").length).toBeGreaterThan(0);
  });
});

describe("the agent tree and the orchestrator panel follow what a harness declares (#944)", () => {
  const agents = [makeAgent({ id: "a1", effort: "high" }), makeAgent({ id: "a2", parentId: "a1", effort: "low" })];
  const tree = (over: Parameters<typeof makeSession>[0] = {}) =>
    render(<AgentTree s={makeSession({ agents, ...over })} waiting={new Map()} now={2_000_000} sort={{ key: null, dir: 1 }} onSort={() => {}} selectedAgent={null} flashAgent={null} onSelect={() => {}} />);
  const headers = (c: HTMLElement) => [...c.querySelectorAll(".trow.hd button")].map((b) => b.textContent);
  const panel = (over: Parameters<typeof makeSession>[0] = {}) => render(<OrchestratorDetail s={makeSession(over)} now={2_000_000} onBack={() => {}} />);
  const labels = (c: HTMLElement) => [...c.querySelectorAll(".grid2 dt")].map((d) => d.textContent);

  it("draws every column for a session that declared nothing, as before", () => {
    const { container } = tree();
    expect(headers(container)).toEqual(["Model", "Effort", "Context", "Tokens", "Cost", "Time", "Status"]);
    expect(container.querySelectorAll(".trow:not(.hd) .eff")).toHaveLength(3);
    expect(container.querySelectorAll(".trow:not(.hd) .ctxc")).toHaveLength(3);
    expect(container.querySelector(".trow.no-ctx, .trow.no-eff")).toBeNull();
  });

  it("leaves out the Context column, in the header, the orchestrator row and every agent row, when context is declared false", () => {
    const { container } = tree({ capabilities: { context: false, commands: [] } });
    expect(headers(container)).toEqual(["Model", "Effort", "Tokens", "Cost", "Time", "Status"]);
    expect(container.querySelector(".ctxc")).toBeNull();
    expect(container.querySelector(".bar.ctx")).toBeNull();
    expect(container.querySelectorAll(".trow:not(.hd) .eff")).toHaveLength(3);
    for (const r of container.querySelectorAll(".trow")) expect(r).toHaveClass("no-ctx");
  });

  it("leaves out the effort meter column when effort is declared false, and both when both are", () => {
    const { container } = tree({ capabilities: { effort: false, commands: [] } });
    expect(headers(container)).toEqual(["Model", "Context", "Tokens", "Cost", "Time", "Status"]);
    expect(container.querySelector(".eff")).toBeNull();
    cleanup();
    const both = tree({ capabilities: { context: false, effort: false, commands: [] } });
    expect(headers(both.container)).toEqual(["Model", "Tokens", "Cost", "Time", "Status"]);
    for (const r of both.container.querySelectorAll(".trow")) expect(r).toHaveClass("no-ctx", "no-eff");
  });

  it("follows the table for a harness that declares nothing, by session, never by naming one", () => {
    const { container } = tree({ harness: "opencode" });
    expect(headers(container)).toEqual(["Model", "Tokens", "Cost", "Time", "Status"]);
    cleanup();
    expect(headers(tree({ harness: "opencode", capabilities: { context: true, effort: true, commands: [] } }).container)).toContain("Context");
  });

  it("does not order the rows by a column this session does not show, and offers no Launch order for it", () => {
    const two = [
      makeAgent({ id: "hi", context: { tokens: 1, window: 1, percent: 80 } }),
      makeAgent({ id: "lo", context: { tokens: 1, window: 1, percent: 20 } }),
    ];
    const order = (c: HTMLElement) => [...c.querySelectorAll("button.trow:not(.root)")].map((r) => r.getAttribute("data-agent"));
    const withSort = (over: Parameters<typeof makeSession>[0]) =>
      render(<AgentTree s={makeSession({ agents: two, ...over })} waiting={new Map()} now={2_000_000} sort={{ key: "ctx", dir: 1 }} onSort={() => {}} selectedAgent={null} flashAgent={null} onSelect={() => {}} />);
    const shown = withSort({});
    expect(order(shown.container)).toEqual(["lo", "hi"]);
    expect(screen.getByRole("button", { name: "Launch order" })).toBeInTheDocument();
    cleanup();
    const hidden = withSort({ capabilities: { context: false, commands: [] } });
    expect(order(hidden.container)).toEqual(["hi", "lo"]);
    expect(screen.queryByRole("button", { name: "Launch order" })).toBeNull();
  });

  it("leaves the Effort and Context rows out of the orchestrator panel, label and value", () => {
    expect(labels(panel().container)).toEqual(expect.arrayContaining(["Effort", "Context"]));
    cleanup();
    const { container } = panel({ capabilities: { context: false, effort: false, commands: [] } });
    expect(labels(container)).not.toContain("Effort");
    expect(labels(container)).not.toContain("Context");
    expect(labels(container)).toEqual(expect.arrayContaining(["Role", "Model", "Tokens", "Est. cost", "Time"]));
    expect(container.querySelector(".grid2 .eff, .grid2 .bar.ctx")).toBeNull();
    expect(container.querySelectorAll(".grid2 dt")).toHaveLength(container.querySelectorAll(".grid2 dd").length);
  });
});
