import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, within, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { FleetView } from "./FleetApp";
import { makeSession } from "./fixtures";
import { stateFrom } from "./testState";
import type { PlanStep, RespondMe, SessionView } from "./types";
import type { RespondApi } from "./respondApi";

beforeEach(() => {
  localStorage.clear();
  window.location.hash = "#/board";
});
afterEach(cleanup);

const step = (id: string, state: PlanStep["state"], text = `step ${id}`, over: Partial<PlanStep> = {}): PlanStep => ({ id, text, state, activeText: null, ownerAgentId: null, ownerLabel: null, ...over });
const planned = (over: Partial<SessionView>, ...steps: PlanStep[]) => makeSession({ ...over, plan: { title: "t", source: "TaskCreate", steps } });
const board = (sessions: SessionView[], me: RespondMe | null = null) =>
  render(
    <FleetView
      board
      state={stateFrom({ sessions, features: { "activity-feed": true, respond: me !== null } })}
      respondApi={me ? ({ me: async () => me } as unknown as RespondApi) : undefined}
    />,
  );
const column = (name: string) => screen.getByRole("region", { name: new RegExp(`^${name},`) });

describe("kanban board", () => {
  it("shows one column per state, with each step in its own and a count on each", () => {
    board([makeSession()]);
    expect(within(column("Pending")).getByText("Write rollout notes")).toBeInTheDocument();
    // An in-progress card shows the live wording instead of the step text, not both.
    expect(within(column("In progress")).getByText("Porting")).toBeInTheDocument();
    expect(within(column("In progress")).queryByText("Port invoice endpoints")).toBeNull();
    expect(within(column("Blocked")).getByText("Run staging backfill")).toBeInTheDocument();
    expect(within(column("Done")).getByText("Map invoice call sites")).toBeInTheDocument();
    expect(column("Review")).toHaveTextContent("Nothing waiting on a person right now.");
    expect(column("In progress")).toHaveAccessibleName("In progress, 1 step");
  });

  it("titles a card with its orchestrator, then the work, then the agent doing it, and shows no model", () => {
    board([makeSession({ plan: { title: "t", source: "TaskCreate", steps: [step("1", "active", "Port endpoints", { activeText: "Porting endpoints", ownerLabel: "Explore · Haiku low" })] } })]);
    const card = within(column("In progress")).getByRole("link", { name: "Port endpoints, active, api-refactor" });
    expect([...card.children].map((c) => c.className)).toEqual(["kb-title", "kb-text", "kb-own"]);
    expect(card.querySelector(".kb-title")).toHaveTextContent("api-refactor");
    expect(card.querySelector(".kb-text")).toHaveTextContent(/^Porting endpoints$/);
    expect(card.querySelector(".kb-own")).toHaveTextContent("Explore · Haiku low");
    expect(card).not.toHaveTextContent("Opus");
  });

  it("puts the in-progress step of a session that waits on its person in Review", () => {
    board([planned({ status: "waiting", waitReason: "input" }, step("1", "active", "Pick the OS"))]);
    expect(within(column("Review")).getByText("Pick the OS")).toBeInTheDocument();
    expect(within(column("Review")).getByText("Waiting for your input")).toBeInTheDocument();
    expect(within(column("In progress")).queryByText("Pick the OS")).toBeNull();
  });

  it("shows a session that asks its person a question in Review even though it has no plan", () => {
    board([makeSession({ id: "q", name: "asker", status: "waiting", waitReason: "permission", waitNote: 'AskUserQuestion([{"question":"Which fruit would you like?","header":"Fruit"', plan: null })]);
    const card = within(column("Review")).getByRole("link", { name: "Waiting for your input, waiting, asker" });
    expect(card).toHaveTextContent("Which fruit would you like?");
    expect(screen.queryByRole("region", { name: "Sessions with no open steps" })).toBeNull();
  });

  it("opens the orchestrator's page when a card is clicked", () => {
    const { rerender } = board([makeSession()]);
    fireEvent.click(screen.getByRole("link", { name: "Port invoice endpoints, active, api-refactor" }));
    expect(window.location.hash).toBe("#/");
    // The route change is the app's; the selection the click made has to survive it.
    rerender(<FleetView state={stateFrom({ sessions: [makeSession()] })} />);
    expect(screen.getByRole("navigation", { name: "Orchestrators" }).querySelector('.ritem[aria-current="true"]')).toHaveTextContent("api-refactor");
  });

  it("starts with the left and right panels collapsed, and the fleet page does not", () => {
    const { unmount } = board([makeSession()]);
    expect(screen.getByRole("navigation", { name: "Orchestrators" })).toHaveClass("collapsed");
    expect(document.querySelector(".side")).toHaveClass("collapsed");
    unmount();
    render(<FleetView state={stateFrom({ sessions: [makeSession()] })} />);
    expect(screen.getByRole("navigation", { name: "Orchestrators" })).not.toHaveClass("collapsed");
  });

  it("remembers the board's panels apart from the fleet page's", () => {
    board([makeSession()]);
    fireEvent.click(screen.getByRole("button", { name: "Expand left pane" }));
    expect(JSON.parse(localStorage.getItem("podium.collapsed.board")!).left).toBe(false);
    expect(localStorage.getItem("podium.collapsed")).toBeNull();
  });

  it("pages a column at 25 cards with the standard pager", () => {
    const many = Array.from({ length: 30 }, (_, i) => step(String(i + 1), "pending", `task ${i + 1}`));
    board([planned({}, ...many)]);
    const col = column("Pending");
    expect(within(col).getByText("Showing 1–25 of 30")).toBeInTheDocument();
    expect(within(col).getAllByRole("link")).toHaveLength(25);
    fireEvent.click(within(col).getByRole("button", { name: "2" }));
    expect(within(col).getByText("Showing 26–30 of 30")).toBeInTheDocument();
    expect(within(col).getAllByRole("link")).toHaveLength(5);
  });

  it("lists sessions with no plan, or with everything done and finished, in a strip pinned to the bottom of the board", () => {
    board([
      planned({ id: "a", name: "alpha" }, step("1", "pending")),
      makeSession({ id: "n", name: "no-tasks", plan: null }),
      planned({ id: "f", name: "finished-one", status: "stale" }, step("1", "done")),
    ]);
    const strip = screen.getByRole("region", { name: "Sessions with no open steps" });
    expect(within(strip).getByRole("link", { name: /no-tasks/ })).toBeInTheDocument();
    expect(within(strip).getByRole("link", { name: /finished-one/ })).toBeInTheDocument();
    expect(within(strip).queryByRole("link", { name: /alpha/ })).toBeNull();
    expect(within(column("Done")).queryByText("step 1")).toBeNull();
    // The how-to is behind an (i), not on the page as text, until it is clicked.
    expect(screen.getByRole("note", { hidden: true })).not.toBeVisible();
    fireEvent.click(within(strip).getByRole("button", { name: "How to get steps here" }));
    expect(screen.getByRole("note")).toBeVisible();
    expect(screen.getByRole("note")).toHaveTextContent("CLAUDE_CODE_ENABLE_TODO_TOOLS=1");
    expect(within(strip).getByRole("link", { name: "A session shows no plan" })).toHaveAttribute("href", expect.stringContaining("docs/GOTCHAS.md"));
  });

  it("pins the strip as the last thing on the page, and Escape closes its note (#359)", () => {
    board([planned({ id: "a", name: "alpha" }, step("1", "pending")), makeSession({ id: "n", name: "no-tasks", plan: null })]);
    const strip = screen.getByRole("region", { name: "Sessions with no open steps" });
    // Last in the board, after the columns, so the CSS can pin it above the legend and the last card scrolls clear of it.
    expect(strip.parentElement?.lastElementChild).toBe(strip);
    expect(strip.querySelector(".kb-none-list")).toContainElement(within(strip).getByRole("link", { name: /no-tasks/ }));
    const info = within(strip).getByRole("button", { name: "How to get steps here" });
    fireEvent.click(info);
    expect(screen.getByRole("note")).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(info).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("note", { hidden: true })).not.toBeVisible();
  });

  it("pins nothing when no session is without steps (#359)", () => {
    board([planned({ id: "a", name: "alpha" }, step("1", "pending"))]);
    expect(screen.queryByRole("region", { name: "Sessions with no open steps" })).toBeNull();
  });

  it("says so when no session has a plan", () => {
    board([makeSession({ plan: null })]);
    expect(screen.getByText("No plans on the board")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Sessions with no open steps" })).toBeInTheDocument();
  });

  it("groups cards by orchestrator on request and remembers the choice", () => {
    board([planned({ id: "a", name: "alpha" }, step("1", "pending")), planned({ id: "b", name: "beta" }, step("1", "pending"))]);
    fireEvent.click(screen.getByRole("button", { name: "By orchestrator" }));
    expect(within(column("Pending")).getAllByText(/^(alpha|beta)$/)).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem("podium.board")!).group).toBe(true);
  });

  it("moves a card between columns when its step changes state, without a reload", () => {
    const first = stateFrom({ sessions: [planned({}, step("1", "active", "Port endpoints"))] });
    const { rerender } = render(<FleetView board state={first} />);
    expect(within(column("In progress")).getByText("Port endpoints")).toBeInTheDocument();
    rerender(<FleetView board state={stateFrom({ sessions: [planned({}, step("1", "done", "Port endpoints"))] })} />);
    expect(within(column("Done")).getByText("Port endpoints")).toBeInTheDocument();
    expect(within(column("In progress")).queryByText("Port endpoints")).toBeNull();
    expect(screen.getByRole("status", { name: "Board updates" })).toHaveTextContent("Port endpoints moved to Done");
  });

  describe("the Me filter", () => {
    const sessions = [planned({ id: "m", name: "mine", owner: "Ed E." }, step("1", "pending", "my task")), planned({ id: "o", name: "theirs", owner: "Priya N." }, step("1", "pending", "their task"))];

    it("is not offered while nobody is signed in", async () => {
      board(sessions, { enabled: true, signedIn: false, name: null, admin: false });
      expect(screen.getByText("my task")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Me" })).toBeNull();
    });

    it("narrows the board to the signed-in person's sessions, and is remembered", async () => {
      board(sessions, { enabled: true, signedIn: true, name: "Ed E.", admin: false });
      fireEvent.click(await screen.findByRole("button", { name: "Me" }));
      expect(screen.getByText("my task")).toBeInTheDocument();
      expect(screen.queryByText("their task")).toBeNull();
      await waitFor(() => expect(JSON.parse(localStorage.getItem("podium.board")!).me).toBe(true));
    });
  });
});
