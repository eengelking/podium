import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, within, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { FleetView } from "./FleetApp";
import { Board } from "./components/Board";
import { makeKpis, makeSession } from "./fixtures";
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
    expect(window.location.hash).toBe("#/?open=s1");
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
    fireEvent.click(screen.getByRole("button", { name: "Expand the left pane" }));
    expect(JSON.parse(localStorage.getItem("podium.collapsed.board")!).left).toBe(false);
    expect(localStorage.getItem("podium.collapsed")).toBeNull();
  });

  it("collapses the KPI rows to one bar and opens them again, and remembers the choice apart from the header's (#538)", () => {
    const { unmount } = board([makeSession()]);
    const hide = screen.getByRole("button", { name: "Hide KPI rows" });
    expect(hide).toHaveAttribute("aria-expanded", "true");
    expect(hide).toHaveAttribute("aria-controls", screen.getByRole("group", { name: /Orchestrators and subagents/ }).id);
    fireEvent.click(hide);
    expect(screen.queryByRole("group", { name: /Orchestrators and subagents/ })).toBeNull();
    // The rows stay in the page, hidden, so the control's aria-controls still points at something.
    expect(document.getElementById(hide.getAttribute("aria-controls")!)).toHaveAttribute("hidden");
    const show = screen.getByRole("button", { name: "Show KPI rows" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    expect(show).toHaveClass("edge-tab", "edge-tab-kpi");
    expect(JSON.parse(localStorage.getItem("podium.collapsed.board.kpis")!)).toBe(true);
    // The header's flags and the fleet page's are not touched.
    expect(localStorage.getItem("podium.collapsed.board")).toBeNull();
    expect(localStorage.getItem("podium.collapsed")).toBeNull();
    unmount();
    board([makeSession()]);
    expect(screen.queryByRole("group", { name: /Orchestrators and subagents/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show KPI rows" }));
    expect(screen.getByRole("group", { name: /Orchestrators and subagents/ })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("podium.collapsed.board.kpis")!)).toBe(false);
  });

  it("collapses the header and the KPI rows independently (#538)", () => {
    board([makeSession()]);
    fireEvent.click(screen.getByRole("button", { name: "Hide KPI rows" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide top bar" }));
    expect(screen.getByRole("button", { name: "Show KPI rows" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show top bar" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show top bar" }));
    expect(screen.getByRole("button", { name: "Show KPI rows" })).toBeInTheDocument();
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

  describe("the My orchestrators | Everyone switch (#451)", () => {
    const sessions = [planned({ id: "m", name: "mine", owner: "Ed E." }, step("1", "pending", "my task")), planned({ id: "o", name: "theirs", owner: "Priya N." }, step("1", "pending", "their task"))];

    it("is not offered while nobody is signed in", async () => {
      board(sessions, { enabled: true, signedIn: false, name: null, admin: false });
      expect(screen.getByText("my task")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "My orchestrators" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Everyone" })).toBeNull();
      expect(screen.queryByRole("group", { name: "Whose sessions" })).toBeNull();
    });

    it("shows everyone's sessions by default and names the group for a screen reader", async () => {
      board(sessions, { enabled: true, signedIn: true, name: "Ed E.", admin: false });
      expect(await screen.findByRole("group", { name: "Whose sessions" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Everyone" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "My orchestrators" })).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByText("their task")).toBeInTheDocument();
    });

    it("goes back to everyone when Everyone is pressed", async () => {
      board(sessions, { enabled: true, signedIn: true, name: "Ed E.", admin: false });
      fireEvent.click(await screen.findByRole("button", { name: "My orchestrators" }));
      expect(screen.getByRole("button", { name: "My orchestrators" })).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(screen.getByRole("button", { name: "Everyone" }));
      expect(screen.getByText("their task")).toBeInTheDocument();
      expect(JSON.parse(localStorage.getItem("podium.board")!).me).toBe(false);
    });

    it("narrows the board to the signed-in person's sessions, and is remembered", async () => {
      board(sessions, { enabled: true, signedIn: true, name: "Ed E.", admin: false });
      fireEvent.click(await screen.findByRole("button", { name: "My orchestrators" }));
      expect(screen.getByText("my task")).toBeInTheDocument();
      expect(screen.queryByText("their task")).toBeNull();
      await waitFor(() => expect(JSON.parse(localStorage.getItem("podium.board")!).me).toBe(true));
    });
  });
  it("lists the groups alphabetically whatever their case (#487)", () => {
    board([
      planned({ id: "a", owner: "Ed E.", ownerGroup: "Zeta" }, step("1", "pending")),
      planned({ id: "b", owner: "Priya N.", ownerGroup: "alpha" }, step("1", "pending")),
      planned({ id: "c", owner: "Dana K.", ownerGroup: "Beta" }, step("1", "pending")),
    ]);
    const opts = within(screen.getByRole("combobox", { name: "Group" })).getAllByRole("option");
    expect(opts.map((o) => o.textContent)).toEqual(["All groups", "alpha", "Beta", "Zeta"]);
  });

  describe("the Plans | All switch (#426)", () => {
    const strip = () => screen.queryByRole("region", { name: "Sessions with no open steps" });
    const fleet = () => [planned({ id: "a", name: "alpha" }, step("1", "pending"), step("2", "done")), makeSession({ id: "n", name: "no-tasks", plan: null })];
    const tile = (label: string) => screen.getByText(label).closest(".kpi") as HTMLElement;

    it("shows everything by default: the columns and the strip", () => {
      board(fleet());
      expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "Plans" })).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByRole("group", { name: "Sessions shown" })).toBeInTheDocument();
      expect(strip()).not.toBeNull();
    });

    it("drops the strip on Plans, keeps the columns, and remembers the choice across a reload", () => {
      board(fleet());
      fireEvent.click(screen.getByRole("button", { name: "Plans" }));
      expect(strip()).toBeNull();
      expect(screen.getByRole("button", { name: "Plans" })).toHaveAttribute("aria-pressed", "true");
      expect(within(column("Pending")).getByText("step 1")).toBeInTheDocument();
      expect(JSON.parse(localStorage.getItem("podium.board")!).view).toBe("plans");
      cleanup();
      board(fleet());
      expect(screen.getByRole("button", { name: "Plans" })).toHaveAttribute("aria-pressed", "true");
      expect(strip()).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "All" }));
      expect(strip()).not.toBeNull();
      expect(JSON.parse(localStorage.getItem("podium.board")!).view).toBe("all");
    });

    it("ignores a stored value it does not know", () => {
      localStorage.setItem("podium.board", JSON.stringify({ view: "everything" }));
      board(fleet());
      expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    });

    it("shows a no-plan session that waits on its person in Review on All only", () => {
      board([makeSession({ id: "q", name: "asker", status: "waiting", waitReason: "input", plan: null })]);
      expect(within(column("Review")).getByRole("link", { name: /asker/ })).toBeInTheDocument();
      expect(strip()).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Plans" }));
      expect(screen.queryByRole("link", { name: /asker/ })).toBeNull();
      expect(screen.getByText("None of the 1 active sessions has open steps. Switch to All to list them.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "All" }));
      expect(within(column("Review")).getByRole("link", { name: /asker/ })).toBeInTheDocument();
    });

    it("keeps a waiting session that has a plan in Review on Plans", () => {
      board([planned({ id: "p", name: "planner", status: "waiting", waitReason: "input" }, step("1", "pending"))]);
      fireEvent.click(screen.getByRole("button", { name: "Plans" }));
      expect(within(column("Review")).getByRole("link", { name: /planner/ })).toBeInTheDocument();
    });

    it("explains an empty board in each mode", () => {
      board([makeSession({ plan: null })]);
      expect(screen.getByText("None of the 1 active sessions has a task list yet. They are listed below.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Plans" }));
      expect(screen.getByText("None of the 1 active sessions has open steps. Switch to All to list them.")).toBeInTheDocument();
      expect(strip()).toBeNull();
    });

    it("says no session is active when there is none, in either mode", () => {
      board([]);
      expect(screen.getByText("No sessions are active.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Plans" }));
      expect(screen.getByText("No sessions are active.")).toBeInTheDocument();
    });

    it("states the plans and the cards as two whole-fleet tiles that the switch never changes", () => {
      render(<FleetView board state={stateFrom({ sessions: fleet(), kpis: makeKpis({ live: 2 }) })} />);
      expect(tile("Orchestrators with plans")).toHaveTextContent(/^Orchestrators with plans1of 2 live$/);
      expect(tile("Total cards")).toHaveTextContent(/^Total cards21 done$/);
      fireEvent.click(screen.getByRole("button", { name: "Plans" }));
      expect(tile("Orchestrators with plans")).toHaveTextContent(/^Orchestrators with plans1of 2 live$/);
      expect(tile("Total cards")).toHaveTextContent(/^Total cards21 done$/);
    });

    it("leaves the live caption empty until the server has sent its figures", () => {
      render(<FleetView board state={{ ...stateFrom({ sessions: fleet() }), kpis: null }} />);
      expect(tile("Orchestrators with plans")).toHaveTextContent(/^Orchestrators with plans1$/);
    });

    it("counts every session the page received while My orchestrators narrows the cards, and says whole fleet", async () => {
      const sessions = [planned({ id: "m", name: "mine", owner: "Ed E." }, step("1", "pending")), planned({ id: "o", name: "theirs", owner: "Priya N." }, step("1", "pending"), step("2", "done"))];
      render(
        <FleetView
          board
          state={stateFrom({ sessions, kpis: makeKpis({ live: 2 }), features: { "activity-feed": true, respond: true } })}
          respondApi={{ me: async () => ({ enabled: true, signedIn: true, name: "Ed E.", admin: false }) } as unknown as RespondApi}
        />,
      );
      fireEvent.click(await screen.findByRole("button", { name: "My orchestrators" }));
      expect(tile("Orchestrators with plans")).toHaveTextContent(/^Orchestrators with plans2whole fleet$/);
      expect(tile("Total cards")).toHaveTextContent(/^Total cards3whole fleet$/);
    });
  });
  describe("the running counts (#409)", () => {
    const counts = () => screen.getByRole("group", { name: /^Orchestrators and subagents/ });
    const tile = (label: string) => within(counts()).getByText(label).closest(".kpi") as HTMLElement;
    const withKpis = (kpis: ReturnType<typeof makeKpis>, sessions: SessionView[] = [makeSession()]) => <FleetView board state={stateFrom({ sessions, kpis })} />;

    it("shows the server's running figures, the same ones the Fleet page reads", () => {
      render(withKpis(makeKpis({ live: 8, running: 5, waiting: 1, agentsTotal: 20, agentsRunning: 18, agentsWaiting: 2 })));
      expect(tile("Orchestrators live")).toHaveTextContent(/^Orchestrators live8forks excluded$/);
      expect(tile("Orchestrators running")).toHaveTextContent(/^Orchestrators running5$/);
      expect(tile("Orchestrators waiting")).toHaveTextContent(/^Orchestrators waiting1$/);
      expect(tile("Subagents live")).toHaveTextContent(/^Subagents live20forks included$/);
      expect(tile("Subagents running")).toHaveTextContent(/^Subagents running18$/);
      expect(tile("Subagents waiting")).toHaveTextContent(/^Subagents waiting2queued$/);
    });

    it("shows the eight tiles in order", () => {
      render(withKpis(makeKpis()));
      const labels = [...counts().querySelectorAll(".kpi .k")].map((n) => n.textContent);
      expect(labels).toEqual(["Orchestrators live", "Orchestrators running", "Orchestrators waiting", "Orchestrators with plans", "Subagents live", "Subagents running", "Subagents waiting", "Total cards"]);
    });

    it("changes with the next update and counts nothing it was not told to", () => {
      const { rerender } = render(withKpis(makeKpis({ live: 3, running: 3, agentsRunning: 4 })));
      expect(tile("Subagents running")).toHaveTextContent("4");
      rerender(withKpis(makeKpis({ live: 3, running: 2, agentsRunning: 1 })));
      expect(tile("Orchestrators running")).toHaveTextContent("2");
      expect(tile("Subagents running")).toHaveTextContent("1");
    });

    it("shows a dash for each figure until the server has sent them", () => {
      render(<FleetView board state={{ ...stateFrom(), kpis: null }} />);
      for (const label of ["Orchestrators live", "Orchestrators running", "Orchestrators waiting", "Subagents live", "Subagents running", "Subagents waiting"]) {
        expect(tile(label)).toHaveTextContent(new RegExp(`^${label}–`));
      }
    });

    it("says whole fleet too when the Fleet page's own filters hide sessions from the board", () => {
      render(<Board sessions={[makeSession()]} narrowed kpis={makeKpis({ live: 4, running: 3, agentsRunning: 5 })} me={null} onOpen={() => {}} />);
      expect(counts()).toHaveAccessibleName("Orchestrators and subagents, plans and cards, whole fleet");
      expect(tile("Orchestrators running")).toHaveTextContent("3");
      expect(tile("Subagents running")).toHaveTextContent("whole fleet");
    });

    it("stays the whole fleet when My orchestrators hides sessions, and says so", async () => {
      const sessions = [planned({ id: "m", name: "mine", owner: "Ed E." }, step("1", "pending", "my task")), planned({ id: "o", name: "theirs", owner: "Priya N." }, step("1", "pending", "their task"))];
      render(
        <FleetView
          board
          state={stateFrom({ sessions, kpis: makeKpis({ live: 2, running: 2, agentsRunning: 6 }), features: { "activity-feed": true, respond: true } })}
          respondApi={{ me: async () => ({ enabled: true, signedIn: true, name: "Ed E.", admin: false }) } as unknown as RespondApi}
        />,
      );
      expect(tile("Subagents live")).toHaveTextContent("forks included");
      fireEvent.click(await screen.findByRole("button", { name: "My orchestrators" }));
      expect(screen.queryByText("their task")).toBeNull();
      expect(tile("Orchestrators running")).toHaveTextContent("2");
      expect(tile("Subagents running")).toHaveTextContent("6");
      expect(tile("Subagents running")).toHaveTextContent("whole fleet");
    });
  });
});
