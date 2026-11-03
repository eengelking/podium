import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { SessionCard } from "./SessionCard";
import { FocusHeader } from "./FocusHeader";
import { ModelChip, NO_PRICE_TITLE } from "./Chips";
import { makeSession } from "../fixtures";

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
