// My reporters (#415, mockup/podium-my-reporters.html): the top bar link and its count, Waiting for you, Your reporters,
// Defaults, and the Grid and the Board, against a fake server that keeps what it is told.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, within, waitFor } from "@testing-library/react";
import { FleetView } from "./FleetApp";
import { makeEvent, makeSession } from "./fixtures";
import { stateFrom } from "./testState";
import { RespondError, type PeersApi, type RespondApi } from "./respondApi";
import { gridCellId, VIEW_KEY } from "./components/PeerRights";
import type { PeerLevel, PeerLimitsView, PeerReporter, PeerRequestView, PeersRead } from "./peers";
import type { RespondMe } from "./types";

const ED: RespondMe = { enabled: true, signedIn: true, name: "Ed", admin: false };
const T0 = 2_000_000;

const HOUR = 3_600_000;
const rep = (key: string, machine: string, over: Partial<PeerReporter> = {}): PeerReporter => ({
  key,
  machine,
  owner: "Ed",
  adminSecret: false,
  os: "macOS 26.1",
  peers: true,
  version: "1.2.0",
  state: "reporting",
  lastSeenAt: T0 - 40_000,
  compat: "ok",
  live: [],
  ...over,
});

const PROPOSAL: PeerRequestView = { id: "prq_p", kind: "proposal", at: T0 - 300_000, from: { machine: "build-pi", name: null }, to: { machine: "ed-mbp", name: null }, fromKey: "k3", toKey: "k1", level: "ask", by: "Admin", reason: null, text: null, messageId: null };
const ACCESS: PeerRequestView = { id: "prq_a", kind: "access", at: T0 - 60_000, from: { machine: "ci-runner-01", name: "Tester" }, to: { machine: "build-pi", name: null }, fromKey: "k2", toKey: "k3", level: "ask", by: "Tester", reason: 'I need the arm64 build <img src=x onerror="alert(1)">', text: null, messageId: null };
const MESSAGE: PeerRequestView = { id: "prq_m", kind: "message", at: T0 - 42_000, from: { machine: "ed-mbp", name: "claude-dashboard" }, to: { machine: "build-pi", name: "arm64-check" }, fromKey: "k1", toKey: "k3", level: null, by: "claude-dashboard", reason: null, text: "Run npm run test:mod. The token is [redacted].", messageId: "dlv_1" };

function baseRead(): PeersRead {
  return {
    enabled: true,
    owner: "Ed",
    serverTime: T0,
    serverStartedAt: T0 - HOUR,
    reporters: [
      rep("k1", "ed-mbp", { live: [{ sessionId: "s-mac", name: "claude-dashboard", status: "running", peers: true }] }),
      rep("k2", "ci-runner-01", { os: "Ubuntu 24.04", state: "idle", lastSeenAt: T0 - 10 * 60_000 }),
      rep("k3", "build-pi", { os: "Debian 12, arm64", state: "restart", lastSeenAt: T0 - 2 * HOUR }),
      rep("k4", "win-lab", { os: "Windows 11", peers: false, version: "1.1.0", state: "silent", lastSeenAt: T0 - 3 * 24 * HOUR }),
    ],
    rights: [
      { from: "k1", to: "k1", owner: "Ed", level: "send", paused: true, setAt: 1 },
      { from: "k1", to: "k2", owner: "Ed", level: "send", paused: false, setAt: 1 },
      { from: "k2", to: "k1", owner: "Ed", level: "send", paused: false, setAt: 1 },
      { from: "k3", to: "k1", owner: "Ed", level: "see", paused: false, setAt: 1 },
    ],
    defaults: { trust: false, onRequest: "ask", newSend: "ask", limits: {} },
    limits: { server: { roundTrips: 10, perMinute: 6, maxChars: 20000 }, effective: { roundTrips: 10, perMinute: 6, maxChars: 20000 } },
    requests: [PROPOSAL, ACCESS, MESSAGE],
  };
}

/** A fake server: it keeps the rights, defaults and requests it is sent, as the real one would. */
function fakeServer(start: PeersRead = baseRead()) {
  let db: PeersRead = structuredClone(start);
  const api = {
    read: vi.fn(async () => structuredClone(db)),
    setRight: vi.fn(async (from: string, to: string, level: PeerLevel) => {
      db.rights = db.rights.filter((r) => !(r.from === from && r.to === to));
      if (level !== "none") db.rights.push({ from, to, owner: "Ed", level, paused: false, setAt: 2 });
      return { ok: true as const };
    }),
    setDefaults: vi.fn(async (patch: Parameters<PeersApi["setDefaults"]>[0]) => {
      const { limits, ...rest } = patch;
      // As the server's patchLimits: null removes the owner's own value, and one above the Admin's is refused.
      const own: Partial<PeerLimitsView> = { ...db.defaults.limits };
      for (const [k, v] of Object.entries(limits ?? {}) as [keyof PeerLimitsView, number | null][]) {
        if (v === null) delete own[k];
        else if (v > db.limits.server[k]) throw new RespondError(400, { error: `limit above the Admin's: ${k}` });
        else own[k] = v;
      }
      db.defaults = { ...db.defaults, ...rest, limits: own };
      const s = db.limits.server;
      db.limits = { server: s, effective: { roundTrips: Math.min(s.roundTrips, own.roundTrips ?? s.roundTrips), perMinute: Math.min(s.perMinute, own.perMinute ?? s.perMinute), maxChars: Math.min(s.maxChars, own.maxChars ?? s.maxChars) } };
      return { ok: true as const, defaults: db.defaults };
    }),
    answer: vi.fn(async (id: string, how: string) => {
      const r = db.requests.find((q) => q.id === id)!;
      db.requests = db.requests.filter((q) => q.id !== id);
      if (how === "allow" && r.kind === "proposal") db = { ...db, rights: [...db.rights.filter((x) => !(x.from === "k3" && x.to === "k1")), { from: "k3", to: "k1", owner: "Ed", level: r.level!, paused: false, setAt: 3 }] };
      return { ok: true as const, outcome: how === "decline" ? "declined" : "allowed" };
    }),
  } satisfies PeersApi;
  return { api, get db() { return db; } };
}

function respondApi(me: RespondMe = ED): RespondApi {
  return {
    me: vi.fn(async () => me),
    signIn: vi.fn(async () => ({ ok: true as const, name: "Ed", admin: false })),
    signOut: vi.fn(async () => ({ ok: true as const })),
    ask: vi.fn(),
    answer: vi.fn(),
    message: vi.fn(),
    discard: vi.fn(),
  } as unknown as RespondApi;
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

function page(opts: { server?: ReturnType<typeof fakeServer>; me?: RespondMe; peersFlag?: boolean; myReporters?: boolean } = {}) {
  const server = opts.server ?? fakeServer();
  const state = stateFrom({ sessions: [makeSession({ id: "s-mac", lastSeenAt: T0 - 40_000, owner: "Ed" })], features: { "activity-feed": true, "peer-messaging": opts.peersFlag ?? true } });
  const view = render(<FleetView myReporters={opts.myReporters ?? true} state={state} respondApi={respondApi(opts.me)} peersApi={server.api} />);
  return { server, ...view };
}

const cell = (from: string, to: string) => screen.getByLabelText(`${from} to ${to}`) as HTMLSelectElement;
const column = (label: string) => screen.getByRole("region", { name: new RegExp(`^${label}, \\d`) });

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ entries: [], since: T0, live: true, enabled: true, serverTime: T0 }) })));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the top bar", () => {
  it("names the page in its pill and leaves its own link off (#468)", async () => {
    page();
    await flush();
    expect(screen.getByText("My reporters", { selector: ".pill" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /My reporters/ })).toBeNull();
    expect(screen.getByText(/Signed in as/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("reads Signed in as Ed, then My reporters with the waiting count, then Sign out, on the other pages", async () => {
    page({ myReporters: false });
    await flush();
    const link = await screen.findByRole("link", { name: "My reporters · 3 waiting" });
    expect(link).toHaveAttribute("href", "#/me/reporters");
    const who = screen.getByText(/Signed in as/);
    const out = screen.getByRole("button", { name: "Sign out" });
    expect(who.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(link.compareDocumentPosition(out) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the link on the fleet page too, not as the current page, and not at all while messaging is off", async () => {
    page({ myReporters: false });
    await flush();
    expect(await screen.findByRole("link", { name: "My reporters · 3 waiting" })).not.toHaveAttribute("aria-current");
    cleanup();
    page({ myReporters: false, peersFlag: false });
    await flush();
    expect(screen.queryByRole("link", { name: /My reporters/ })).toBeNull();
  });

  it("reads plain My reporters before the first read lands (#415)", async () => {
    const server = fakeServer();
    server.api.read.mockImplementation(() => new Promise<PeersRead>(() => {}));
    page({ server });
    await flush();
    expect(screen.queryByRole("link", { name: /My reporters/ })).toBeNull();
  });

  it("keeps the top bar's own shortcut but not the wall's, which this page does not draw (#415)", async () => {
    localStorage.setItem("podium.shortcuts", "true");
    const { container } = page();
    await flush();
    const top = document.getElementById("podium-top")!;
    for (const key of ["w", "W", "Escape"]) {
      fireEvent.keyDown(document, { key });
      expect(container.querySelector(".podium")).not.toHaveClass("wall-on");
      expect(top.hidden).toBe(false);
    }
    fireEvent.keyDown(document, { key: "\\" });
    expect(top.hidden).toBe(true);
    fireEvent.keyDown(document, { key: "\\" });
    expect(top.hidden).toBe(false);
  });

  it("still leaves a wall left on from the fleet with Esc (#415)", async () => {
    const server = fakeServer();
    const state = stateFrom({ sessions: [makeSession({ id: "s-mac", lastSeenAt: T0 - 40_000, owner: "Ed" })], features: { "activity-feed": true, "peer-messaging": true } });
    const api = respondApi();
    localStorage.setItem("podium.shortcuts", "true");
    const { container, rerender } = render(<FleetView myReporters={false} state={state} respondApi={api} peersApi={server.api} />);
    await flush();
    fireEvent.keyDown(document, { key: "w" });
    expect(container.querySelector(".podium")).toHaveClass("wall-on");
    // The Board's wall-mode layout (#497) keys off this attribute, which tracks the class.
    expect(container.querySelector(".podium")).toHaveAttribute("data-wall");
    rerender(<FleetView myReporters state={state} respondApi={api} peersApi={server.api} />);
    await flush();
    expect(container.querySelector(".podium")).toHaveClass("wall-on");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector(".podium")).not.toHaveClass("wall-on");
  });

  it("offers no Wall mode, in the top bar or in the corner once the top bar is hidden (#415)", async () => {
    page();
    await flush();
    expect(screen.queryByRole("button", { name: "Enter wall mode" })).toBeNull();
    fireEvent.keyDown(document, { key: "\\" });
    expect(screen.queryByRole("button", { name: "Enter wall mode" })).toBeNull();
  });

  it("goes back to the fleet from Fleet", async () => {
    window.location.hash = "#/me/reporters";
    page();
    await flush();
    fireEvent.click(screen.getByRole("link", { name: "Fleet" }));
    expect(window.location.hash).toBe("#/");
  });
});

describe("the rail and the Activity panel around the page (#446)", () => {
  const rail = () => screen.getByRole("navigation", { name: "Orchestrators" });
  const side = () => screen.getByRole("complementary", { name: "Activity and agent detail" });
  const left = () => screen.getByRole("button", { name: /left pane$/ });
  const right = () => screen.getByRole("button", { name: /right pane$/ });

  it("draws the rail with its footer and the Activity panel, both collapsed to their edge tabs, and no legend", async () => {
    const { container } = page();
    await flush();
    expect(rail()).toHaveClass("collapsed");
    expect(side()).toHaveClass("collapsed");
    expect(left()).toHaveAttribute("aria-expanded", "false");
    expect(right()).toHaveAttribute("aria-expanded", "false");
    const cols = container.querySelector(".cols") as HTMLElement;
    expect(cols.style.getPropertyValue("--rail-w")).toBe("24px");
    expect(cols.style.getPropertyValue("--side-w")).toBe("24px");
    expect(within(cols).getByRole("main", { name: "My reporters" })).toBeInTheDocument();
    expect(container.querySelector(".legend")).toBeNull();
    expect(document.getElementById("podium-top")).toBeVisible();
    fireEvent.click(left());
    const foot = rail().querySelector(".rail-foot") as HTMLElement;
    expect(foot).toBeVisible();
    expect(within(foot).getByRole("link", { name: "Theme credits" })).toBeInTheDocument();
    expect(within(foot).getByRole("link", { name: "License" })).toBeInTheDocument();
  });

  it("opens and closes each panel from its tab and from [ and ], and keeps the flags apart from the wall's and the Board's", async () => {
    localStorage.setItem("podium.shortcuts", "true");
    page();
    await flush();
    fireEvent.click(left());
    expect(left()).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(document, { key: "]" });
    expect(right()).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(document, { key: "[" });
    expect(left()).toHaveAttribute("aria-expanded", "false");
    expect(JSON.parse(localStorage.getItem("podium.collapsed.reporters")!)).toEqual({ left: true, right: false, top: false });
    expect(localStorage.getItem("podium.collapsed")).toBeNull();
    expect(localStorage.getItem("podium.collapsed.board")).toBeNull();
    cleanup();
    page();
    await flush();
    expect(left()).toHaveAttribute("aria-expanded", "false");
    expect(right()).toHaveAttribute("aria-expanded", "true");
  });

  it("does not take the wall's or the Board's flags", async () => {
    localStorage.setItem("podium.collapsed", JSON.stringify({ left: false, right: false, top: false }));
    localStorage.setItem("podium.collapsed.board", JSON.stringify({ left: false, right: false, top: false }));
    page();
    await flush();
    expect(rail()).toHaveClass("collapsed");
    expect(side()).toHaveClass("collapsed");
  });

  it("shows the whole fleet in the rail, and selects nothing there", async () => {
    const server = fakeServer();
    const sessions = [makeSession({ id: "s-mac", name: "claude-dashboard", owner: "Ed" }), makeSession({ id: "s-kim", name: "kims-work", owner: "Kim" })];
    render(<FleetView myReporters state={stateFrom({ sessions, features: { "activity-feed": true, "peer-messaging": true } })} respondApi={respondApi()} peersApi={server.api} />);
    await flush();
    fireEvent.click(left());
    expect(within(rail()).getByText("kims-work")).toBeInTheDocument();
    expect(rail().querySelector('.ritem[aria-current="true"]')).toHaveTextContent("All orchestrators");
  });

  it("leaves for the orchestrator's page from a rail row, and for the wall from All orchestrators", async () => {
    window.location.hash = "#/me/reporters";
    page();
    await flush();
    fireEvent.click(left());
    fireEvent.click(within(rail()).getByText("api-refactor"));
    expect(window.location.hash).toBe("#/?open=s-mac");
    window.location.hash = "#/me/reporters";
    fireEvent.click(within(rail()).getByText("All orchestrators"));
    expect(window.location.hash).toBe("#/");
  });

  it("says at the top of the page when a Remove in the rail fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).endsWith("/drop") ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, json: async () => ({ entries: [], since: T0, live: true, enabled: true, serverTime: T0 }) })));
    const server = fakeServer();
    const state = stateFrom({ sessions: [makeSession({ id: "s-old", name: "old-one", status: "stale" })], features: { "activity-feed": true, "peer-messaging": true } });
    render(<FleetView myReporters state={state} respondApi={respondApi()} peersApi={server.api} />);
    await flush();
    fireEvent.click(left());
    fireEvent.click(screen.getByRole("button", { name: "Remove old-one from the fleet" }));
    await flush();
    const main = screen.getByRole("main", { name: "My reporters" });
    expect(within(main).getByText("Could not remove the session: HTTP 500. Try again.").closest(".callout.notice")).toHaveAttribute("role", "status");
  });

  it("drops the orchestrator picked on the fleet, as the Board does, so it leaving raises nothing here", async () => {
    const server = fakeServer();
    const api = respondApi();
    const features = { "activity-feed": true, "peer-messaging": true };
    const state = stateFrom({ sessions: [makeSession({ id: "s1", name: "picked" })], features });
    const { rerender } = render(<FleetView myReporters={false} state={state} respondApi={api} peersApi={server.api} />);
    await flush();
    fireEvent.click(within(rail()).getByText("picked"));
    rerender(<FleetView myReporters state={state} respondApi={api} peersApi={server.api} />);
    await flush();
    rerender(<FleetView myReporters state={stateFrom({ sessions: [], features })} respondApi={api} peersApi={server.api} />);
    await flush();
    expect(screen.queryByText(/left the fleet/)).toBeNull();
  });

  it("leaves for the orchestrator's page from an activity event", async () => {
    window.location.hash = "#/me/reporters";
    const server = fakeServer();
    const state = stateFrom({ sessions: [makeSession({ id: "s1" })], events: [makeEvent({ id: "x", sessionId: "s1", text: "something" })], features: { "activity-feed": true, "peer-messaging": true } });
    render(<FleetView myReporters state={state} respondApi={respondApi()} peersApi={server.api} />);
    await flush();
    fireEvent.click(right());
    fireEvent.click(within(side()).getByText("something"));
    expect(window.location.hash).toBe("#/?open=s1");
  });
});

describe("Waiting for you", () => {
  it("counts a request's age by the server's clock when the browser's is three minutes ahead (#467)", async () => {
    vi.setSystemTime(T0 + 3 * 60_000);
    const read = baseRead();
    read.requests = [{ ...MESSAGE, at: T0 - 2_000 }];
    page({ server: fakeServer(read) });
    await flush();
    const region = screen.getByRole("region", { name: "Waiting for you" });
    expect(region).toHaveTextContent("Sent just now.");
  });

  it("names who asked and what changes, with a button per answer", async () => {
    page();
    await flush();
    const region = screen.getByRole("region", { name: "Waiting for you" });
    const proposal = within(region).getByRole("group", { name: "A change an Admin proposes" });
    expect(proposal).toHaveTextContent("An Admin proposes that build-pi can send to ed-mbp, with approval.");
    expect(proposal).toHaveTextContent("Proposed 5 min ago. Today build-pi can only see ed-mbp.");
    expect(within(proposal).getByRole("button", { name: "Accept change" })).toBeInTheDocument();
    const access = within(region).getByRole("group", { name: "A request for access" });
    expect(access).toHaveTextContent("Tester on ci-runner-01 asks to send to build-pi.");
    expect(access).toHaveTextContent("Allowing it gives Can send, with approval.");
    const message = within(region).getByRole("group", { name: "A message waiting for approval" });
    expect(message).toHaveTextContent("A message from claude-dashboard on ed-mbp to arm64-check on build-pi waits for your approval.");
    expect(within(message).getByRole("button", { name: "Deliver" })).toBeInTheDocument();
  });

  it("says an access request changes nothing when the pair already has as much, since allowing never lowers a right (#414)", async () => {
    const d = baseRead();
    d.rights.push({ from: "k2", to: "k3", owner: "Ed", level: "send", paused: false, setAt: 1 });
    d.requests = [{ ...ACCESS, level: "see" }];
    page({ server: fakeServer(d) });
    await flush();
    const access = screen.getByRole("group", { name: "A request for access" });
    expect(access).toHaveTextContent("Allowing it changes nothing: today ci-runner-01 can send to build-pi.");
    expect(access).not.toHaveTextContent("Allowing it gives");
  });

  it("matches a proposal to its Grid cell by reporter key when two machines share a name (#415)", async () => {
    const d = baseRead();
    // A second build-pi with no rights yet; the Admin proposes for it, not for k3.
    d.reporters.push(rep("k5", "build-pi"));
    d.requests = [{ ...PROPOSAL, fromKey: "k5" }];
    page({ server: fakeServer(d) });
    await flush();
    const proposal = screen.getByRole("group", { name: "A change an Admin proposes" });
    expect(proposal).toHaveTextContent("Proposed 5 min ago. Today build-pi has no access to ed-mbp.");
    const tag = screen.getByText("Proposed: Can send, with approval, waiting for you");
    expect(tag.closest("td")!.querySelector("select")).toHaveAttribute("id", gridCellId("k5", "k1"));
  });

  it("draws an orchestrator's reason and message as text, with only Podium's [redacted] marker as an element", async () => {
    const { container } = page();
    await flush();
    expect(container.querySelector(".pm-quote img")).toBeNull();
    expect(screen.getByText(/I need the arm64 build <img src=x/)).toBeInTheDocument();
    const mark = screen.getByText("[redacted]");
    expect(mark).toHaveClass("rd");
    expect(mark).toHaveAttribute("title", "Replaced on the sending machine. The original never left it.");
  });

  it("applies an Admin's proposal when it is accepted, and the request leaves the list and the count", async () => {
    const { server } = page();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Accept change" }));
    await flush();
    expect(server.api.answer).toHaveBeenCalledWith("prq_p", "allow");
    expect(cell("build-pi", "ed-mbp").value).toBe("ask");
    expect(screen.queryByRole("group", { name: "A change an Admin proposes" })).toBeNull();
    expect(screen.queryByRole("link", { name: /My reporters/ })).toBeNull();
  });

  it("delivers and declines with the matching answer", async () => {
    const { server } = page();
    await flush();
    fireEvent.click(within(screen.getByRole("group", { name: "A message waiting for approval" })).getByRole("button", { name: "Deliver" }));
    await flush();
    expect(server.api.answer).toHaveBeenCalledWith("prq_m", "deliver");
    fireEvent.click(within(screen.getByRole("group", { name: "A request for access" })).getByRole("button", { name: "Decline" }));
    await flush();
    expect(server.api.answer).toHaveBeenCalledWith("prq_a", "decline");
    expect(screen.getByText("Declined.")).toBeInTheDocument();
  });

  it("says a request that was already answered elsewhere changed nothing", async () => {
    const server = fakeServer();
    server.api.answer.mockRejectedValueOnce(new RespondError(410, { error: "already answered: allowed" }));
    page({ server });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Accept change" }));
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not answer: already answered: allowed. Nothing changed.");
  });

  it("is left out when nothing waits", async () => {
    page({ myReporters: false, server: fakeServer({ ...baseRead(), requests: [] }) });
    await flush();
    expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull();
    // Nothing waiting: plain "My reporters", never "· 0 waiting" (#415).
    expect(screen.getByRole("link", { name: "My reporters" })).toHaveAttribute("href", "#/me/reporters");
    // In the top bar: the rail's "All orchestrators" line counts "0 waiting" orchestrators, which is another thing (#446).
    expect(within(document.getElementById("podium-top")!).queryByText(/0 waiting/)).toBeNull();
  });
});

describe("Your reporters", () => {
  it("lists state, machine, system, messaging, version, last report and live orchestrators", async () => {
    page();
    await flush();
    const table = within(screen.getByRole("region", { name: "Table of your reporters" }));
    const mac = table.getByText("ed-mbp").closest("tr")!;
    expect(mac).toHaveTextContent("Reporting");
    expect(mac).toHaveTextContent("macOS 26.1");
    expect(within(mac).getByText("On")).toHaveClass("badge", "ok");
    expect(mac).toHaveTextContent("40 s ago");
    expect(mac.lastElementChild).toHaveTextContent("1");
    const win = table.getByText("win-lab").closest("tr")!;
    expect(within(win).getByText("Off on the machine")).toHaveClass("badge", "off");
    // A state is a shape and a word, as Admin's badges are (patterns.html#status).
    expect(within(mac).getByText("On").querySelector(".dot.running")).not.toBeNull();
    expect(within(win).getByText("Off on the machine").querySelector(".dot:not(.running)")).not.toBeNull();
    expect(win).toHaveTextContent("1.1.0");
    expect(screen.getByText(/win-lab has messaging off\. Only that machine can turn it on/)).toBeInTheDocument();
    expect(screen.getByText("Showing 1 to 4 of 4")).toBeInTheDocument();
  });

  it("shows the server's state for each reporter with the badge, words and note Admin > Reporters uses, and its last report (#415)", async () => {
    page();
    await flush();
    const table = within(screen.getByRole("region", { name: "Table of your reporters" }));
    const row = (machine: string) => table.getByText(machine, { selector: ".pm-name" }).closest("tr")!;
    const badge = (machine: string) => row(machine).querySelector(".tip.rstate")!;
    expect(badge("ed-mbp")).toHaveClass("reporting");
    expect(badge("ed-mbp").firstChild).toHaveClass("rdot", "reporting");
    expect(within(row("ed-mbp")).getByRole("tooltip", { hidden: true })).toHaveTextContent(/^Heard from in the last 2 minutes\. Last heard 40 s ago/);
    expect(badge("ci-runner-01")).toHaveClass("idle");
    expect(badge("ci-runner-01")).toHaveTextContent(/^Idle/);
    expect(row("ci-runner-01")).toHaveTextContent("10 min ago");
    expect(badge("build-pi")).toHaveTextContent(/^Not since restart/);
    expect(within(row("build-pi")).getByRole("tooltip", { hidden: true })).toHaveTextContent(/This server started 1 h ago/);
    expect(badge("win-lab")).toHaveClass("silent");
    expect(badge("win-lab")).toHaveTextContent(/^Silent/);
    expect(row("win-lab")).toHaveTextContent("3 days ago");
    // A reporter with no live session is not given a state of its own: the server's words are the only ones.
    expect(screen.queryByText("No live session")).toBeNull();
  });

  it("flags an outdated reporter from the server's check, as Admin > Reporters does, live session or not (#415)", async () => {
    const d = baseRead();
    d.reporters[3] = { ...d.reporters[3]!, compat: "outdated" };
    page({ server: fakeServer(d) });
    await flush();
    const table = within(screen.getByRole("region", { name: "Table of your reporters" }));
    const version = table.getByText("win-lab", { selector: ".pm-name" }).closest("tr")!.querySelector(".compat")!;
    expect(version).toHaveClass("compat", "outdated");
    expect(version).toHaveTextContent("1.1.0 outdated");
  });

  it("says how to update a reporter too old to message", async () => {
    const d = baseRead();
    d.reporters[3] = { ...d.reporters[3]!, peers: null };
    page({ server: fakeServer(d) });
    await flush();
    expect(screen.getAllByText("Reporter can't message: update it").length).toBeGreaterThan(0);
    expect(screen.getByText(/win-lab's reporter is too old to message/)).toBeInTheDocument();
  });

  it("cuts a long machine name and keeps it whole as a title", async () => {
    const d = baseRead();
    const long = "ed-macbook-pro-16-inch-2026-home-office";
    d.reporters[0] = { ...d.reporters[0]!, machine: long };
    page({ server: fakeServer(d) });
    await flush();
    const names = screen.getAllByTitle(long);
    expect(names.length).toBeGreaterThan(1);
    expect(names.some((n) => n.classList.contains("pm-name"))).toBe(true);
  });
});

describe("Defaults", () => {
  it("turns Trust my own reporters on, which locks every choice and says so", async () => {
    const { server } = page();
    await flush();
    fireEvent.click(screen.getByRole("switch", { name: "Trust my own reporters Off" }));
    await flush();
    expect(server.api.setDefaults).toHaveBeenCalledWith({ trust: true });
    expect(screen.getByRole("switch", { name: "Trust my own reporters On" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Trust my own reporters is on.")).toBeInTheDocument();
    expect(cell("ci-runner-01", "build-pi")).toBeDisabled();
    expect(cell("ci-runner-01", "build-pi").value).toBe("send");
  });

  it("picks an answer for an orchestrator's request and a start for a new right, with the arrow keys too", async () => {
    const { server } = page();
    await flush();
    const ask = screen.getByRole("radiogroup", { name: "When an orchestrator asks for access" });
    fireEvent.keyDown(within(ask).getByRole("radio", { name: "Ask me" }), { key: "ArrowRight" });
    await flush();
    expect(server.api.setDefaults).toHaveBeenCalledWith({ onRequest: "allow" });
    expect(within(ask).getByRole("radio", { name: "Allow" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "A new right to send starts as" })).getByRole("radio", { name: "Without approval" }));
    await flush();
    expect(server.api.setDefaults).toHaveBeenCalledWith({ newSend: "send" });
  });
});

describe("Defaults: the owner's stricter limits (#436)", () => {
  const TRIPS = "Round trips before a person approves";
  const RATE = "Messages per minute on a link";
  const SIZE = "Longest message, in characters";
  const box = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
  const type = async (label: string, text: string, how: "blur" | "enter" = "blur") => {
    fireEvent.change(box(label), { target: { value: text } });
    if (how === "enter") fireEvent.keyDown(box(label), { key: "Enter" });
    else fireEvent.blur(box(label));
    await flush();
  };
  const withLimits = (own: Partial<PeerLimitsView>, server: PeerLimitsView = { roundTrips: 10, perMinute: 6, maxChars: 20000 }) => {
    const d = baseRead();
    d.defaults.limits = own;
    d.limits = {
      server,
      effective: { roundTrips: Math.min(server.roundTrips, own.roundTrips ?? server.roundTrips), perMinute: Math.min(server.perMinute, own.perMinute ?? server.perMinute), maxChars: Math.min(server.maxChars, own.maxChars ?? server.maxChars) },
    };
    return fakeServer(d);
  };

  it("shows the three limits, each using the Admin's, with the Admin's value as the most", async () => {
    page();
    await flush();
    expect(box(TRIPS).value).toBe("10");
    expect(box(RATE).value).toBe("6");
    expect(box(SIZE).value).toBe("20000");
    expect(box(TRIPS)).toHaveAttribute("max", "10");
    expect(box(SIZE)).toHaveAttribute("max", "20000");
    expect(box(TRIPS)).toHaveAccessibleDescription("Uses the Admin's limit, 10.");
    expect(screen.getByText("Uses the Admin's limit, 20,000.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /use the Admin's limit/i })).not.toBeInTheDocument();
    expect(screen.getByText(/The Admin sets the most each limit can be on this server, and yours can only be lower\./)).toBeInTheDocument();
  });

  it("lowers each limit as the owner's own, announces it, and a reload shows it", async () => {
    const { server, unmount } = page();
    await flush();
    await type(TRIPS, "4");
    expect(server.api.setDefaults).toHaveBeenLastCalledWith({ limits: { roundTrips: 4 } });
    await type(RATE, "3", "enter");
    expect(server.api.setDefaults).toHaveBeenLastCalledWith({ limits: { perMinute: 3 } });
    await type(SIZE, "8000");
    expect(server.api.setDefaults).toHaveBeenLastCalledWith({ limits: { maxChars: 8000 } });
    expect(box(TRIPS)).toHaveAccessibleDescription("Yours, stricter than the Admin's limit, 10.");
    expect(screen.getByText("Longest message, in characters: 8,000, yours.")).toHaveAttribute("role", "status");
    expect(server.db.defaults.limits).toEqual({ roundTrips: 4, perMinute: 3, maxChars: 8000 });
    unmount();
    page({ server });
    await flush();
    expect(box(TRIPS).value).toBe("4");
    expect(box(RATE).value).toBe("3");
    expect(box(SIZE).value).toBe("8000");
    expect(screen.getAllByRole("button", { name: /use the Admin's limit/i })).toHaveLength(3);
  });

  it("saves once for Enter and then leaving the box, and sends nothing when the value did not change", async () => {
    const { server } = page();
    await flush();
    fireEvent.change(box(TRIPS), { target: { value: "4" } });
    fireEvent.keyDown(box(TRIPS), { key: "Enter" });
    fireEvent.blur(box(TRIPS));
    await flush();
    expect(server.api.setDefaults).toHaveBeenCalledTimes(1);
    await type(RATE, "6");
    expect(server.api.setDefaults).toHaveBeenCalledTimes(1);
  });

  it("goes back to the Admin's limit with its button, which keeps focus on the box", async () => {
    const server = withLimits({ perMinute: 3 });
    page({ server });
    await flush();
    expect(box(RATE).value).toBe("3");
    const use = screen.getByRole("button", { name: "Messages per minute on a link: use the Admin's limit, 6" });
    expect(use).toHaveTextContent("Use the Admin's limit");
    fireEvent.click(use);
    await flush();
    expect(server.api.setDefaults).toHaveBeenLastCalledWith({ limits: { perMinute: null } });
    expect(box(RATE).value).toBe("6");
    expect(box(RATE)).toHaveAccessibleDescription("Uses the Admin's limit, 6.");
    expect(box(RATE)).toHaveFocus();
    expect(screen.queryByRole("button", { name: /use the Admin's limit/i })).not.toBeInTheDocument();
  });

  it("treats typing exactly the Admin's value as using the Admin's", async () => {
    const server = withLimits({ maxChars: 8000 });
    page({ server });
    await flush();
    await type(SIZE, "20000");
    expect(server.api.setDefaults).toHaveBeenLastCalledWith({ limits: { maxChars: null } });
    expect(server.db.defaults.limits).toEqual({});
    expect(box(SIZE)).toHaveAccessibleDescription("Uses the Admin's limit, 20,000.");
  });

  it("goes back to the Admin's limit by typing it, when the owner's own value is the same as the Admin's or above it", async () => {
    // Own 15 over the Admin's 10, and own 6 equal to the Admin's 6: each box shows the Admin's value already.
    const server = withLimits({ roundTrips: 15, perMinute: 6 }, { roundTrips: 10, perMinute: 6, maxChars: 20000 });
    page({ server });
    await flush();
    expect(box(TRIPS).value).toBe("10");
    await type(TRIPS, "10");
    expect(server.api.setDefaults).toHaveBeenLastCalledWith({ limits: { roundTrips: null } });
    expect(box(TRIPS)).toHaveAccessibleDescription("Uses the Admin's limit, 10.");
    await type(RATE, "6", "enter");
    expect(server.api.setDefaults).toHaveBeenLastCalledWith({ limits: { perMinute: null } });
    expect(server.db.defaults.limits).toEqual({});
    expect(box(RATE)).toHaveAccessibleDescription("Uses the Admin's limit, 6.");
    // Now that nothing is the owner's own, the same value again sends nothing.
    await type(RATE, "6");
    expect(server.api.setDefaults).toHaveBeenCalledTimes(2);
  });

  it("refuses a value above the Admin's, below 1, not whole, or cleared, in place, and saves nothing", async () => {
    const { server } = page();
    await flush();
    await type(TRIPS, "15");
    expect(screen.getByText("15 is above the Admin's limit, 10. Enter a whole number from 1 to 10. Nothing was saved.")).toHaveAttribute("role", "alert");
    expect(box(TRIPS)).toHaveAttribute("aria-invalid", "true");
    expect(box(TRIPS)).toHaveAccessibleDescription("Uses the Admin's limit, 10. 15 is above the Admin's limit, 10. Enter a whole number from 1 to 10. Nothing was saved.");
    expect(box(TRIPS).value).toBe("15");
    await type(RATE, "0");
    expect(screen.getByText("0 is below 1. Enter a whole number from 1 to 6, or pause the link under Who can message whom. Nothing was saved.")).toBeInTheDocument();
    await type(SIZE, "2.5");
    expect(screen.getByText("2.5 is not a whole number. Enter a whole number from 1 to 20,000. Nothing was saved.")).toBeInTheDocument();
    await type(SIZE, "");
    expect(screen.getByText("Enter a whole number from 1 to 20,000. Nothing was saved.")).toBeInTheDocument();
    expect(server.api.setDefaults).not.toHaveBeenCalled();
    expect(screen.queryByText(/Could not save the change/)).not.toBeInTheDocument();
  });

  it("keeps the owner's value when the Admin lowers theirs below it, and says the lower one applies", async () => {
    const server = withLimits({ roundTrips: 8, perMinute: 2 }, { roundTrips: 5, perMinute: 2, maxChars: 20000 });
    page({ server });
    await flush();
    expect(box(TRIPS).value).toBe("5");
    expect(box(TRIPS)).toHaveAttribute("max", "5");
    expect(box(TRIPS)).toHaveAccessibleDescription("The Admin's limit is now 5, lower than yours, 8, so 5 applies.");
    expect(box(RATE)).toHaveAccessibleDescription("Yours, the same as the Admin's limit, 2.");
    expect(screen.getByRole("button", { name: `${TRIPS}: use the Admin's limit, 5` })).toBeInTheDocument();
    expect(server.db.defaults.limits.roundTrips).toBe(8);
  });

  it("shows a refusal from the server in place, and the value that still applies", async () => {
    const server = fakeServer();
    server.api.setDefaults.mockRejectedValueOnce(new RespondError(400, { error: "Round trips must be a whole number from 1 to 3" }));
    page({ server });
    await flush();
    await type(TRIPS, "4");
    expect(screen.getByText("Round trips must be a whole number from 1 to 3. Nothing was saved. The saved value, 10, still applies.")).toBeInTheDocument();
    expect(box(TRIPS).value).toBe("4");
    expect(screen.queryByText(/Could not save the change/)).not.toBeInTheDocument();
  });

  it("says when going back to the Admin's limit could not be saved", async () => {
    const server = withLimits({ roundTrips: 4 });
    server.api.setDefaults.mockRejectedValueOnce(new Error("offline"));
    page({ server });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: `${TRIPS}: use the Admin's limit, 10` }));
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save the change: the server did not answer. Nothing changed. Try again.");
    expect(box(TRIPS).value).toBe("4");
  });
});

describe("the Grid", () => {
  it("has a select named A to B for every pair, says why a pair with messaging off has none, and marks the diagonal", async () => {
    page();
    await flush();
    expect(cell("ed-mbp", "ci-runner-01").value).toBe("send");
    expect(cell("build-pi", "ed-mbp").value).toBe("see");
    expect(screen.queryByLabelText("ed-mbp to win-lab")).toBeNull();
    expect(screen.getAllByText("Messaging is off on win-lab").length).toBe(7);
    expect(screen.getAllByText("Between orchestrators on this machine").length).toBe(3);
    expect(screen.getByText("Proposed: Can send, with approval, waiting for you")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });

  it("saves a change, keeps focus on the select, announces it, and the Board and a reload show it", async () => {
    const server = fakeServer();
    const first = page({ server });
    await flush();
    const sel = cell("ci-runner-01", "build-pi");
    sel.focus();
    fireEvent.change(sel, { target: { value: "see" } });
    await flush();
    expect(server.api.setRight).toHaveBeenCalledWith("k2", "k3", "see");
    expect(document.activeElement).toBe(cell("ci-runner-01", "build-pi"));
    expect(screen.getByText("ci-runner-01 to build-pi: Can see.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Board" }));
    fireEvent.click(screen.getByRole("radio", { name: "ci-runner-01" }));
    expect(within(column("Can see")).getByText("build-pi")).toBeInTheDocument();
    first.unmount();
    page({ server });
    await flush();
    // The Board was the last view picked in this browser, so it opens again.
    expect(screen.getByRole("radio", { name: "Board" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Grid" }));
    expect(cell("ci-runner-01", "build-pi").value).toBe("see");
  });

  it("asks at once whether B can answer when A can now send to B, and puts focus back after the answer", async () => {
    const { server } = page();
    await flush();
    const sel = cell("ed-mbp", "build-pi");
    sel.focus();
    fireEvent.change(sel, { target: { value: "send" } });
    await flush();
    const prompt = screen.getByRole("group", { name: "Can build-pi answer?" });
    expect(prompt).toHaveTextContent("ed-mbp can now send to build-pi. Can build-pi answer?");
    fireEvent.click(within(prompt).getByRole("button", { name: "Can send, with approval" }));
    await flush();
    expect(server.api.setRight).toHaveBeenLastCalledWith("k3", "k1", "ask");
    expect(screen.queryByRole("group", { name: "Can build-pi answer?" })).toBeNull();
    expect(document.activeElement).toBe(cell("ed-mbp", "build-pi"));
    expect(cell("build-pi", "ed-mbp").value).toBe("ask");
  });

  it("leaves the other way alone on Not now", async () => {
    const { server } = page();
    await flush();
    fireEvent.change(cell("ci-runner-01", "build-pi"), { target: { value: "ask" } });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await flush();
    expect(server.api.setRight).toHaveBeenCalledTimes(1);
  });

  it("says a failed save changed nothing, and shows the old level again", async () => {
    const server = fakeServer();
    server.api.setRight.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    page({ server });
    await flush();
    fireEvent.change(cell("ed-mbp", "ci-runner-01"), { target: { value: "none" } });
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save the change: the server did not answer. Nothing changed. Try again.");
    expect(cell("ed-mbp", "ci-runner-01").value).toBe("send");
    expect(screen.queryByRole("group", { name: /answer\?$/ })).toBeNull();
  });
});

describe("the Board", () => {
  beforeEach(() => localStorage.setItem(VIEW_KEY, JSON.stringify("board")));

  it("shows one reporter's peers in four labelled columns with their counts, and what each can do back", async () => {
    page();
    await flush();
    expect(column("No access")).toHaveAccessibleName("No access, 2 reporters");
    // A level's class is prefixed: the bare `.none` and `.ask` already style other parts of the console.
    expect(column("Can send, with approval").querySelector("h3 .pm-lv")).toHaveClass("pm-lv", "lv-ask");
    expect(column("No access").querySelector("h3 .pm-lv")).not.toHaveClass("none");
    expect(column("Can send")).toHaveAccessibleName("Can send, 2 reporters");
    const ci = within(column("Can send")).getByText("ci-runner-01").closest(".pm-card")!;
    expect(ci.querySelector(".backl")).toHaveTextContent("ci-runner-01 to ed-mbp: Can send");
    expect(within(column("Can send")).getByText(/Within/)).toBeInTheDocument();
    const win = within(column("No access")).getByText("win-lab").closest(".pm-card")!;
    expect(win).toHaveClass("locked");
    expect(win).toHaveAttribute("draggable", "false");
    expect(within(column("Can see")).getByText("None here. Drag a reporter here or use its Move to list.")).toBeInTheDocument();
    // Only reporters with messaging on can be picked.
    expect(screen.queryByRole("radio", { name: "win-lab" })).toBeNull();
  });

  it("moves a card with its Move to list, saves it, keeps focus on that list, announces it, and the Grid shows it", async () => {
    const { server } = page();
    await flush();
    const move = screen.getByLabelText("Move build-pi to") as HTMLSelectElement;
    move.focus();
    fireEvent.change(move, { target: { value: "see" } });
    expect(document.activeElement).toBe(screen.getByLabelText("Move build-pi to"));
    expect(within(column("Can see")).getByText("build-pi")).toBeInTheDocument();
    await flush();
    expect(server.api.setRight).toHaveBeenCalledWith("k1", "k3", "see");
    expect(screen.getByText("ed-mbp to build-pi: Can see.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Grid" }));
    expect(cell("ed-mbp", "build-pi").value).toBe("see");
  });

  it("moves a card dropped on another column", async () => {
    const { server } = page();
    await flush();
    const card = within(column("No access")).getByText("build-pi").closest(".pm-card")!;
    fireEvent.dragStart(card);
    fireEvent.dragOver(column("Can send"));
    expect(column("Can send")).toHaveClass("over");
    fireEvent.drop(column("Can send"));
    await flush();
    expect(server.api.setRight).toHaveBeenCalledWith("k1", "k3", "send");
    expect(within(column("Can send")).getByText("build-pi")).toBeInTheDocument();
    // A drop on the column it is already in does nothing.
    const again = within(column("Can send")).getByText("build-pi").closest(".pm-card")!;
    fireEvent.dragStart(again);
    fireEvent.dragLeave(column("Can send"));
    fireEvent.drop(column("Can send"));
    fireEvent.dragEnd(again);
    await flush();
    expect(server.api.setRight).toHaveBeenCalledTimes(1);
  });

  it("switches whose peers it shows", async () => {
    page();
    await flush();
    fireEvent.keyDown(screen.getByRole("radio", { name: "ed-mbp" }), { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "ci-runner-01" })).toHaveAttribute("aria-checked", "true");
    // ci-runner-01 has no right to its own orchestrators yet, so its own card is under No access.
    expect(within(column("No access")).getByText(/Within/).closest(".pm-card")).toHaveTextContent("ci-runner-01");
  });

  it("says there is nothing to arrange when no reporter has messaging on", async () => {
    const d = baseRead();
    d.reporters = d.reporters.map((r) => ({ ...r, peers: false }));
    page({ server: fakeServer(d) });
    await flush();
    expect(screen.getByText(/None of your reporters has messaging on yet/)).toBeInTheDocument();
  });
});

describe("cases", () => {
  it("says No reporters yet, and how a machine gets here", async () => {
    page({ server: fakeServer({ ...baseRead(), reporters: [], rights: [], requests: [] }) });
    await flush();
    expect(screen.getByText("No reporters yet")).toBeInTheDocument();
    expect(screen.getByText(/A machine shows here once it reports with your name and token/)).toBeInTheDocument();
  });

  it("asks a signed-out person to sign in", async () => {
    page({ me: { enabled: true, signedIn: false, name: null, admin: false } });
    await flush();
    expect(screen.getByText("Sign in to see your reporters")).toBeInTheDocument();
  });

  it("says messaging is off when the Admin's flag is off", async () => {
    page({ peersFlag: false });
    await flush();
    expect(screen.getByText("Orchestrator messaging is off")).toBeInTheDocument();
  });

  it("says the admin secret has no reporters", async () => {
    page({ me: { enabled: true, signedIn: true, name: "Admin", admin: true } });
    await flush();
    expect(screen.getByText("The admin secret has no reporters")).toBeInTheDocument();
  });

  it("shows a refusal in the server's words, and a load that failed", async () => {
    const server = fakeServer();
    server.api.read.mockRejectedValue(new RespondError(403, { error: "sign in to manage your reporters" }));
    page({ server });
    await flush();
    expect(screen.getByText("Sign in to manage your reporters.")).toBeInTheDocument();
    cleanup();
    const down = fakeServer();
    down.api.read.mockRejectedValue(new TypeError("Failed to fetch"));
    page({ server: down });
    await flush();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not load your reporters: the server did not answer."));
  });
});
