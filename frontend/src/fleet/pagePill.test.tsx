// #225: the pill after the logo names the page, and the page supplies its text.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { FleetView } from "./FleetApp";
import { TopBar } from "./components/TopBar";
import { HistoryView } from "./HistoryView";
import { AdminView } from "./admin/AdminView";
import { makeSession, makeState } from "./fixtures";
import type { PeersApi, RespondApi } from "./respondApi";
import { stateFrom } from "./testState";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pageName = (container: HTMLElement) => container.querySelector("header.top > .pill")?.textContent;

describe("the page pill in the top bar", () => {
  it("says Fleet on the wall and Orchestrator on an orchestrator's page, and Fleet again after Back", () => {
    const { container } = render(<FleetView state={stateFrom({ sessions: [makeSession()] })} />);
    expect(pageName(container)).toBe("Fleet");
    fireEvent.click(container.querySelector(".wall .card")!);
    expect(pageName(container)).toBe("Orchestrator");
    fireEvent.click(screen.getByRole("button", { name: /All orchestrators/ }));
    expect(pageName(container)).toBe("Fleet");
  });

  it("shows the text the page gives it", () => {
    const { container } = render(<TopBar phase="live" reporters={1} page="Somewhere new" />);
    expect(pageName(container)).toBe("Somewhere new");
  });

  it("says History in History and Admin in Admin", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    vi.stubGlobal("EventSource", class { onerror = null; readyState = 1; addEventListener() {} close() {} });
    const history = render(<HistoryView initialDay="2026-10-10" />);
    await screen.findByRole("link", { name: "Podium, fleet" });
    expect(pageName(history.container)).toBe("History");
    history.unmount();
    const admin = render(<AdminView />);
    await screen.findByRole("link", { name: "Podium, fleet" });
    expect(pageName(admin.container)).toBe("Admin");
  });

  const quiet = { onerror: null, readyState: 1, addEventListener() {}, close() {} };
  const flags = (peer: boolean) => ({ open: () => quiet, fetchState: async () => makeState({ features: { respond: true, "activity-feed": true, "peer-messaging": peer } }) });
  const names = (c: HTMLElement) => [...c.querySelectorAll("header.top a.btn")].map((a) => a.textContent);

  // #470: History left Traffic off the shared bar.
  it("gives History the Traffic button while orchestrator messaging is on, signed in or not, and not while it is off", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const out = { me: vi.fn(async () => ({ enabled: true, signedIn: false, name: null, admin: false })) } as unknown as RespondApi;
    const on = render(<HistoryView initialDay="2026-10-10" fleetOptions={flags(true)} respondApi={out} peersApi={{ read: vi.fn() } as unknown as PeersApi} />);
    expect(await screen.findByRole("link", { name: "Traffic" })).toHaveAttribute("href", "#/traffic");
    expect(names(on.container)).toEqual(["Fleet", "Board", "Traffic"]);
    on.unmount();
    const off = render(<HistoryView initialDay="2026-10-10" fleetOptions={flags(false)} respondApi={out} />);
    await screen.findByRole("link", { name: "Podium, fleet" });
    expect(screen.queryByRole("link", { name: "Traffic" })).toBeNull();
    off.unmount();
  });

  // #468: Admin drew its own header with a single Back to fleet link.
  it.each(["checking", "locked", "disabled", "open"] as const)("draws the shared top bar on Admin when it is %s, with no Admin button", async (state) => {
    const session = state === "checking" ? new Promise<Response>(() => {}) : Promise.resolve(Response.json({ enabled: state !== "disabled", unlocked: state === "open" }));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).includes("/session") ? session : new Response("{}", { status: 404 }))));
    const admin = render(<AdminView fleetOptions={flags(true)} respondApi={{ me: vi.fn(async () => ({ enabled: true, signedIn: true, name: "Ed", admin: true })) } as unknown as RespondApi} />);
    expect(await screen.findByRole("link", { name: "Traffic" })).toBeInTheDocument();
    await waitFor(() => expect(names(admin.container)).toEqual(["Fleet", "Board", "History", "Traffic", "My reporters"]));
    expect(screen.queryByRole("link", { name: "Back to fleet" })).toBeNull();
    expect(pageName(admin.container)).toBe("Admin");
    expect(admin.container.querySelector("header.top")?.id).toBe("podium-top");
  });
});
