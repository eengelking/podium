// The open orchestrator lives in the address (`#/?open=<id>`), as History's opened session does (#195), so a reload, a
// shared link and the browser's Back button all land on the same page.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { FleetView } from "./FleetApp";
import { fleetReducer } from "./store";
import { makeAgent, makeEvent, makeSession } from "./fixtures";
import { stateFrom } from "./testState";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const two = () => stateFrom({ sessions: [makeSession(), makeSession({ id: "s2", name: "docs-pass" })] });
const pageName = () => document.querySelector("header.top > .pill")?.textContent;
const railItem = (name: string) => screen.getByRole("button", { name: new RegExp(name) });
const navigate = (hash: string) =>
  act(() => {
    window.history.pushState(null, "", hash);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

describe("the open orchestrator in the address", () => {
  it("opening a card on the wall adds #/?open=<id> to the browser history", () => {
    window.history.replaceState(null, "", "#/");
    const before = window.history.length;
    const { container } = render(<FleetView state={two()} />);
    fireEvent.click(container.querySelector('.wall .card[data-session="s2"]')!);
    expect(window.location.hash).toBe("#/?open=s2");
    expect(window.history.length).toBe(before + 1);
    expect(pageName()).toBe("Orchestrator");
  });

  it("opens the orchestrator the address names", () => {
    window.history.replaceState(null, "", "#/?open=s2");
    render(<FleetView state={two()} />);
    expect(pageName()).toBe("Orchestrator");
    expect(screen.getByRole("navigation", { name: "Orchestrators" }).querySelector('.ritem[aria-current="true"]')).toHaveTextContent("docs-pass");
  });

  it("Back returns to the wall, and Forward opens the orchestrator again", async () => {
    window.history.replaceState(null, "", "#/");
    const { container } = render(<FleetView state={two()} />);
    fireEvent.click(container.querySelector('.wall .card[data-session="s1"]')!);
    act(() => window.history.back());
    await waitFor(() => expect(pageName()).toBe("Fleet"));
    expect(window.location.hash).toBe("#/");
    act(() => window.history.forward());
    await waitFor(() => expect(pageName()).toBe("Orchestrator"));
  });

  it("follows the address when it changes without the console, as the logo link does", () => {
    window.history.replaceState(null, "", "#/?open=s1");
    render(<FleetView state={two()} />);
    navigate("#/");
    expect(pageName()).toBe("Fleet");
    navigate("#/?open=s2");
    expect(screen.getByRole("navigation", { name: "Orchestrators" }).querySelector('.ritem[aria-current="true"]')).toHaveTextContent("docs-pass");
  });

  it("moving to another orchestrator in the rail replaces the entry, so Back still goes to the wall", async () => {
    window.history.replaceState(null, "", "#/");
    const { container } = render(<FleetView state={two()} />);
    fireEvent.click(container.querySelector('.wall .card[data-session="s1"]')!);
    const opened = window.history.length;
    fireEvent.click(railItem("docs-pass"));
    expect(window.location.hash).toBe("#/?open=s2");
    expect(window.history.length).toBe(opened);
    act(() => window.history.back());
    await waitFor(() => expect(pageName()).toBe("Fleet"));
    expect(window.location.hash).toBe("#/");
  });

  it("All orchestrators goes back to the wall's entry when the console opened the page", async () => {
    window.history.replaceState(null, "", "#/");
    const { container } = render(<FleetView state={two()} />);
    fireEvent.click(container.querySelector('.wall .card[data-session="s1"]')!);
    const opened = window.history.length;
    fireEvent.click(railItem("All orchestrators"));
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    expect(pageName()).toBe("Fleet");
    expect(window.history.length).toBe(opened);
    // It went back rather than adding the wall again, so Forward opens the orchestrator.
    act(() => window.history.forward());
    await waitFor(() => expect(pageName()).toBe("Orchestrator"));
  });

  it("All orchestrators on a page opened from a link replaces the address with the wall's", () => {
    window.history.replaceState(null, "", "#/?open=s1");
    const before = window.history.length;
    render(<FleetView state={two()} />);
    fireEvent.click(railItem("All orchestrators"));
    expect(window.location.hash).toBe("#/");
    expect(window.history.length).toBe(before);
    expect(pageName()).toBe("Fleet");
  });

  it("drops open= from the address when the open session leaves the fleet", () => {
    window.history.replaceState(null, "", "#/?open=s1");
    const start = two();
    const { rerender } = render(<FleetView state={start} />);
    rerender(<FleetView state={fleetReducer(start, { type: "removed", sessionId: "s1", reason: "done", at: Date.now() })} />);
    expect(window.location.hash).toBe("#/");
    expect(screen.getByText("api-refactor ended and left the fleet.")).toBeInTheDocument();
  });

  it("an address naming a session that is not in the fleet lands on the wall with a message", () => {
    window.history.replaceState(null, "", "#/?open=nope");
    render(<FleetView state={two()} />);
    expect(window.location.hash).toBe("#/");
    expect(pageName()).toBe("Fleet");
    expect(screen.getByText("That session is not in the fleet. Sessions that ended are listed in History.")).toBeInTheDocument();
  });

  it("an event opened from the activity panel is in the address too, and keeps its agent open", () => {
    window.history.replaceState(null, "", "#/");
    const s2 = makeSession({ id: "s2", name: "docs-pass", agents: [makeAgent({ id: "a9", description: "Backfill dry run" })] });
    const st = stateFrom({ sessions: [makeSession(), s2], events: [makeEvent({ id: "o", sessionId: "s2", sessionName: "docs-pass", agentId: "a9", text: "started: Backfill dry run" })] });
    render(<FleetView state={st} />);
    fireEvent.click(screen.getByRole("button", { name: /started: Backfill dry run/ }));
    expect(window.location.hash).toBe("#/?open=s2");
    expect(screen.getByRole("button", { name: "Back to activity" })).toBeInTheDocument();
  });
});
