// Traffic (#417, mockup/podium-traffic.html): the top bar link, the map, the conversation with Pause link and Remove
// link, the Table and the Show range, and what a signed-out browser gets, against a fake server that keeps what it is told.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { FleetView } from "./FleetApp";
import { makeSession } from "./fixtures";
import { stateFrom } from "./testState";
import { RespondError, type PeersApi, type RespondApi } from "./respondApi";
import type { PeerReporter, PeersRead } from "./peers";
import type { PeerMessage, TrafficApi, TrafficEnd, TrafficLink, TrafficRead } from "./trafficData";
import type { RespondMe } from "./types";

const ED: RespondMe = { enabled: true, signedIn: true, name: "Ed", admin: false };
const OUT: RespondMe = { enabled: true, signedIn: false, name: null, admin: false };
const ANN_ADMIN: RespondMe = { enabled: true, signedIn: true, name: "Ann", admin: true };
const T0 = 2_000_000_000_000;

const end = (sessionId: string, name: string, machine: string, reporterKey: string): TrafficEnd => ({ sessionId, name, machine, reporterKey });
const DEV = end("s-dev", "claude-dashboard", "ed-mbp", "k1");
const NOTES = end("s-notes", "infra-notes", "ed-mbp", "k1");
const TESTER = end("s-tester", "Tester", "ci-runner-01", "k2");
const ARM = end("s-arm", "arm64-check", "build-pi", "k3");

const link = (a: TrafficEnd, b: TrafficEnd, over: Partial<TrafficLink> = {}): TrafficLink => ({
  link: `${a.reporterKey}|${b.reporterKey}`,
  a,
  b,
  owner: "Ed",
  messages: 2,
  lastAt: T0 - 60_000,
  state: "active",
  aToB: true,
  bToA: true,
  roundTrips: { used: 2, cap: 10 },
  ...over,
});

function baseLinks(): TrafficLink[] {
  return [
    link(DEV, TESTER, { messages: 5 }),
    link(DEV, ARM, { state: "waiting", bToA: false, roundTrips: { used: 0, cap: 10 }, lastAt: T0 - 240_000 }),
    link(NOTES, TESTER, { lastAt: T0 - 22 * 60_000 }),
    link(DEV, NOTES, { messages: 3, state: "paused", lastAt: T0 - 3_600_000 }),
  ];
}

const msg = (id: string, from: TrafficEnd, to: TrafficEnd, text: string, over: Partial<PeerMessage> = {}): PeerMessage => ({
  id,
  from,
  to,
  owner: "Ed",
  text,
  sentAt: T0 - 600_000,
  state: "delivered",
  stateAt: T0 - 590_000,
  why: null,
  approved: false,
  ...over,
});

const MESSAGES: Record<string, PeerMessage[]> = {
  "s-dev|s-tester": [
    msg("m1", DEV, TESTER, "Please run the systemd unit tests.\nReport each failure."),
    msg("m2", TESTER, DEV, '2 of 14 failed. <img src=x onerror="alert(1)"> The token is [redacted], ask [redacted].', { sentAt: T0 - 500_000 }),
    msg("m3", DEV, TESTER, "Can you run the same on Debian 12 next?", { sentAt: T0 - 400_000, state: "ready" }),
  ],
  "s-dev|s-arm": [
    msg("m4", DEV, ARM, "Build podium-reporter for arm64.", { approved: true }),
    msg("m5", DEV, ARM, "Also run npm run test:mod there.", { state: "approval" }),
  ],
  "s-notes|s-tester": [msg("m6", NOTES, TESTER, "What version of systemd?", { state: "dropped", why: "receiver-ended" })],
  "s-dev|s-notes": [msg("m7", DEV, NOTES, "Here are the unit files.", { state: "ready" }), msg("m8", NOTES, DEV, "No.", { state: "declined" })],
};

/** A fake server: it keeps the links' states it is told to change, as the real one would. */
function fakeTraffic(start: TrafficLink[] = baseLinks()) {
  let links = structuredClone(start);
  const between = (l: TrafficLink, a: string, b: string) => (l.a.reporterKey === a && l.b.reporterKey === b) || (l.a.reporterKey === b && l.b.reporterKey === a);
  const api = {
    read: vi.fn(async (_range: string): Promise<TrafficRead> => ({ enabled: true, conversations: structuredClone(links), retainDays: 30 })),
    conversation: vi.fn(async (a: string, b: string) => {
      const m = MESSAGES[`${a}|${b}`];
      if (!m) throw new RespondError(404, { error: "no such conversation" });
      return { messages: structuredClone(m) };
    }),
    pause: vi.fn(async (a: string, b: string, paused: boolean) => {
      links = links.map((l) => (between(l, a, b) && l.state !== "waiting" ? { ...l, state: paused ? "paused" : "active" } : l));
      return { ok: true as const };
    }),
    remove: vi.fn(async (a: string, b: string) => {
      links = links.map((l) => (between(l, a, b) ? { ...l, aToB: false, bToA: false, state: l.state === "paused" ? "active" : l.state } : l));
      return { ok: true as const };
    }),
  } satisfies TrafficApi;
  return { api };
}

const rep = (key: string, machine: string, os: string | null, peers: boolean | null = true): PeerReporter => ({
  key,
  machine,
  owner: "Ed",
  adminSecret: false,
  os,
  peers,
  version: "1.2.0",
  state: "reporting",
  lastSeenAt: T0,
  compat: "ok",
  live: [],
});

function peersApi(): PeersApi {
  const read: PeersRead = {
    enabled: true,
    owner: "Ed",
    serverTime: T0,
    serverStartedAt: T0 - 3_600_000,
    reporters: [rep("k1", "ed-mbp", "macOS 26.1"), rep("k2", "ci-runner-01", "Ubuntu 24.04"), rep("k3", "build-pi", null), rep("k4", "win-lab", "Windows 11", false)],
    rights: [],
    defaults: { trust: false, onRequest: "ask", newSend: "ask", limits: {} },
    limits: { server: { roundTrips: 10, perMinute: 6, maxChars: 20000 }, effective: { roundTrips: 10, perMinute: 6, maxChars: 20000 } },
    requests: [],
  };
  return { read: vi.fn(async () => structuredClone(read)), setRight: vi.fn(), setDefaults: vi.fn(), answer: vi.fn() } as unknown as PeersApi;
}

function respondApi(me: RespondMe): RespondApi {
  return {
    me: vi.fn(async () => me),
    signIn: vi.fn(),
    signOut: vi.fn(),
    ask: vi.fn(),
    answer: vi.fn(),
    message: vi.fn(),
    discard: vi.fn(),
  } as unknown as RespondApi;
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });

function page(opts: { traffic?: ReturnType<typeof fakeTraffic>; me?: RespondMe; peersFlag?: boolean; on?: boolean; more?: ReturnType<typeof makeSession>[] } = {}) {
  const traffic = opts.traffic ?? fakeTraffic();
  const sessions = [
    makeSession({ id: "s-dev", name: "claude-dashboard", status: "running", lastSeenAt: T0, owner: "Ed", machine: { name: "ed-mbp", id: "m1", os: "macOS 26.1" } }),
    makeSession({ id: "s-arm", name: "arm64-check", status: "waiting", waitReason: "input", lastSeenAt: T0, owner: "Ed", machine: { name: "build-pi", id: "m3", os: "Debian 12, arm64" } }),
    ...(opts.more ?? []),
  ];
  const state = stateFrom({ sessions, features: { "activity-feed": true, "peer-messaging": opts.peersFlag ?? true } });
  const view = render(<FleetView traffic={opts.on ?? true} state={state} respondApi={respondApi(opts.me ?? ED)} peersApi={peersApi()} trafficApi={traffic.api} />);
  return { traffic, ...view };
}

const line = (name: RegExp) => screen.getByRole("link", { name });
const panel = () => document.querySelector(".pm-conv") as HTMLElement;

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
  it("has Traffic after History while messaging is on, current on its own page", async () => {
    page();
    await flush();
    const traffic = screen.getByRole("link", { name: "Traffic" });
    expect(traffic).toHaveAttribute("href", "#/traffic");
    expect(traffic).toHaveAttribute("aria-current", "page");
    const history = screen.getByRole("link", { name: "History" });
    expect(history.compareDocumentPosition(traffic) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Traffic", { selector: ".pill" })).toBeInTheDocument();
  });

  it("shows the link on the fleet page, not as current, and not at all while messaging is off", async () => {
    page({ on: false });
    await flush();
    expect(screen.getByRole("link", { name: "Traffic" })).not.toHaveAttribute("aria-current");
    cleanup();
    page({ on: false, peersFlag: false });
    await flush();
    expect(screen.queryByRole("link", { name: "Traffic" })).toBeNull();
  });

  it("offers no Wall mode, and the wall's keys do nothing here", async () => {
    const { container } = page();
    await flush();
    expect(screen.queryByRole("button", { name: "Enter wall mode" })).toBeNull();
    fireEvent.keyDown(document, { key: "w" });
    expect(container.querySelector(".podium")).not.toHaveClass("wall-on");
  });

  it("goes back to the fleet from Fleet", async () => {
    window.location.hash = "#/traffic";
    page();
    await flush();
    fireEvent.click(screen.getByRole("link", { name: "Fleet" }));
    expect(window.location.hash).toBe("#/");
  });
});

describe("the map", () => {
  it("draws a box per machine with its system, and each orchestrator in it with its state", async () => {
    page();
    await flush();
    const map = screen.getByRole("group", { name: /Map of orchestrators/ });
    // The name drawn is the text after the title.
    const labels = [...map.querySelectorAll(".mlabel")].map((t) => t.lastChild!.textContent);
    // The busiest machine first, then by name, so a newer message never moves them.
    expect(labels).toEqual(["ed-mbp", "build-pi", "ci-runner-01"]);
    // The owner's read names the systems; a machine it does not know takes the live session's.
    expect([...map.querySelectorAll(".mos")].map((t) => t.textContent)).toEqual(["macOS 26.1", "Debian 12, arm64", "Ubuntu 24.04"]);
    const nodes = [...map.querySelectorAll(".node")];
    expect(nodes.map((n) => n.querySelector(".nm")!.lastChild!.textContent)).toEqual(["claude-dashboard", "infra-notes", "arm64-check", "Tester"]);
    expect(nodes[0]).toHaveClass("running");
    expect(nodes[0]!.querySelector(".si-running")).not.toBeNull();
    expect(nodes[2]).toHaveClass("waiting");
    // Not in the live fleet: ended, with the done shape.
    expect(nodes[1]!.querySelector(".st")!.textContent).toBe("Orchestrator, ended");
    expect(nodes[1]!.querySelector(".si-done")).not.toBeNull();
  });

  it("draws each conversation as a link with its count, state and arrows", async () => {
    page();
    await flush();
    const both = line(/^claude-dashboard and Tester, 5 messages, active/);
    expect(both.querySelector(".ln")).toHaveAttribute("marker-start");
    expect(both.querySelector(".ln")).toHaveAttribute("marker-end");
    expect(both.querySelector(".pill text")!.textContent).toBe("5 messages");
    expect(both.querySelector(".pill .ic")).toBeNull();
    const oneWay = line(/^claude-dashboard to arm64-check, 2 messages, a message waits for approval/);
    expect(oneWay).toHaveClass("waiting");
    expect(oneWay.querySelector(".ln")).not.toHaveAttribute("marker-start");
    expect(oneWay.querySelector(".ln")).toHaveAttribute("marker-end", "url(#pm-ah-waiting)");
    expect(oneWay.querySelector(".pill text")!.textContent).toBe("2 messages, waiting");
    expect(oneWay.querySelector(".pill .ic")).not.toBeNull();
    const paused = line(/^claude-dashboard and infra-notes, 3 messages, paused/);
    expect(paused).toHaveClass("paused");
    // More messages, a thicker line.
    expect(Number(both.querySelector(".ln")!.getAttribute("stroke-width"))).toBeGreaterThan(Number(paused.querySelector(".ln")!.getAttribute("stroke-width")));
  });

  it("has a legend, and names the machines it leaves out", async () => {
    page();
    await flush();
    const legend = document.querySelector(".pm-left .legend")!;
    expect(legend).toHaveTextContent("A message waits for approval");
    expect(legend).toHaveTextContent("An arrow at one end: only that way can send");
    expect(legend).toHaveTextContent("win-lab is not drawn: messaging is off on that machine");
  });

  it("selects a conversation by click and by Enter, and says so", async () => {
    page();
    await flush();
    expect(within(panel()).getByRole("heading", { level: 2 })).toHaveTextContent("claude-dashboard ⇄ and Tester");
    // The Admin's retention, in days, from the open read (#417).
    expect(within(panel()).getByText(/^Kept for 30 days after the last message\./)).toBeInTheDocument();
    expect(screen.getByText(/^Conversations are kept for 30 days after their last message/)).toBeInTheDocument();
    fireEvent.click(line(/^claude-dashboard to arm64-check/));
    await flush();
    expect(within(panel()).getByRole("heading", { level: 2 })).toHaveTextContent("claude-dashboard → to arm64-check");
    expect(line(/^claude-dashboard to arm64-check/)).toHaveAttribute("aria-current", "true");
    fireEvent.keyDown(line(/^infra-notes and Tester/), { key: "Enter" });
    await flush();
    expect(within(panel()).getByRole("heading", { level: 2 })).toHaveTextContent("infra-notes ⇄ and Tester");
    expect(screen.getByText("Showing the conversation between infra-notes and Tester.")).toBeInTheDocument();
    // Another key does nothing.
    fireEvent.keyDown(line(/^claude-dashboard and Tester/), { key: "a" });
    await flush();
    expect(within(panel()).getByRole("heading", { level: 2 })).toHaveTextContent("infra-notes ⇄ and Tester");
  });

  it("cuts long names with an ellipsis and keeps the full text as a title", async () => {
    const longDev = end("s-dev", "claude-dashboard-issue-347-peer-messaging", "ed-macbook-pro-16-inch-2026-home-office", "k1");
    page({ traffic: fakeTraffic([link(longDev, TESTER)]) });
    await flush();
    const map = screen.getByRole("group", { name: /Map of orchestrators/ });
    const box = [...map.querySelectorAll(".mlabel")].find((t) => t.querySelector("title")!.textContent!.startsWith("ed-"))!;
    expect(box.querySelector("title")!.textContent).toBe("ed-macbook-pro-16-inch-2026-home-office");
    expect(box.lastChild!.textContent).toBe("ed-macbook-pro-16-inch-2026-h…");
    const nm = [...map.querySelectorAll(".nm")].find((t) => t.querySelector("title")!.textContent!.startsWith("claude-"))!;
    expect(nm.querySelector("title")!.textContent).toBe("claude-dashboard-issue-347-peer-messaging");
    expect(nm.lastChild!.textContent).toBe("claude-dashboard-issue-…");
  });
});

describe("the conversation, for its owner", () => {
  it("shows the pair, their machines, the state, the round trips and the messages oldest first", async () => {
    const { traffic } = page();
    await flush();
    const p = panel();
    expect(within(p).getByText("ed-mbp and ci-runner-01")).toBeInTheDocument();
    expect(within(p).getByText("5 messages")).toBeInTheDocument();
    expect(within(p).getByText("Active")).toBeInTheDocument();
    expect(within(p).getByRole("img", { name: "2 of 10 round trips" })).toBeInTheDocument();
    expect(within(p).getByText(/2 of 10 round trips\. At 10, Ed approves the next message/)).toBeInTheDocument();
    expect(traffic.api.conversation).toHaveBeenCalledWith("s-dev", "s-tester");
    const feed = within(p).getByRole("list", { name: "Messages, oldest first" });
    const items = within(feed).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector(".who")!.textContent)).toEqual(["claude-dashboard to Tester", "Tester to claude-dashboard", "claude-dashboard to Tester"]);
    expect(items[0]).toHaveTextContent(/Delivered at \d\d:\d\d\./);
    expect(items[2]).toHaveTextContent("Waiting: Tester is working. It gets this when its turn ends.");
    expect(items[2]!.querySelector(".ds")).toHaveClass("wait");
  });

  it("draws a message's text as text, with [redacted] the only element in it", async () => {
    page();
    await flush();
    const item = within(panel()).getAllByRole("listitem")[1]!;
    const body = item.querySelector(".body")!;
    expect(body.querySelector("img")).toBeNull();
    expect(body.textContent).toContain('<img src=x onerror="alert(1)">');
    const elements = [...body.children].filter((c) => !c.classList.contains("who") && !c.classList.contains("ds"));
    expect(elements.map((e) => e.className)).toEqual(["rd", "rd"]);
  });

  it("says a one-way link's other side cannot answer, and where to change that", async () => {
    page();
    await flush();
    fireEvent.click(line(/^claude-dashboard to arm64-check/));
    await flush();
    const p = panel();
    expect(within(p).getByText("arm64-check cannot answer.")).toBeInTheDocument();
    expect(p).toHaveTextContent("build-pi cannot send to ed-mbp. Give it that right in My reporters if a reply is wanted.");
    expect(within(p).queryByRole("img", { name: /round trips/ })).toBeNull();
    const items = within(p).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent(/Delivered at \d\d:\d\d, after Ed approved it\./);
    expect(items[1]).toHaveTextContent("Waiting for Ed to approve it, in My reporters or in a session on build-pi.");
    expect(within(p).getByText("A message waits for approval")).toBeInTheDocument();
  });

  it("says why a message was dropped or declined, and that a held one waits for the link to resume", async () => {
    page();
    await flush();
    fireEvent.click(line(/^infra-notes and Tester/));
    await flush();
    expect(panel()).toHaveTextContent(/Dropped at \d\d:\d\d: the receiver ended first\. It was not delivered\./);
    fireEvent.click(line(/^claude-dashboard and infra-notes/));
    await flush();
    const p = panel();
    expect(p).toHaveTextContent("ed-mbp, same machine");
    expect(p).toHaveTextContent("Held: the link is paused. It goes when the link resumes.");
    expect(p).toHaveTextContent(/Declined at \d\d:\d\d\. It was not delivered\./);
    expect(within(p).getByRole("button", { name: "Resume link" })).toBeInTheDocument();
  });

  it("pauses and resumes the link through the owner's route", async () => {
    const { traffic } = page();
    await flush();
    fireEvent.click(within(panel()).getByRole("button", { name: "Pause link" }));
    await flush();
    expect(traffic.api.pause).toHaveBeenCalledWith("k1", "k2", true);
    expect(screen.getByText("Link paused.")).toBeInTheDocument();
    expect(within(panel()).getByText("Paused")).toBeInTheDocument();
    expect(panel()).toHaveTextContent("Held: the link is paused. It goes when the link resumes.");
    fireEvent.click(within(panel()).getByRole("button", { name: "Resume link" }));
    await flush();
    expect(traffic.api.pause).toHaveBeenLastCalledWith("k1", "k2", false);
    expect(screen.getByText("Link resumed.")).toBeInTheDocument();
  });

  it("says a failed pause failed, and that the link is unchanged", async () => {
    const traffic = fakeTraffic();
    traffic.api.pause.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    page({ traffic });
    await flush();
    fireEvent.click(within(panel()).getByRole("button", { name: "Pause link" }));
    await flush();
    expect(within(panel()).getByRole("alert")).toHaveTextContent("Could not pause the link: the server did not answer. The link is still active. Try again.");
    expect(within(panel()).getByRole("button", { name: "Pause link" })).toBeInTheDocument();
  });

  it("asks before Remove link, naming what goes, and removes the rights through the owner's route", async () => {
    const { traffic } = page();
    await flush();
    const ask = within(panel()).getByRole("button", { name: "Remove link…" });
    fireEvent.click(ask);
    const confirm = within(panel()).getByRole("group", { name: "Remove the link" });
    expect(ask).toHaveAttribute("aria-expanded", "true");
    expect(ask).toHaveAttribute("aria-controls", confirm.id);
    expect(confirm).toHaveTextContent("Remove the link between ed-mbp and ci-runner-01? Both directions lose every right, a message still waiting is dropped");
    expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Keep it" }));
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep it" }));
    expect(within(panel()).queryByRole("group", { name: "Remove the link" })).toBeNull();
    expect(document.activeElement).toBe(ask);
    expect(traffic.api.remove).not.toHaveBeenCalled();
    fireEvent.click(ask);
    fireEvent.click(within(panel()).getByRole("button", { name: "Remove link" }));
    await flush();
    expect(traffic.api.remove).toHaveBeenCalledWith("k1", "k2");
    expect(screen.getByText("Link removed. Neither machine can send to the other now.")).toBeInTheDocument();
    expect(panel()).toHaveTextContent("Neither can send now. ed-mbp and ci-runner-01 have no right to send to each other.");
  });

  it("names a link neither side can send on 'No right to send', in the header, the Table and the map, never Active", async () => {
    page();
    await flush();
    fireEvent.click(within(panel()).getByRole("button", { name: "Remove link…" }));
    fireEvent.click(within(panel()).getByRole("button", { name: "Remove link" }));
    await flush();
    const sub = panel().querySelector(".sub") as HTMLElement;
    expect(within(sub).getByText("No right to send")).toBeInTheDocument();
    expect(within(sub).queryByText("Active")).toBeNull();
    // The No access glyph from the rights, in the link-state tag, with no class of its own.
    expect(sub.querySelector(".pm-state svg path")).toHaveAttribute("d", "M4.2 11.8l7.6-7.6");
    const removed = line(/^claude-dashboard and Tester, 5 messages, no right to send\. Show the conversation$/);
    expect(removed).toHaveTextContent("5 messages, no right to send");
    expect(removed.querySelector(".ic")).not.toBeNull();
    // The stroke stays the active one.
    expect(removed).toHaveClass("edge", "active");
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "View" })).getByRole("radio", { name: "Table" }));
    await flush();
    const rows = within(screen.getByRole("region", { name: "Links" })).getAllByRole("row").slice(1);
    expect(rows[0]!.querySelectorAll("td")[4]).toHaveTextContent("No right to send");
    // A paused link keeps Paused, even once neither side can send.
    expect(rows[3]!.querySelectorAll("td")[4]).toHaveTextContent("Paused");
  });

  it("names the one machine when both ends share it, and says a failed removal changed nothing", async () => {
    const traffic = fakeTraffic();
    traffic.api.remove.mockRejectedValueOnce(new RespondError(403, { error: "not your reporter" }));
    page({ traffic });
    await flush();
    fireEvent.click(line(/^claude-dashboard and infra-notes/));
    await flush();
    fireEvent.click(within(panel()).getByRole("button", { name: "Remove link…" }));
    expect(within(panel()).getByRole("group", { name: "Remove the link" })).toHaveTextContent("Remove the link between the orchestrators on ed-mbp?");
    fireEvent.click(within(panel()).getByRole("button", { name: "Remove link" }));
    await flush();
    expect(within(panel()).getByRole("alert")).toHaveTextContent("Could not remove the link: not your reporter. Nothing changed. Try again.");
  });

  it("says the orchestrators on the one machine cannot message each other once a same-machine link is removed", async () => {
    page();
    await flush();
    fireEvent.click(line(/^claude-dashboard and infra-notes/));
    await flush();
    fireEvent.click(within(panel()).getByRole("button", { name: "Remove link…" }));
    fireEvent.click(within(panel()).getByRole("button", { name: "Remove link" }));
    await flush();
    expect(screen.getByText("Link removed. The orchestrators on ed-mbp cannot message each other now.")).toBeInTheDocument();
    expect(screen.queryByText("Link removed. Neither machine can send to the other now.")).toBeNull();
  });

  it("says when the conversation cannot be read, and tries again on the next read", async () => {
    const traffic = fakeTraffic();
    traffic.api.conversation.mockRejectedValueOnce(new TypeError("offline"));
    page({ traffic });
    await flush();
    expect(within(panel()).getByRole("alert")).toHaveTextContent("Could not load the conversation: the server did not answer. It tries again by itself every few seconds.");
    expect(within(panel()).getByText("No messages to show.")).toBeInTheDocument();
  });
});

describe("for anyone but the owner", () => {
  it("shows the map and the counts, and never asks for a signed-out browser's text", async () => {
    const { traffic } = page({ me: OUT });
    await flush();
    expect(line(/^claude-dashboard and Tester, 5 messages/)).toBeInTheDocument();
    const p = panel();
    expect(within(p).getByText("5 messages")).toBeInTheDocument();
    expect(p.querySelector(".offnote")).toHaveTextContent("Only Ed and an Admin can read this conversation.");
    expect(within(p).queryByRole("list")).toBeNull();
    expect(within(p).queryByRole("button", { name: "Pause link" })).toBeNull();
    fireEvent.click(line(/^claude-dashboard to arm64-check/));
    await flush();
    expect(traffic.api.conversation).not.toHaveBeenCalled();
  });

  it("names a machine's system from another live session on it, once the conversation's own sessions have ended", async () => {
    // The reporter key is the machine id, or `<machine id>#<owner>` for a second account on that machine.
    const OLD = end("s-old", "old-run", "lab-box", "m9");
    const GONE = end("s-gone", "gone-run", "ann-box", "m8#Ed");
    const traffic = fakeTraffic([link(OLD, GONE)]);
    const more = [
      makeSession({ id: "s-other", name: "other", status: "running", lastSeenAt: T0, owner: "Ed", machine: { name: "lab-box", id: "m9", os: "Fedora 41" } }),
      makeSession({ id: "s-ann", name: "ann", status: "running", lastSeenAt: T0, owner: "Ann", machine: { name: "ann-box", id: "m8", os: "FreeBSD 14" } }),
    ];
    page({ me: OUT, traffic, more });
    await flush();
    const map = screen.getByRole("group", { name: /Map of orchestrators/ });
    expect([...map.querySelectorAll(".mos")].map((t) => t.textContent)).toEqual(["FreeBSD 14", "Fedora 41"]);
  });

  it("lets an Admin read a person's conversation without pausing or removing it here", async () => {
    const { traffic } = page({ me: ANN_ADMIN });
    await flush();
    expect(traffic.api.conversation).toHaveBeenCalled();
    const p = panel();
    expect(within(p).getAllByRole("listitem")).toHaveLength(3);
    expect(within(p).queryByRole("button", { name: "Pause link" })).toBeNull();
    expect(p).toHaveTextContent("This is Ed's link. Only Ed can pause or remove it. An Admin can pause all of a reporter's links in Admin > Reporters.");
  });

  it("tells an Admin a message is held on a paused link that also has one waiting for approval", async () => {
    // The server's state reads `waiting` then, and `paused` says the rest; the Admin has no rights read of Ed's.
    page({ me: ANN_ADMIN, traffic: fakeTraffic([link(DEV, TESTER, { state: "waiting", paused: true })]) });
    await flush();
    expect(within(panel()).getAllByRole("listitem")[2]).toHaveTextContent("Held: the link is paused. It goes when the link resumes.");
  });

  it("shows the pause beside the waiting approval, in the conversation's header and in the Table", async () => {
    page({ me: ANN_ADMIN, traffic: fakeTraffic([link(DEV, TESTER, { state: "waiting", paused: true })]) });
    await flush();
    const sub = panel().querySelector(".sub") as HTMLElement;
    expect(within(sub).getByText("A message waits for approval")).toBeInTheDocument();
    expect(within(sub).getByText("Paused")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "View" })).getByRole("radio", { name: "Table" }));
    await flush();
    const row = within(screen.getByRole("region", { name: "Links" })).getAllByRole("row")[1]!;
    const state = row.querySelectorAll("td")[4]!;
    expect(state).toHaveTextContent("A message waits for approval Paused");
    expect(state.querySelectorAll(".pm-state.paused")).toHaveLength(1);
  });

  it("shows only the waiting approval while the link is not paused", async () => {
    page({ me: ANN_ADMIN, traffic: fakeTraffic([link(DEV, TESTER, { state: "waiting", paused: false })]) });
    await flush();
    const sub = panel().querySelector(".sub") as HTMLElement;
    expect(within(sub).getByText("A message waits for approval")).toBeInTheDocument();
    expect(within(sub).queryByText("Paused")).toBeNull();
  });

  it("shows the pause alone, never beside Active, when only `paused` says the link is paused", async () => {
    page({ me: ANN_ADMIN, traffic: fakeTraffic([link(DEV, TESTER, { state: "active", paused: true })]) });
    await flush();
    const sub = panel().querySelector(".sub") as HTMLElement;
    expect(within(sub).getByText("Paused")).toBeInTheDocument();
    expect(sub.querySelectorAll(".pm-state")).toHaveLength(1);
  });
});

describe("the open conversation", () => {
  it("stays on the one shown when another conversation gets a newer message", async () => {
    const traffic = fakeTraffic();
    page({ traffic });
    await flush();
    expect(within(panel()).getByRole("heading", { level: 2 })).toHaveTextContent("claude-dashboard ⇄ and Tester");
    // infra-notes and Tester gets the newest message, so the next read lists it first.
    const [devTester, devArm, notesTester, devNotes] = baseLinks();
    traffic.api.read.mockResolvedValue({ enabled: true, conversations: [{ ...notesTester!, lastAt: T0 }, devTester!, devArm!, devNotes!], retainDays: 30 });
    fireEvent.click(within(panel()).getByRole("button", { name: "Pause link" }));
    await flush();
    expect(traffic.api.read.mock.calls.length).toBeGreaterThan(1);
    expect(within(panel()).getByRole("heading", { level: 2 })).toHaveTextContent("claude-dashboard ⇄ and Tester");
  });

  it("keeps a read that started before a newer one from landing over it", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(T0);
    const traffic = fakeTraffic();
    page({ traffic });
    await flush();
    // An interval read starts and is slow; Pause link then reads again, and that newer read is the one that counts.
    let slow: (r: TrafficRead) => void = () => undefined;
    traffic.api.read.mockImplementationOnce(() => new Promise<TrafficRead>((resolve) => (slow = resolve)));
    act(() => vi.advanceTimersByTime(10_000));
    await flush();
    fireEvent.click(within(panel()).getByRole("button", { name: "Pause link" }));
    await flush();
    expect(within(panel()).getByRole("button", { name: "Resume link" })).toBeInTheDocument();
    slow({ enabled: true, conversations: baseLinks(), retainDays: 30 });
    await flush();
    expect(within(panel()).getByRole("button", { name: "Resume link" })).toBeInTheDocument();
  });
});

describe("the Table and Show", () => {
  it("counts Last message by the server's clock, not the browser's", async () => {
    const traffic = fakeTraffic();
    // The server is 3 minutes ahead of this browser.
    traffic.api.read.mockImplementation(async () => ({ enabled: true, conversations: baseLinks(), retainDays: 30, serverTime: T0 + 180_000 }));
    page({ traffic });
    await flush();
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "View" })).getByRole("radio", { name: "Table" }));
    await flush();
    const rows = within(screen.getByRole("region", { name: "Links" })).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("4 min ago");
  });

  it("lists the same links as text and selects one from its name", async () => {
    page();
    await flush();
    const view = screen.getByRole("radiogroup", { name: "View" });
    const map = within(view).getByRole("radio", { name: "Map" });
    map.focus();
    fireEvent.keyDown(map, { key: "ArrowRight" });
    await flush();
    expect(within(view).getByRole("radio", { name: "Table" })).toHaveAttribute("aria-checked", "true");
    const table = screen.getByRole("region", { name: "Links" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("claude-dashboard and Tester");
    expect(rows[0]).toHaveTextContent("2 of 10");
    expect(rows[0]).toHaveTextContent("1 min ago");
    expect(rows[1]).toHaveTextContent("claude-dashboard to arm64-check");
    expect(rows[1]).toHaveTextContent("n/a, one way");
    expect(rows[3]).toHaveTextContent("Paused");
    expect(screen.getByText("Showing 1 to 4 of 4")).toBeInTheDocument();
    fireEvent.click(within(rows[2]!).getByRole("button", { name: "infra-notes and Tester" }));
    await flush();
    expect(within(panel()).getByRole("heading", { level: 2 })).toHaveTextContent("infra-notes ⇄ and Tester");
  });

  it("opens on the Table on a narrow screen", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener: () => {}, removeEventListener: () => {} }));
    page();
    await flush();
    expect(screen.getByRole("radio", { name: "Table" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("region", { name: "Links" })).toBeInTheDocument();
  });

  it("reads again for the range Show picks, moving with the arrow keys", async () => {
    const { traffic } = page();
    await flush();
    expect(traffic.api.read).toHaveBeenLastCalledWith("live");
    const live = screen.getByRole("radio", { name: "Live sessions" });
    live.focus();
    fireEvent.keyDown(live, { key: "ArrowRight" });
    await flush();
    expect(traffic.api.read).toHaveBeenLastCalledWith("24h");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Last 24 hours" }));
    fireEvent.click(screen.getByRole("radio", { name: "Last 30 days" }));
    await flush();
    expect(traffic.api.read).toHaveBeenLastCalledWith("30d");
  });
});

describe("the empty, off and error cases", () => {
  it("says no orchestrator has messaged another yet, with a link to My reporters, and keeps Show", async () => {
    page({ traffic: fakeTraffic([]) });
    await flush();
    expect(screen.getByText("No orchestrator has messaged another yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open My reporters" })).toHaveAttribute("href", "#/me/reporters");
    expect(screen.getByRole("radiogroup", { name: "Show" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "What a line means" })).toBeNull();
  });

  it("says messaging is off, when the flag is off or the server says so", async () => {
    page({ peersFlag: false });
    await flush();
    expect(screen.getByText("Orchestrator messaging is off")).toBeInTheDocument();
    cleanup();
    const traffic = fakeTraffic();
    traffic.api.read.mockResolvedValue({ enabled: false, conversations: [] });
    page({ traffic });
    await flush();
    expect(screen.getByText("Orchestrator messaging is off")).toBeInTheDocument();
  });

  it("says when the traffic cannot be read, first and on a later read", async () => {
    const traffic = fakeTraffic();
    traffic.api.read.mockRejectedValueOnce(new RespondError(500, { error: "database locked" }));
    page({ traffic });
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load the traffic: database locked. It tries again by itself every few seconds.");
  });

  it("keeps the last read on screen when a later one fails", async () => {
    const traffic = fakeTraffic();
    page({ traffic });
    await flush();
    traffic.api.read.mockRejectedValueOnce(new TypeError("offline"));
    fireEvent.click(screen.getByRole("radio", { name: "Last 24 hours" }));
    await flush();
    expect(screen.getByText(/Could not read the traffic again: the server did not answer/)).toBeInTheDocument();
    expect(line(/^claude-dashboard and Tester/)).toBeInTheDocument();
  });

  it("names the people in the lead", async () => {
    page({ traffic: fakeTraffic([link(DEV, TESTER), link(ARM, NOTES, { owner: "Ann" })]) });
    await flush();
    expect(screen.getByText("Messages between each person's own orchestrators, on every machine that reports here.")).toBeInTheDocument();
    cleanup();
    page();
    await flush();
    expect(screen.getByText("Messages between Ed's orchestrators, on every machine that reports here.")).toBeInTheDocument();
  });
});
