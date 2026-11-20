// Chat (#1034, mockup/podium-chat.html): the sidebar, the thread, the box and its `@` combobox, the menus and their confirmations,
// what another person sees, and that the page reads again on the console's `chat` signal, against a fake server that keeps
// what it is told.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import axe from "axe-core";
import { render, screen, fireEvent, cleanup, act, within, waitFor } from "@testing-library/react";
import { FleetView } from "./FleetApp";
import { PAGE_INFO } from "./pageInfo";
import { makeSession } from "./fixtures";
import { stateFrom } from "./testState";
import { fleetReducer, LEAVE_MS } from "./store";
import { RespondError, type PeersApi, type RespondApi } from "./respondApi";
import type { Address, AdminRead, ChannelLink, DirectTarget, ChatApi, Cross, ChatOverview, ChannelMessage, DirectInfo, DirectMessage, DirectPageRead, GoneRead, Party } from "./chatData";
import type { RespondMe } from "./types";

const ED: RespondMe = { enabled: true, signedIn: true, name: "Ed", admin: false };
const OUT: RespondMe = { enabled: true, signedIn: false, name: null, admin: false };
const ROOT: RespondMe = { enabled: true, signedIn: true, name: "Admin", admin: true };
const T0 = new Date(2026, 9, 12, 14, 30).getTime();

const agent = (sessionId: string, name: string, machine = "ed-mbp", over: Partial<Party> = {}): Party => ({ sessionId, name, machine, reporterKey: `k-${machine}`, kind: "agent", live: true, status: "running", ...over });
const ME: Party = { sessionId: "person:ed", name: "Ed", machine: "", reporterKey: "", kind: "person", live: true, status: null };
const DASH = agent("s-dash", "claude-dashboard");
const TESTER = agent("s-tester", "Tester", "ci-runner-01", { status: "waiting" });
const NOTES = agent("s-notes", "infra-notes");

const direct = (a: Party, b: Party, over: Partial<DirectInfo> = {}): DirectInfo => ({
  thread: `dm:${a.sessionId}|${b.sessionId}`,
  a,
  b,
  owner: "Ed",
  messages: 6,
  lastAt: T0,
  state: "active",
  paused: false,
  canSend: { aToB: true, bToA: true },
  roundTrips: { used: 3, cap: 10 },
  ended: [],
  unread: 0,
  mentions: 0,
  hiddenAt: null,
  ...over,
});

const channelOf = (id: string, over: Partial<ChatOverview["channels"][number]> = {}): ChatOverview["channels"][number] => ({
  id,
  kind: id === "group" ? "group" : "public",
  name: id === "general" ? "General" : id === "group" ? "My group" : id,
  description: "",
  link: null,
  openedBy: null,
  thread: id === "general" ? "public" : id === "group" ? "group:ed" : `public:${id}`,
  unread: 0,
  mentions: 0,
  messages: 3,
  paused: false,
  pausedForEveryone: false,
  disconnected: false,
  can: id === "general" ? { pause: true, pauseEveryone: false, disconnect: true, removeAll: false, editDescription: false, removeChannel: false } : { pause: true, pauseEveryone: false, disconnect: true, removeAll: true, editDescription: false, removeChannel: false },
  ...over,
});

const cmsg = (id: string, text: string, over: Partial<ChannelMessage> = {}): ChannelMessage => ({
  id,
  authorKind: "person",
  authorName: "Ed",
  authorRef: "Ed",
  text,
  createdAt: T0 - 600_000,
  updatedAt: T0 - 600_000,
  replyTo: null,
  issue: null,
  project: null,
  milestone: null,
  mine: true,
  mentions: [],
  ...over,
});

const dmsg = (id: string, from: Party, to: Party, text: string, over: Partial<DirectMessage> = {}): DirectMessage => ({
  id,
  author: from.kind === "person" ? "person" : "agent",
  from: { kind: from.kind, sessionId: from.sessionId, name: from.name, machine: from.machine },
  to: [{ sessionId: to.sessionId, name: to.name, machine: to.machine, state: "delivered", why: null }],
  text,
  sentAt: T0 - 500_000,
  state: "delivered",
  stateAt: T0 - 490_000,
  why: null,
  approved: false,
  ...over,
});

const BOOK: Address[] = [
  { typed: "claude-dashboard@ed-mbp", label: "Orchestrator", role: "orchestrator", sessionId: "s-dash" },
  { typed: "Tester@ci-runner-01", label: "Orchestrator", role: "orchestrator", sessionId: "s-tester" },
  { typed: "Tester@build-pi", label: "Orchestrator", role: "orchestrator", sessionId: "s-tester2" },
  { typed: "My Agent@ed-mbp", label: "Orchestrator", role: "orchestrator", sessionId: "s-spaced" },
  { typed: "Maya@console", label: "Person", role: "person", sessionId: null },
  { typed: "group", label: "Everyone in My group", role: "group", sessionId: null, disabled: true, why: "Off. An Admin turns it on in Admin > Settings." },
  { typed: "everyone", label: "Everyone signed in", role: "everyone", sessionId: null, disabled: true, why: "Off. An Admin turns it on in Admin > Settings." },
];

interface Fake {
  overview: ChatOverview;
  channels: Record<string, { messages: ChannelMessage[]; older?: string | null }>;
  dms: Record<string, { messages: DirectMessage[]; older?: string | null; total?: number }>;
  postError?: RespondError | Error;
  /** What an Admin who picked a person is answered with, by that person's name. */
  owners?: Record<string, Partial<ChatOverview>>;
  /** What the thread reads answer as an Admin's record, by the thread's key. */
  reads?: Record<string, AdminRead[]>;
  /** Who the New direct message picker offers. */
  targets?: DirectTarget[];
}

function world(over: Partial<Fake> = {}): Fake {
  const d1 = direct(DASH, TESTER, { unread: 2 });
  const d2 = direct(ME, NOTES, { messages: 2, thread: "dm:person:ed|s-notes" });
  const d3 = direct(DASH, NOTES, { state: "paused", paused: true, messages: 1 });
  return {
    overview: {
      enabled: true,
      serverTime: T0,
      me: { name: "Ed", admin: false, person: true },
      settings: { maxChars: 20000, perMinute: 6, retainDays: 30, graceHours: 24, everyone: false },
      channels: [channelOf("general"), channelOf("group", { mentions: 1, messages: 2 })],
      directs: [d1, d2, d3],
      agents: [
        { sessionId: "s-dash", name: "claude-dashboard", machine: "ed-mbp", reporterKey: "k-ed-mbp", address: "claude-dashboard@ed-mbp", status: "running", waitReason: null, peers: true },
        { sessionId: "s-tester", name: "Tester", machine: "ci-runner-01", reporterKey: "k-ci-runner-01", address: "Tester@ci-runner-01", status: "waiting", waitReason: "input", peers: true },
        { sessionId: "s-notes", name: "infra-notes", machine: "ed-mbp", reporterKey: "k-ed-mbp", address: "infra-notes@ed-mbp", status: "waiting", waitReason: "permission", peers: true },
      ],
      people: [{ name: "Ed", you: true }, { name: "Maya", you: false }],
    },
    channels: {
      general: { messages: [cmsg("g1", "Heads up: staging restarts at 17:00.", { mine: false, authorName: "Maya", authorRef: "Maya" }), cmsg("g2", "Thanks.")] },
      group: {
        messages: [
          cmsg("q1", "run the tests @Tester@ci-runner-01", { mentions: [{ typed: "Tester@ci-runner-01", sessionId: "s-tester", state: "waiting", why: null, stateAt: T0 }] }),
          cmsg("q2", "On it.", { mine: false, authorKind: "orchestrator", authorName: "Tester", authorRef: "s-tester", replyTo: "q1" }),
          cmsg("q3", "hold this @claude-dashboard@ed-mbp", { mentions: [{ typed: "claude-dashboard@ed-mbp", sessionId: "s-dash", state: "held", why: "My group is paused", stateAt: T0 }] }),
        ],
      },
    },
    dms: {
      "s-dash|s-tester": {
        messages: [
          dmsg("m1", DASH, TESTER, "Please run the tests.\nReport each failure."),
          dmsg("m2", TESTER, DASH, '2 failed. <img src=x onerror="alert(1)"> The token is [redacted].'),
          dmsg("m3", ME, TESTER, "Also Debian 12.", { state: "queued" }),
        ],
        total: 6,
        older: "cur-1",
      },
      "person:ed|s-notes": { messages: [dmsg("n1", ME, NOTES, "Add the install steps.")], total: 2 },
      "s-dash|s-notes": { messages: [dmsg("p1", DASH, NOTES, "Here are the units.", { state: "ready" })], total: 1 },
    },
    ...over,
  };
}

/** A fake server that keeps what it is told, as the real one would. */
function fakeChat(w: Fake = world()) {
  const pageOf = (key: string, before: string | null): DirectPageRead => {
    const t = w.dms[key]!;
    const all = [...w.overview.directs, ...Object.values(w.owners ?? {}).flatMap((o) => o.directs ?? [])];
    const d = all.find((x) => [x.a.sessionId, x.b.sessionId].sort().join("|") === key.split("|").sort().join("|"))!;
    return {
      ok: true,
      thread: d.thread,
      a: d.a,
      b: d.b,
      messages: before ? [dmsg("old1", DASH, TESTER, "An older message.", { sentAt: T0 - 900_000 })] : structuredClone(t.messages),
      older: before ? null : (t.older ?? null),
      total: t.total ?? t.messages.length,
      ended: d.ended,
      owner: d.owner,
      paused: d.paused,
      roundTrips: d.roundTrips,
      cross: d.cross ?? null,
      pausedBy: d.pausedBy ?? null,
      pausedByAdmin: d.pausedByAdmin ?? null,
      ...(w.reads?.[key] ? { adminReads: structuredClone(w.reads[key]) } : {}),
    };
  };
  const api = {
    overview: vi.fn(async (owner?: string | null) => structuredClone(owner && w.owners?.[owner] ? { ...w.overview, ...w.owners[owner] } : w.overview)),
    markRead: vi.fn(async () => ({ ok: true as const, unread: 0, mentions: 0 })),
    addresses: vi.fn(async () => ({ ok: true as const, addresses: structuredClone(BOOK) })),
    channelMessages: vi.fn(async (channel: string) => {
      const c = w.channels[channel]!;
      return { ok: true as const, channel: channel as "general", messages: structuredClone(c.messages), older: c.older ?? null, total: c.messages.length, ...(w.reads?.[channel] ? { adminReads: structuredClone(w.reads[channel]) } : {}) };
    }),
    readingChannel: vi.fn(async (_channel: string, _owner: string) => ({ ok: true as const })),
    readingDm: vi.fn(async (_a: string, _b: string, _owner: string) => ({ ok: true as const })),
    post: vi.fn(async (channel: string, text: string) => {
      if (w.postError) throw w.postError;
      const m = cmsg(`new-${w.channels[channel]!.messages.length}`, text);
      w.channels[channel]!.messages.push(m);
      return { ok: true as const, message: m, warnings: [] as string[] };
    }),
    pause: vi.fn(async (channel: string, paused: boolean, everyone = false, _owner?: string | null) => {
      w.overview.channels = w.overview.channels.map((c) => (c.id === channel ? { ...c, paused, pausedForEveryone: everyone && paused } : c));
      return { ok: true as const };
    }),
    disconnect: vi.fn(async (channel: string, disconnected: boolean, _owner?: string | null) => {
      w.overview.channels = w.overview.channels.map((c) => (c.id === channel ? { ...c, disconnected } : c));
      return { ok: true as const };
    }),
    clear: vi.fn(async (channel: string, _owner?: string | null) => {
      w.channels[channel]!.messages = [];
      w.overview.channels = w.overview.channels.map((c) => (c.id === channel ? { ...c, messages: 0 } : c));
      return { ok: true as const };
    }),
    dmMessages: vi.fn(async (a: string, b: string, o: { before?: string | null } = {}) => {
      const key = [a === "me" ? "person:ed" : a, b].sort().join("|");
      const hit = Object.keys(w.dms).find((k) => k.split("|").sort().join("|") === key);
      const live = a === "me" ? w.overview.agents.find((x) => x.sessionId === b) : undefined;
      if (!hit && live) return { ok: true as const, thread: "dm:fresh", a: ME, b: agent(live.sessionId, live.name, live.machine), messages: [], older: null, total: 0, ended: [], owner: "Ed", paused: false, roundTrips: { used: 0, cap: 0 } };
      if (!hit) throw new RespondError(w.overview.me.person ? 404 : 403, { error: w.overview.me.person ? "There is no such conversation." : "Only its owner and an Admin can read a conversation." });
      return pageOf(hit, o.before ?? null);
    }),
    sendDm: vi.fn(async (_a: string, b: string, text: string) => {
      const m = dmsg(`sent-${text}`, ME, agent(b, "x"), text, { state: "queued" });
      return { ok: true as const, message: m, skipped: [] as { name: string; why: string }[], errors: [] as { name: string; error: string }[] };
    }),
    deleteDm: vi.fn(async (a: string, b: string) => {
      w.overview.directs = w.overview.directs.filter((d) => !(d.a.sessionId === a && d.b.sessionId === b));
      return { ok: true as const, removed: 1 };
    }),
    pauseLink: vi.fn(async (a: string, b: string, paused: boolean) => {
      w.overview.directs = w.overview.directs.map((d) => (d.a.reporterKey === a && d.b.reporterKey === b ? { ...d, paused, state: paused ? ("paused" as const) : ("active" as const) } : d));
      return { ok: true as const };
    }),
    link: vi.fn(async (a: string, b: string, op: "pause" | "resume" | "remove" | "allow") => {
      const link = ({ pause: "paused", resume: "open", remove: "removed", allow: "open" } as const)[op];
      w.overview.directs = w.overview.directs.map((d) => (d.a.sessionId === a && d.b.sessionId === b && d.cross ? { ...d, cross: { ...d.cross, link } } : d));
      return { ok: true as const, link };
    }),
    createChannel: vi.fn(async (name: string, description: string, link: ChannelLink | null) => {
      const c = channelOf(name, { description, link, openedBy: "Ed", messages: 0, can: { pause: true, pauseEveryone: false, disconnect: true, removeAll: false, editDescription: true, removeChannel: false } });
      w.overview.channels.splice(w.overview.channels.length - 1, 0, c);
      w.channels[name] = { messages: [] };
      return { ok: true as const, channel: c };
    }),
    describeChannel: vi.fn(async (channel: string, description: string) => {
      w.overview.channels = w.overview.channels.map((c) => (c.id === channel ? { ...c, description } : c));
      return { ok: true as const, channel: w.overview.channels.find((c) => c.id === channel)! };
    }),
    removeChannel: vi.fn(async (channel: string) => {
      w.overview.channels = w.overview.channels.filter((c) => c.id !== channel);
      return { ok: true as const, removed: 0 };
    }),
    directTargets: vi.fn(async (q = "") => ({ ok: true as const, targets: structuredClone(w.targets ?? []).filter((t) => `${t.name} ${t.owner}`.toLowerCase().includes(q.toLowerCase())) })),
    removeLink: vi.fn(async (a: string, b: string) => {
      w.overview.directs = w.overview.directs.map((d) => (d.a.reporterKey === a && d.b.reporterKey === b ? { ...d, canSend: { aToB: false, bToA: false } } : d));
      return { ok: true as const };
    }),
  } satisfies ChatApi;
  return { api, w };
}

function respondApi(me: RespondMe): RespondApi {
  return { me: vi.fn(async () => me), signIn: vi.fn(), signOut: vi.fn(), ask: vi.fn(), answer: vi.fn(), message: vi.fn(), discard: vi.fn() } as unknown as RespondApi;
}
const peersApi = () => ({ read: vi.fn(async () => ({ enabled: true, owner: "Ed", requests: [], reporters: [], rights: [], serverTime: T0, serverStartedAt: 0, defaults: { trust: false, onRequest: "ask", newSend: "ask", limits: {} }, limits: { server: {}, effective: {} } })), setRight: vi.fn(), setDefaults: vi.fn(), answer: vi.fn() }) as unknown as PeersApi;

const flush = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });

function page(opts: { chat?: ReturnType<typeof fakeChat>; me?: RespondMe; peersFlag?: boolean; sessions?: ReturnType<typeof makeSession>[] } = {}) {
  const chat = opts.chat ?? fakeChat();
  const sessions = [
    makeSession({ id: "s-dash", name: "claude-dashboard", status: "running", lastSeenAt: T0, owner: "Ed", machine: { name: "ed-mbp", id: "m1", os: "macOS 26.1" } }),
    makeSession({ id: "s-tester", name: "Tester", status: "waiting", waitReason: "input", lastSeenAt: T0, owner: "Ed", machine: { name: "ci-runner-01", id: "m2", os: "Ubuntu 24.04" } }),
    ...(opts.sessions ?? []),
  ];
  const state = stateFrom({ sessions, features: { "activity-feed": true, "peer-messaging": opts.peersFlag ?? true } });
  const props = { chat: true, respondApi: respondApi(opts.me ?? ED), peersApi: peersApi(), chatApi: chat.api };
  const view = render(<FleetView {...props} state={state} />);
  // Each signal moves the state on from the last one, so a second signal in a test is a new signal and not the same one again.
  let current = state;
  const signal = () => {
    current = fleetReducer(current, { type: "chat" });
    view.rerender(<FleetView {...props} state={current} />);
  };
  return { chat, state, signal, ...view };
}

const row = (key: string) => screen.getByTestId(`chat-row-${key}`);
const thread = () => screen.getByTestId("chat-thread");
const box = () => screen.getByTestId("chat-box") as HTMLTextAreaElement;
const options = () => within(screen.getByTestId("chat-listbox")).queryAllByRole("option");
const rowBtn = (key: string) => row(key).querySelector(".ch-row") as HTMLElement;
const open = async (key: string) => {
  fireEvent.click(rowBtn(key));
  await flush();
};

beforeEach(() => {
  localStorage.clear();
  window.location.hash = "#/chat";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ entries: [], since: T0, live: true, enabled: true, serverTime: T0 }) })));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the page", () => {
  it("names itself in the top bar's pill and leaves its own link off", async () => {
    page();
    await flush();
    expect(screen.getByText("Chat", { selector: ".pill" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Chat" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Chat" })).toBeInTheDocument();
  });

  // #1099: the rules left the bottom of the page for a modal that the (i) beside the title opens.
  it("keeps the rules out of the page and opens them from the (i) beside the title", async () => {
    page();
    await flush();
    const info = screen.getByRole("button", { name: "Chat privacy and controls" });
    expect(info).toHaveAttribute("aria-expanded", "false");
    // The (i) sits in the banner, beside the description, and the page body has no title or description of its own (#1209).
    expect(info.closest(".banner")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Chat" })).toHaveClass("vh");
    expect(document.querySelector(".apage .page-h")).toBeNull();
    expect(screen.queryByText(/A conversation with another person's agent is read by that person/)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(info);
    const dialog = screen.getByRole("dialog", { name: "About Chat" });
    expect(info).toHaveAttribute("aria-expanded", "true");
    expect(within(dialog).getByText(PAGE_INFO.chat.description)).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { level: 3, name: "Chat privacy and controls" })).toBeInTheDocument();
    for (const group of ["Who reads what", "How agents act", "Stopping a session", "Admins"]) expect(within(dialog).getByRole("heading", { level: 3, name: group })).toBeInTheDocument();
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(8);
    expect(within(dialog).getByText(/A conversation with another person's agent is read by that person, the agent's owner and an Admin/)).toBeInTheDocument();
    expect(within(dialog).getByText(/While an Admin reads, the person sees a red notice at the top of the thread/)).toBeInTheDocument();
  });

  it("closes the rules with the X, Esc or the dimmed area, and gives focus back to the (i)", async () => {
    page();
    await flush();
    const info = screen.getByRole("button", { name: "Chat privacy and controls" });
    fireEvent.click(info);
    fireEvent.click(screen.getByRole("button", { name: "Close (Esc)" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(info).toHaveFocus();
    expect(info).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(info);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(info).toHaveFocus();
    fireEvent.click(info);
    const scrim = document.querySelector(".scrim") as HTMLElement;
    fireEvent.mouseDown(scrim);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(info).toHaveFocus();
  });

  it("has no (i) while messaging is off or nobody is signed in", async () => {
    page({ peersFlag: false });
    await flush();
    expect(screen.queryByRole("button", { name: "Chat privacy and controls" })).toBeNull();
    cleanup();
    page({ me: OUT });
    await flush();
    expect(screen.queryByRole("button", { name: "Chat privacy and controls" })).toBeNull();
  });

  it("says messaging is off, and asks a signed-out browser to sign in without reading anything", async () => {
    const off = page({ peersFlag: false });
    await flush();
    expect(screen.getByText("Orchestrator messaging is off")).toBeInTheDocument();
    expect(off.chat.api.overview).not.toHaveBeenCalled();
    cleanup();
    const out = page({ me: OUT });
    await flush();
    expect(screen.getByText("Sign in to use Chat")).toBeInTheDocument();
    expect(out.chat.api.overview).not.toHaveBeenCalled();
  });

  it("says why when it cannot read, and tries again on a button", async () => {
    const chat = fakeChat();
    chat.api.overview.mockRejectedValueOnce(new RespondError(500, { error: "the store is busy" }));
    page({ chat });
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load Chat: the store is busy.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    expect(screen.getByRole("navigation", { name: "Chat" })).toBeInTheDocument();
  });
});

describe("the panes, as the Board has them", () => {
  const left = () => screen.getByRole("button", { name: /(Collapse|Expand) the left pane/ });
  const right = () => screen.getByRole("button", { name: /(Collapse|Expand) the right pane/ });

  it("keeps the orchestrator list and the Activity panel, collapsed at first, with their edge tabs beside the page", async () => {
    const { container } = page();
    await flush();
    const cols = container.querySelector<HTMLElement>(".cols")!;
    expect(cols).toContainElement(screen.getByTestId("chat-split"));
    expect(container.querySelector(".rail")).not.toBeNull();
    expect(container.querySelector(".side")).not.toBeNull();
    expect(left()).toHaveClass("edge-tab", "edge-tab-shut");
    expect(right()).toHaveClass("edge-tab", "edge-tab-shut");
    expect(cols.style.getPropertyValue("--rail-w")).toBe("24px");
    expect(cols.style.getPropertyValue("--side-w")).toBe("24px");
    // Chat has no legend and no wall mode of its own.
    expect(container.querySelector(".legend")).toBeNull();
    expect(screen.queryByRole("button", { name: "Enter wall mode" })).toBeNull();
  });

  it("remembers a pane the person opens for Chat only, and leaves the console's flags alone", async () => {
    page();
    await flush();
    fireEvent.click(left());
    expect(left()).not.toHaveClass("edge-tab-shut");
    expect(JSON.parse(localStorage.getItem("podium.collapsed.chat")!)).toEqual({ left: false, right: true, top: false });
    expect(localStorage.getItem("podium.collapsed")).toBeNull();
    expect(localStorage.getItem("podium.collapsed.board")).toBeNull();
    expect(localStorage.getItem("podium.collapsed.reporters")).toBeNull();
  });

  it("opens the list with [ and the Activity panel with ], and w does nothing", async () => {
    localStorage.setItem("podium.shortcuts", "true");
    page();
    await flush();
    fireEvent.keyDown(document, { key: "[" });
    expect(left()).not.toHaveClass("edge-tab-shut");
    fireEvent.keyDown(document, { key: "]" });
    expect(right()).not.toHaveClass("edge-tab-shut");
    fireEvent.keyDown(document, { key: "w" });
    expect(document.querySelector(".podium")).not.toHaveClass("wall-on");
  });
});

/** The words of each section title in the sidebar (a title is a fold button holding the words and a count, and may be followed by a "+"). */
const titles = (nav: { getAllByRole: (role: string) => HTMLElement[] }) => nav.getAllByRole("heading").map((h) => h.querySelector(".ch-fold > span")?.textContent ?? h.textContent);

describe("the sidebar", () => {
  it("lists Channels, Direct Messages with their tags and unread counts, and People and agents with state and role", async () => {
    page();
    await flush();
    const nav = within(screen.getByRole("navigation", { name: "Chat" }));
    expect(titles(nav)).toEqual(["Channels", "Direct Messages", "People and agents"]);
    expect(row("c:general")).toHaveTextContent("General");
    expect(row("c:group")).toHaveTextContent("My group");
    expect(within(row("c:group")).getByLabelText("1 mention of you")).toHaveTextContent("@ 1");
    expect(row("d:dm:s-dash|s-tester")).toHaveTextContent("claude-dashboard, Tester");
    expect(row("d:dm:s-dash|s-tester")).toHaveTextContent("Two agents, and you");
    expect(within(row("d:dm:s-dash|s-tester")).getByLabelText("2 new")).toBeInTheDocument();
    expect(row("d:dm:person:ed|s-notes")).toHaveTextContent("You and one agent");
    expect(row("d:dm:s-dash|s-notes")).toHaveTextContent("Paused");
    expect(row("a:s-tester")).toHaveTextContent("Orchestrator on ci-runner-01, waiting for you");
  });

  it("takes the state's color on hover and focus in People and agents, as the icon does", async () => {
    page();
    await flush();
    expect(row("a:s-dash")).toHaveClass("hl-running");
    expect(row("a:s-tester")).toHaveClass("hl-waiting");
    expect(row("a:s-dash").querySelector("svg.si-running")).not.toBeNull();
    expect(row("a:s-tester").querySelector("svg.si-waiting")).not.toBeNull();
  });

  it("opens an agent's conversation, or starts one when there is none", async () => {
    page();
    await flush();
    fireEvent.click(rowBtn("a:s-notes"));
    await flush();
    expect(within(thread()).getByRole("heading", { level: 2 })).toHaveTextContent("infra-notes");
    expect(within(thread()).getByText("Add the install steps.")).toBeInTheDocument();
  });

  it("starts a new conversation with an agent that has none, and sends to it through 'me'", async () => {
    const w = world();
    w.overview.directs = [];
    w.dms = {};
    w.dms["person:ed|s-dash"] = { messages: [] };
    w.overview.directs = [direct(ME, DASH, { messages: 0, thread: "dm:x" })];
    const chat = fakeChat(w);
    // Hide it from the list so the agent row starts a fresh one.
    chat.api.overview.mockImplementation(async () => ({ ...structuredClone(w.overview), directs: [] }));
    chat.api.dmMessages.mockImplementation(async () => ({ ok: true, thread: "dm:x", a: ME, b: DASH, messages: [], older: null, total: 0, ended: [], owner: "Ed", paused: false, roundTrips: { used: 0, cap: 0 } }));
    page({ chat });
    await flush();
    fireEvent.click(rowBtn("a:s-dash"));
    await flush();
    expect(chat.api.dmMessages).toHaveBeenCalledWith("me", "s-dash", expect.anything());
    expect(screen.getByText("Message claude-dashboard")).toBeInTheDocument();
    fireEvent.change(box(), { target: { value: "hello" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    await flush();
    expect(chat.api.sendDm).toHaveBeenCalledWith("me", "s-dash", "hello");
  });

  it("shows nothing for a person's own things to someone without a person, and says why", async () => {
    const w = world();
    w.overview.me = { name: "Root", admin: true, person: false };
    w.overview.channels = [channelOf("general", { can: { pause: false, pauseEveryone: true, disconnect: false, removeAll: true, editDescription: false, removeChannel: false } })];
    w.overview.directs = [];
    w.overview.agents = [];
    page({ chat: fakeChat(w), me: ROOT });
    await flush();
    const nav = within(screen.getByRole("navigation", { name: "Chat" }));
    expect(titles(nav)).toEqual(["Read as an Admin", "Channels"]);
    expect(nav.getByText(/belong to a person/)).toBeInTheDocument();
  });
});

describe("an agent that leaves People and agents (#1110)", () => {
  it("fades out with the wall's leave class for the wall's leave time, then goes, and does not offer its row while it does", async () => {
    const jest = vi.useFakeTimers({ toFake: ["Date", "setInterval", "setTimeout"] });
    jest.setSystemTime(T0);
    const p = page();
    await flush();
    expect(row("a:s-notes")).not.toHaveClass("leave");
    p.chat.w.overview.agents = p.chat.w.overview.agents.filter((a) => a.sessionId !== "s-notes");
    p.signal();
    await flush();
    expect(row("a:s-notes")).toHaveClass("leave");
    expect(row("a:s-dash")).not.toHaveClass("leave");
    expect(within(row("a:s-notes")).getAllByRole("button").every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(within(row("a:s-dash")).getAllByRole("button").some((b) => (b as HTMLButtonElement).disabled)).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(LEAVE_MS + 1);
    });
    expect(screen.queryByTestId("chat-row-a:s-notes")).toBeNull();
    expect(row("a:s-dash")).toBeInTheDocument();
  });

  it("keeps a row that came back before its animation ended", async () => {
    const jest = vi.useFakeTimers({ toFake: ["Date", "setInterval", "setTimeout"] });
    jest.setSystemTime(T0);
    const p = page();
    await flush();
    const notes = p.chat.w.overview.agents.find((a) => a.sessionId === "s-notes")!;
    p.chat.w.overview.agents = p.chat.w.overview.agents.filter((a) => a !== notes);
    p.signal();
    await flush();
    expect(row("a:s-notes")).toHaveClass("leave");
    p.chat.w.overview.agents = [...p.chat.w.overview.agents, notes];
    p.signal();
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(LEAVE_MS + 1);
    });
    expect(row("a:s-notes")).not.toHaveClass("leave");
  });
});

describe("a person who is not Ed", () => {
  it("sees General and nothing of Ed's, and a conversation they cannot read says who can", async () => {
    const w = world();
    w.overview.me = { name: "Maya", admin: false, person: true };
    w.overview.channels = [channelOf("general")];
    w.overview.directs = [];
    w.overview.agents = [];
    const chat = fakeChat(w);
    page({ chat, me: { ...ED, name: "Maya" } });
    await flush();
    const nav = within(screen.getByRole("navigation", { name: "Chat" }));
    expect(nav.queryByText("My group")).toBeNull();
    expect(nav.queryByText("claude-dashboard, Tester")).toBeNull();
    expect(within(thread()).getByRole("heading", { level: 2 })).toHaveTextContent("General");
  });

  it("explains an unreadable conversation: only its owner and an Admin can read it", async () => {
    const w = world();
    const chat = fakeChat(w);
    chat.api.dmMessages.mockRejectedValue(new RespondError(403, { error: "Only its owner and an Admin can read a conversation." }));
    page({ chat });
    await flush();
    await open("d:dm:s-dash|s-tester");
    expect(screen.getByTestId("chat-unreadable")).toHaveTextContent("Only the person who owns this conversation and an Admin can read it.");
  });
});

describe("the thread", () => {
  it("opens General first, with the audience line and the newest message last", async () => {
    page();
    await flush();
    const t = thread();
    expect(within(t).getByRole("heading", { level: 2 })).toHaveTextContent("General");
    expect(t).toHaveTextContent("Everyone signed in to this server can read and post here.");
    const items = within(t).getAllByTestId("chat-message");
    expect(items.map((li) => li.querySelector(".who")!.textContent)).toEqual(["Maya", "You"]);
    expect(within(items[1]!).getByText("Posted. No agent was addressed, so none will act on it.")).toBeInTheDocument();
    expect(within(items[0]!).getByText("Posted")).toBeInTheDocument();
  });

  it("shows a Direct Message with its people, delivery lines, a redaction marker, and text as text", async () => {
    page();
    await flush();
    await open("d:dm:s-dash|s-tester");
    const t = thread();
    expect(t).toHaveTextContent("Only you and an Admin can read this.");
    expect(t).toHaveTextContent("Agents addressing each other: 3 of 10 round trips.");
    // The two parties are named by avatars before the title, and a Direct Message has no stack or panel (#1236).
    expect(within(t).queryByLabelText("In this conversation")).toBeNull();
    expect(within(t).queryByRole("button", { name: /^Members,/ })).toBeNull();
    expect(t.querySelector(".ch-head h2 .ch-av-pair")).not.toBeNull();
    const msgs = within(t).getAllByTestId("chat-message");
    expect(within(msgs[0]!).getByText(/Delivered at \d\d:\d\d\./)).toBeInTheDocument();
    expect(within(msgs[1]!).getByText("[redacted]")).toHaveClass("rd");
    // The markup in a message is text: no element was made from it.
    expect(t.querySelector("img")).toBeNull();
    expect(msgs[1]!).toHaveTextContent('<img src=x onerror="alert(1)">');
    expect(within(msgs[2]!).getByText("Waiting: Tester is working. It gets this when its turn ends.")).toBeInTheDocument();
    expect(msgs[2]!).toHaveClass("mine");
  });

  it("shows a reply, each mention's state, and the server's reason for a held one, generically", async () => {
    page();
    await flush();
    await open("c:group");
    const msgs = within(thread()).getAllByTestId("chat-message");
    expect(msgs[1]!.querySelector(".who")).toHaveTextContent("Tester orchestrator on ci-runner-01 replying to you");
    expect(msgs[1]!).toHaveClass("reply");
    expect(within(msgs[0]!).getByText("Tester@ci-runner-01 waiting")).toBeInTheDocument();
    expect(within(msgs[0]!).getByText("Waiting: Tester gets this when its current turn ends.")).toBeInTheDocument();
    // The chip carries the state word; the reason is on the delivery line, once.
    expect(within(msgs[2]!).getByText("claude-dashboard@ed-mbp held")).toBeInTheDocument();
    expect(within(msgs[2]!).getByText("Held: My group is paused. It goes when the channel resumes.")).toBeInTheDocument();
    expect(msgs[2]!.textContent!.match(/My group is paused/g)).toHaveLength(1);
    expect(msgs[0]!.querySelector(".ch-mention")).toHaveTextContent("@Tester@ci-runner-01");
  });

  it("says Showing N of M and pages back with Earlier messages, in order, without moving the newest", async () => {
    const chat = fakeChat();
    page({ chat });
    await flush();
    await open("d:dm:s-dash|s-tester");
    expect(within(thread()).getAllByRole("status")[0]!).toHaveTextContent("Showing 3 of 6");
    fireEvent.click(within(thread()).getByRole("button", { name: "Earlier messages" }));
    await flush();
    expect(chat.api.dmMessages).toHaveBeenLastCalledWith("s-dash", "s-tester", { before: "cur-1", limit: 50 });
    expect(within(thread()).getAllByRole("status")[0]!).toHaveTextContent("Showing 4 of 6");
    expect(within(thread()).getAllByTestId("chat-message")[0]).toHaveTextContent("An older message.");
    expect(within(thread()).queryByRole("button", { name: "Earlier messages" })).toBeNull();
  });

  it("goes to the newest message on opening and after a send, and keeps its place otherwise", async () => {
    page();
    await flush();
    const body = () => thread().querySelector(".ch-body") as HTMLElement;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 900 });
    try {
      await open("c:group");
      expect(body().scrollTop).toBe(900);
      body().scrollTop = 120;
      fireEvent.scroll(body());
      // Opening a menu or reading again does not move it.
      fireEvent.click(within(row("c:group")).getByRole("button", { name: "Actions for My group" }));
      expect(body().scrollTop).toBe(120);
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      fireEvent.change(box(), { target: { value: "another" } });
      fireEvent.keyDown(box(), { key: "Enter" });
      await flush();
      expect(body().scrollTop).toBe(900);
    } finally {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
    }
  });

  it("moves the focus to the thread's heading when one is opened", async () => {
    page();
    await flush();
    await open("c:group");
    expect(document.activeElement).toBe(document.getElementById("th-h"));
  });

  it("marks the thread read up to its newest message when something was new", async () => {
    const chat = fakeChat();
    page({ chat });
    await flush();
    await open("d:dm:s-dash|s-tester");
    expect(chat.api.markRead).toHaveBeenCalledWith("dm:s-dash|s-tester", "m3");
  });
});

describe("two screens at 400 px", () => {
  it("opens the thread on a choice and goes back to the list", async () => {
    page();
    await flush();
    const split = screen.getByTestId("chat-split");
    expect(split).toHaveAttribute("data-pane", "side");
    await open("c:group");
    expect(split).toHaveAttribute("data-pane", "thread");
    fireEvent.click(screen.getByRole("button", { name: "Back to the list" }));
    expect(split).toHaveAttribute("data-pane", "side");
  });
});

describe("live", () => {
  it("reads the overview and the open thread again on the chat signal, once, and never on a timer", async () => {
    const jest = vi.useFakeTimers({ toFake: ["Date", "setInterval", "setTimeout"] });
    jest.setSystemTime(T0);
    const p = page();
    await flush();
    expect(p.chat.api.overview).toHaveBeenCalledTimes(1);
    expect(p.chat.api.channelMessages).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    await flush();
    expect(p.chat.api.overview).toHaveBeenCalledTimes(1);
    p.chat.w.channels.general!.messages.push(cmsg("g3", "A new one from Maya.", { mine: false, authorName: "Maya", authorRef: "Maya" }));
    p.signal();
    await flush();
    expect(p.chat.api.overview).toHaveBeenCalledTimes(2);
    expect(p.chat.api.channelMessages).toHaveBeenCalledTimes(2);
    expect(within(thread()).getByText("A new one from Maya.")).toBeInTheDocument();
  });
});

describe("the box", () => {
  it("sends on Enter, adds a line on Shift+Enter, and leaves a key that is choosing an IME character alone", async () => {
    const p = page();
    await flush();
    fireEvent.change(box(), { target: { value: "line one" } });
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(p.chat.api.post).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    expect(p.chat.api.post).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: "Enter" });
    await flush();
    expect(p.chat.api.post).toHaveBeenCalledWith("general", "line one");
    expect(box().value).toBe("");
    expect(within(thread()).getAllByTestId("chat-message")).toHaveLength(3);
  });

  it("sends nothing for an empty box", async () => {
    const p = page();
    await flush();
    fireEvent.keyDown(box(), { key: "Enter" });
    fireEvent.click(screen.getByTestId("chat-send"));
    expect(p.chat.api.post).not.toHaveBeenCalled();
  });

  it("keeps what was typed across a render and in each thread, and clears it only when sent", async () => {
    const p = page();
    await flush();
    fireEvent.change(box(), { target: { value: "half a thought" } });
    p.signal();
    await flush();
    expect(box().value).toBe("half a thought");
    await open("c:group");
    expect(box().value).toBe("");
    await open("c:general");
    expect(box().value).toBe("half a thought");
  });

  it("shows the server's own words for 429, 409 and 422, keeps the draft, and says what to try for anything else", async () => {
    const chat = fakeChat();
    page({ chat });
    await flush();
    fireEvent.change(box(), { target: { value: "x" } });
    for (const [status, error] of [
      [429, "You are sending too fast. Wait 12 seconds."],
      [409, "Tester has ended, so Podium did not queue the message."],
      [422, "@group and @everyone are off, so nothing was sent."],
    ] as const) {
      chat.w.postError = new RespondError(status, { error });
      fireEvent.keyDown(box(), { key: "Enter" });
      await flush();
      expect(screen.getByTestId("chat-send-error")).toHaveTextContent(new RegExp(`^${error.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
      expect(box().value).toBe("x");
    }
    chat.w.postError = new RespondError(500, { error: "the store is busy" });
    fireEvent.keyDown(box(), { key: "Enter" });
    await flush();
    expect(screen.getByTestId("chat-send-error")).toHaveTextContent("Could not send: the store is busy. Nothing was sent. Try again.");
    chat.w.postError = new Error("network");
    fireEvent.keyDown(box(), { key: "Enter" });
    await flush();
    expect(screen.getByTestId("chat-send-error")).toHaveTextContent("Could not send: the server did not answer. Nothing was sent. Try again.");
  });

  it("is off, with the reason, in a paused or disconnected channel and a paused or removed link", async () => {
    const w = world();
    w.overview.channels = [channelOf("general", { paused: true }), channelOf("group", { disconnected: true })];
    w.overview.directs = [direct(DASH, TESTER, { state: "paused", paused: true }), direct(DASH, NOTES, { canSend: { aToB: false, bToA: false } })];
    page({ chat: fakeChat(w) });
    await flush();
    expect(box()).toBeDisabled();
    expect(thread()).toHaveTextContent("Paused: messages are held. Resume from the menu to send.");
    expect(screen.getByTestId("chat-send")).toBeDisabled();
    await open("c:group");
    expect(box()).toBeDisabled();
    expect(thread()).toHaveTextContent("Your agents are disconnected from this channel. Reconnect them from its menu to send.");
    await open("d:dm:s-dash|s-tester");
    expect(box()).toBeDisabled();
    expect(thread()).toHaveTextContent("Paused: messages are held.");
    await open("d:dm:s-dash|s-notes");
    expect(box()).toBeDisabled();
    expect(thread()).toHaveTextContent("This link was removed, so nothing can be sent. Delete the conversation to clear it from the list.");
  });

  it("says why it is off in its placeholder and ties the reason to the box, and is not a combobox", async () => {
    const w = world();
    w.overview.channels = [channelOf("general", { paused: true }), channelOf("group")];
    page({ chat: fakeChat(w) });
    await flush();
    expect(box()).toBeDisabled();
    expect(box()).toHaveAttribute("placeholder", "Paused");
    const why = document.getElementById(box().getAttribute("aria-describedby")!.split(" ")[0]!)!;
    expect(why).toHaveTextContent("Paused: messages are held. Resume from the menu to send.");
    expect(box()).not.toHaveAttribute("role");
    await open("c:group");
    expect(box()).toHaveAttribute("placeholder", "Write a message. Type @ to address someone.");
    expect(box()).toHaveAttribute("aria-describedby");
  });

  it("is off when every agent of a conversation has ended, and says so", async () => {
    const w = world();
    w.overview.directs = [direct(DASH, TESTER, { ended: ["claude-dashboard", "Tester"] })];
    const chat = fakeChat(w);
    page({ chat });
    await flush();
    await open("d:dm:s-dash|s-tester");
    expect(box()).toBeDisabled();
    expect(thread()).toHaveTextContent("claude-dashboard and Tester have ended");
  });
});

describe("the @ combobox", () => {
  const type = (value: string) => {
    box().focus();
    fireEvent.change(box(), { target: { value, selectionStart: value.length } });
    box().setSelectionRange(value.length, value.length);
    fireEvent.change(box(), { target: { value } });
  };

  it("opens a listbox on @, backed by the server's addresses, and narrows as you type", async () => {
    const p = page();
    await flush();
    await open("c:group");
    type("hi @");
    await flush();
    expect(p.chat.api.addresses).toHaveBeenCalledWith("group");
    const list = screen.getByRole("listbox", { name: "People and agents" });
    expect(within(list).getAllByRole("option").map((o) => o.querySelector(".h")!.textContent)).toEqual([
      "@claude-dashboard@ed-mbp",
      "@Tester@ci-runner-01",
      "@Tester@build-pi",
      "@My Agent@ed-mbp",
      "@Maya@console",
      "@group",
      "@everyone",
    ]);
    expect(box()).toHaveAttribute("role", "combobox");
    expect(box()).toHaveAttribute("aria-expanded", "true");
    expect(box()).toHaveAttribute("aria-controls", list.id);
    expect(box().getAttribute("aria-activedescendant")).toBe(options()[0]!.id);
    expect(screen.getByTestId("chat-matches")).toHaveTextContent("7 people and agents. Use the arrow keys.");
    expect(screen.getByTestId("chat-matches")).toHaveAttribute("role", "status");
    type("hi @tes");
    expect(screen.getByTestId("chat-matches")).toHaveTextContent("2 people and agents. Use the arrow keys.");
    expect(within(list).getAllByRole("option").map((o) => o.querySelector(".h")!.textContent)).toEqual(["@Tester@ci-runner-01", "@Tester@build-pi"]);
    type("hi @my a");
    expect(within(list).getAllByRole("option").map((o) => o.querySelector(".h")!.textContent)).toEqual(["@My Agent@ed-mbp"]);
  });

  it("moves with the arrow keys, picks with Enter or Tab, and closes with Escape", async () => {
    const p = page();
    await flush();
    await open("c:group");
    type("@te");
    await flush();
        expect(options()[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    expect(box().getAttribute("aria-activedescendant")).toBe(options()[1]!.id);
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().value).toBe("@Tester@build-pi ");
    // Picking is not sending.
    expect(p.chat.api.post).not.toHaveBeenCalled();
    type("@te");
    fireEvent.keyDown(box(), { key: "Tab" });
    expect(box().value).toBe("@Tester@ci-runner-01 ");
    type("@te");
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(options()).toHaveLength(0);
    expect(screen.getByTestId("chat-matches")).toBeEmptyDOMElement();
    expect(box()).not.toHaveAttribute("aria-activedescendant");
  });

  it("loads the addresses again for the first @ after a send, so a flag an Admin turned on in between shows", async () => {
    const p = page();
    await flush();
    await open("c:group");
    type("@everyone stand up");
    await flush();
    expect(p.chat.api.addresses).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box(), { key: "Enter" });
    await flush();
    expect(box().value).toBe("");
    p.chat.api.addresses.mockClear();
    type("@");
    await flush();
    expect(p.chat.api.addresses).toHaveBeenCalledTimes(1);
  });

  it("lists @group and @everyone as off with the server's reason, and picking one does nothing", async () => {
    page();
    await flush();
    await open("c:group");
    type("@gr");
    await flush();
    const opt = options()[0]!;
    expect(opt).toHaveAttribute("aria-disabled", "true");
    expect(opt).toHaveTextContent("Off. An Admin turns it on in Admin > Settings.");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().value).toBe("@gr");
    fireEvent.mouseDown(opt);
    expect(box().value).toBe("@gr");
  });

  it("picks an agent whose name holds a space, and one of two agents with the same name at different places", async () => {
    page();
    await flush();
    await open("c:group");
    type("@my a");
    await flush();
    fireEvent.mouseDown(options()[0]!);
    expect(box().value).toBe("@My Agent@ed-mbp ");
    type("see @Tester@b");
    await flush();
    expect(options()).toHaveLength(1);
    fireEvent.mouseDown(options()[0]!);
    expect(box().value).toBe("see @Tester@build-pi ");
  });

  it("is not offered in a Direct Message, where @ means nothing", async () => {
    const p = page();
    await flush();
    await open("d:dm:s-dash|s-tester");
    type("@");
    await flush();
    expect(screen.queryByRole("listbox", { hidden: false })).toBeNull();
    expect(p.chat.api.addresses).not.toHaveBeenCalled();
  });
});

describe("the message box, its tools and its keys (#1233, mockup/podium-chat-redesign.html)", () => {
  const OWN = "d:dm:person:ed|s-notes";
  const type = (v: string) => fireEvent.change(box(), { target: { value: v } });
  const send = () => screen.getByTestId("chat-send");
  const commands = () => screen.queryByRole("listbox", { name: "Commands" });
  /** jsdom has no layout, so a textarea's content height is set by hand. */
  const contentHeight = (px: number) => Object.defineProperty(box(), "scrollHeight", { configurable: true, value: px });

  it("is one line with an accessible name and no visible label, and grows with its text up to 180 px", async () => {
    page();
    await flush();
    await open("c:group");
    expect(box()).toHaveAttribute("rows", "1");
    expect(screen.getByLabelText("Message My group")).toBe(box());
    expect(box().closest(".ch-composer")!.querySelector("label")).toHaveClass("vh");
    contentHeight(60);
    type("two\nlines");
    expect(box().style.height).toBe("60px");
    contentHeight(500);
    type("two\nlines\nand a long way more");
    expect(box().style.height).toBe("180px");
    contentHeight(0);
    type("x");
    expect(box().style.height).toBe("");
  });

  it("has Send as one icon button, named, muted until there is text, and off while a command has a problem", async () => {
    page();
    await flush();
    expect(send()).toHaveAccessibleName("Send message");
    expect(send()).toHaveClass("btn", "pri", "ch-send");
    expect(send()).toHaveTextContent("");
    expect(send()).toBeDisabled();
    type("   ");
    expect(send()).toBeDisabled();
    type("hello");
    expect(send()).toBeEnabled();
    await open(OWN);
    type("/x");
    expect(send()).toBeDisabled();
    type("/compact");
    expect(send()).toBeEnabled();
  });

  it("puts the hint beside Send in the tools row, after the tools", async () => {
    page();
    await flush();
    await open("c:group");
    const tools = box().closest(".ch-box")!.querySelector(".cr-tools")!;
    expect(tools).toHaveTextContent("Enter to send · Shift+Enter for a new line");
    expect([...tools.children].map((c) => c.className)).toEqual(["cr-tool", "hint", "btn pri ch-send"]);
  });

  it("sends on Enter, adds a line on Shift+Enter, and leaves Tab to move focus when no list is open", async () => {
    const p = page();
    await flush();
    await open("c:group");
    type("hello");
    expect(fireEvent.keyDown(box(), { key: "Enter", shiftKey: true })).toBe(true);
    expect(p.chat.api.post).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(box(), { key: "Tab" })).toBe(true);
    expect(box().value).toBe("hello");
    fireEvent.keyDown(box(), { key: "Enter" });
    await flush();
    expect(p.chat.api.post).toHaveBeenCalledWith("group", "hello");
  });

  it("offers the @ tool only in a channel, and the / tool only in a message to your own agent", async () => {
    page();
    await flush();
    await open("c:group");
    expect(screen.getByTestId("chat-tool-at")).toHaveAccessibleName("Mention someone");
    expect(screen.queryByTestId("chat-tool-slash")).toBeNull();
    await open(OWN);
    expect(screen.getByTestId("chat-tool-slash")).toHaveAccessibleName("Session commands");
    expect(screen.queryByTestId("chat-tool-at")).toBeNull();
    await open("d:dm:s-dash|s-tester");
    expect(screen.queryByTestId("chat-tool-at")).toBeNull();
    expect(screen.queryByTestId("chat-tool-slash")).toBeNull();
  });

  it("opens the @ list from the @ tool, after a space when the draft does not end in one, and keeps focus in the box", async () => {
    page();
    await flush();
    await open("c:group");
    fireEvent.click(screen.getByTestId("chat-tool-at"));
    await flush();
    expect(box().value).toBe("@");
    expect(options().length).toBeGreaterThan(0);
    expect(box()).toHaveFocus();
    fireEvent.keyDown(box(), { key: "Escape" });
    type("hi");
    fireEvent.click(screen.getByTestId("chat-tool-at"));
    expect(box().value).toBe("hi @");
    type("hi ");
    fireEvent.click(screen.getByTestId("chat-tool-at"));
    expect(box().value).toBe("hi @");
    expect(fireEvent.mouseDown(screen.getByTestId("chat-tool-at"))).toBe(false);
  });

  it("opens the command list from the / tool on an empty box, and does nothing to a box with a message in it", async () => {
    page();
    await flush();
    await open(OWN);
    fireEvent.click(screen.getByTestId("chat-tool-slash"));
    expect(box().value).toBe("/");
    expect(commands()).not.toBeNull();
    // The list is open, so the box is a combobox that names the option the arrow keys are on.
    expect(box()).toHaveAttribute("role", "combobox");
    expect(box()).toHaveAttribute("aria-expanded", "true");
    expect(box()).toHaveAttribute("aria-controls", commands()!.id);
    const options = within(commands()!).getAllByRole("option");
    expect(box().getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(box().getAttribute("aria-activedescendant")).toBe(options[1]!.id);
    fireEvent.click(screen.getByTestId("chat-tool-slash"));
    expect(box().value).toBe("/");
    type("a message");
    expect(screen.getByTestId("chat-tool-slash")).toBeDisabled();
    type("/cl");
    expect(screen.getByTestId("chat-tool-slash")).toBeEnabled();
    fireEvent.click(screen.getByTestId("chat-tool-slash"));
    expect(box()).toHaveFocus();
  });

  it("draws each @ entry with its avatar, its address in bold, its role and its state in a word, and Tab picks it", async () => {
    page();
    await flush();
    await open("c:group");
    type("@te");
    await flush();
    const first = options()[0]!;
    expect(first.querySelector(".ch-av.agent")).not.toBeNull();
    expect(first.querySelector("b.h")).toHaveTextContent("@Tester@ci-runner-01");
    expect(first.querySelector(".r")).toHaveTextContent("Orchestrator");
    expect(first.querySelector(".stw")).not.toBeNull();
    type("@ma");
    expect(options()[0]!.querySelector(".ch-av.person")).not.toBeNull();
    expect(options()[0]!.querySelector(".r")).toHaveTextContent("Person");
    expect(options()[0]!.querySelector(".stw")).toBeNull();
    type("@gr");
    expect(options()[0]!.querySelector(".ch-av.person svg")).not.toBeNull();
    type("@pod");
    await flush();
    type("hi @tes");
    fireEvent.keyDown(box(), { key: "Tab" });
    expect(box().value).toBe("hi @Tester@ci-runner-01 ");
  });

  it("does nothing on Tab or Enter for an entry that is off, and keeps the list open", async () => {
    page();
    await flush();
    await open("c:group");
    type("@every");
    await flush();
    expect(options()[0]).toHaveAttribute("aria-disabled", "true");
    expect(fireEvent.keyDown(box(), { key: "Tab" })).toBe(false);
    expect(box().value).toBe("@every");
    expect(options()).toHaveLength(1);
  });

  it("disables the box and its tools while it is off, and says why in the placeholder", async () => {
    const w = world();
    w.overview.channels = [channelOf("general"), channelOf("group", { paused: true })];
    page({ chat: fakeChat(w) });
    await flush();
    await open("c:group");
    expect(box()).toBeDisabled();
    expect(box()).toHaveAttribute("placeholder", "Paused");
    expect(screen.getByTestId("chat-tool-at")).toBeDisabled();
    expect(send()).toBeDisabled();
  });

  it("keeps a failed send's draft in the box and shows the server's words in a red box above it", async () => {
    const chat = fakeChat();
    page({ chat });
    await flush();
    type("keep me");
    chat.w.postError = new RespondError(429, { error: "You are sending too fast. Wait 12 seconds." });
    fireEvent.click(send());
    await flush();
    const err = screen.getByTestId("chat-send-error");
    expect(err).toHaveAttribute("role", "alert");
    expect(err).toHaveTextContent("You are sending too fast. Wait 12 seconds.");
    expect(box().value).toBe("keep me");
    expect(err.compareDocumentPosition(box()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(send()).toBeEnabled();
  });
});

describe("the menus", () => {
  const more = (name: string) => screen.getByRole("button", { name: `Actions for ${name}` });

  it("opens a Direct Message's menu from the button, with Pause link, Remove link and Delete conversation", async () => {
    page();
    await flush();
    fireEvent.click(more("claude-dashboard, Tester"));
    const menu = screen.getByRole("menu", { name: "Actions for claude-dashboard, Tester" });
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Pause link", "Remove link…", "Delete conversation…"]);
    expect(more("claude-dashboard, Tester")).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(within(menu).getAllByRole("menuitem")[0]);
  });

  it("opens the same menu on a right-click, and a one-agent conversation has no link to pause", async () => {
    page();
    await flush();
    fireEvent.contextMenu(row("d:dm:person:ed|s-notes"));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Delete conversation…"]);
  });

  it("moves with the arrow keys, closes on Escape, and puts the focus back on the button", async () => {
    page();
    await flush();
    fireEvent.click(more("claude-dashboard, Tester"));
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: "ArrowDown" });
    fireEvent.keyDown(items[2]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2]!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(document.activeElement).toBe(more("claude-dashboard, Tester"));
  });

  it("closes on a click elsewhere", async () => {
    page();
    await flush();
    fireEvent.click(more("General"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("pauses and resumes a link through the owner's route, by the two reporters' keys", async () => {
    const p = page();
    await flush();
    fireEvent.click(more("claude-dashboard, Tester"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pause link" }));
    await flush();
    expect(p.chat.api.pauseLink).toHaveBeenCalledWith("k-ed-mbp", "k-ci-runner-01", true);
    expect(row("d:dm:s-dash|s-tester")).toHaveTextContent("Paused");
    fireEvent.click(more("claude-dashboard, Tester"));
    expect(screen.getByRole("menuitem", { name: "Resume link" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Resume link" }));
    await flush();
    expect(p.chat.api.pauseLink).toHaveBeenLastCalledWith("k-ed-mbp", "k-ci-runner-01", false);
  });

  it("says in words what failed and what to try when Pause link is refused", async () => {
    const chat = fakeChat();
    chat.api.pauseLink.mockRejectedValueOnce(new RespondError(403, { error: "Only the owner can pause it." }));
    page({ chat });
    await flush();
    fireEvent.click(more("claude-dashboard, Tester"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pause link" }));
    await flush();
    expect(screen.getByTestId("chat-action-error")).toHaveTextContent("Could not pause the link: Only the owner can pause it. The link is still active. Try again.");
  });

  it("asks before it removes a link, above the scroll area, and removes it on the button", async () => {
    const p = page();
    await flush();
    fireEvent.click(more("claude-dashboard, Tester"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove link…" }));
    await flush();
    const dialog = screen.getByRole("alertdialog", { name: "Remove link" });
    expect(dialog).toHaveTextContent("Remove the link between claude-dashboard and Tester?");
    const alertZone = dialog.parentElement!;
    expect(alertZone).toHaveClass("ch-alert");
    const body = thread().querySelector(".ch-body")!;
    expect(alertZone.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Keep it" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(p.chat.api.removeLink).not.toHaveBeenCalled();
    fireEvent.click(more("claude-dashboard, Tester"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove link…" }));
    await flush();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove link" }));
    await flush();
    expect(p.chat.api.removeLink).toHaveBeenCalledWith("k-ed-mbp", "k-ci-runner-01");
    expect(row("d:dm:s-dash|s-tester")).toHaveTextContent("Link removed");
    expect(box()).toBeDisabled();
  });

  it("asks before it deletes a conversation, then deletes it and goes back to General", async () => {
    const p = page();
    await flush();
    fireEvent.click(within(row("d:dm:person:ed|s-notes")).getByRole("button", { name: "Actions for infra-notes" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete conversation…" }));
    await flush();
    const dialog = screen.getByRole("alertdialog", { name: "Delete conversation" });
    expect(dialog).toHaveTextContent("Delete the conversation infra-notes? Its 2 messages are removed for you and an Admin");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete conversation" }));
    await flush();
    expect(p.chat.api.deleteDm).toHaveBeenCalledWith("person:ed", "s-notes");
    expect(screen.queryByTestId("chat-row-d:s-notes")).toBeNull();
    expect(within(thread()).getByRole("heading", { level: 2 })).toHaveTextContent("General");
  });

  it("gives My group Pause, Disconnect and Remove all messages, and General only what the viewer may", async () => {
    const p = page();
    await flush();
    fireEvent.click(more("My group"));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Pause every agent in the group", "Disconnect every agent in the group", "Remove all messages…"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pause every agent in the group" }));
    await flush();
    expect(p.chat.api.pause).toHaveBeenCalledWith("group", true);
    expect(row("c:group")).toHaveTextContent("Paused");
    fireEvent.click(more("My group"));
    expect(screen.getByRole("menuitem", { name: "Resume every agent in the group" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Disconnect every agent in the group" }));
    await flush();
    expect(p.chat.api.disconnect).toHaveBeenCalledWith("group", true);
    expect(row("c:group")).toHaveTextContent("Your agents are disconnected");
    fireEvent.click(more("General"));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Pause my agents in General", "Disconnect my agents in General"]);
    expect(menu).toHaveTextContent("Only an Admin can pause General for everyone or remove its messages.");
  });

  it("gives an Admin General's pause for everyone and Remove all messages, and asks before removing", async () => {
    const w = world();
    w.overview.me = { name: "Root", admin: true, person: false };
    w.overview.channels = [channelOf("general", { can: { pause: false, pauseEveryone: true, disconnect: false, removeAll: true, editDescription: false, removeChannel: false } })];
    w.overview.directs = [];
    w.overview.agents = [];
    const chat = fakeChat(w);
    page({ chat, me: ROOT });
    await flush();
    fireEvent.click(more("General"));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Pause General for everyone", "Remove all messages…"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pause General for everyone" }));
    await flush();
    expect(chat.api.pause).toHaveBeenCalledWith("general", true, true);
    expect(row("c:general")).toHaveTextContent("Paused for everyone");
    fireEvent.click(more("General"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove all messages…" }));
    await flush();
    const dialog = screen.getByRole("alertdialog", { name: "Remove all messages" });
    expect(dialog).toHaveTextContent("Remove all 3 messages in General? Everyone loses the history, and it cannot be recovered.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove all messages" }));
    await flush();
    expect(chat.api.clear).toHaveBeenCalledWith("general");
    expect(within(thread()).queryAllByTestId("chat-message")).toHaveLength(0);
  });

  it("shows a menu with only a reason as a note that takes the focus and closes on Escape", async () => {
    const w = world();
    w.overview.channels = [channelOf("general", { can: { pause: false, pauseEveryone: false, disconnect: false, removeAll: false, editDescription: false, removeChannel: false } }), channelOf("group")];
    page({ chat: fakeChat(w) });
    await flush();
    fireEvent.click(more("General"));
    expect(screen.queryByRole("menu")).toBeNull();
    const note = screen.getByRole("note", { name: "Actions for General" });
    expect(note).toHaveTextContent("Only an Admin can pause General for everyone or remove its messages.");
    expect(document.activeElement).toBe(note);
    fireEvent.keyDown(note, { key: "Escape" });
    expect(screen.queryByRole("note")).toBeNull();
    await flush();
    await new Promise((r) => setTimeout(r, 200));
    expect(document.activeElement).toBe(more("General"));
  });

  it("gives an agent Message and Open orchestration page, which goes to the console with it open", async () => {
    page();
    await flush();
    fireEvent.click(more("Tester"));
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Message Tester", "Mention Tester", "Open orchestration page"]);
    expect(items[2]).toHaveAttribute("href", "#/?open=s-tester");
    fireEvent.click(items[0]!);
    await flush();
    expect(within(thread()).getByRole("heading", { level: 2 })).toHaveTextContent("Tester");
  });

  it("lists you and your orchestrators behind the stack in My group, and an orchestrator's row has Message, Mention and the orchestration page (#1236, #1235)", async () => {
    page();
    await flush();
    await open("c:group");
    const stack = within(thread()).getByRole("button", { name: /^Members, \d+\. Show the list$/ });
    expect(screen.queryByTestId("chat-members")).toBeNull();
    fireEvent.click(stack);
    const panel = screen.getByTestId("chat-members");
    expect(within(panel).getByRole("heading", { name: /^People 1$/ })).toBeInTheDocument();
    expect(within(panel).getByText("Ed").closest("b")).toHaveTextContent("Ed (you)");
    fireEvent.click(within(panel).getByRole("button", { name: "Actions for claude-dashboard" }));
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Message claude-dashboard", "Mention claude-dashboard", "Open orchestration page"]);
    expect(items[2]).toHaveAttribute("href", "#/?open=s-dash");
  });

  it("closes the members panel from its own button, and Message on a person in a channel opens New direct message with their name searched (#1236)", async () => {
    page();
    await flush();
    await open("c:general");
    fireEvent.click(within(thread()).getByRole("button", { name: /Show the list$/ }));
    fireEvent.click(within(screen.getByTestId("chat-members")).getByRole("button", { name: "Close members" }));
    expect(screen.queryByTestId("chat-members")).toBeNull();
    fireEvent.click(within(thread()).getByRole("button", { name: /Show the list$/ }));
    fireEvent.click(within(screen.getByTestId("chat-members")).getByRole("button", { name: "Actions for Maya" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Message Maya" }));
    await flush();
    expect(screen.getByTestId("dm-form")).toBeInTheDocument();
  });

  it("keeps the members panel closed when a conversation opens, and closes it when another one does (#1236)", async () => {
    page();
    await flush();
    await open("c:group");
    fireEvent.click(within(thread()).getByRole("button", { name: /Show the list$/ }));
    expect(screen.getByTestId("chat-split")).toHaveClass("mem-open");
    await open("c:general");
    expect(screen.queryByTestId("chat-members")).toBeNull();
    expect(screen.getByTestId("chat-split")).not.toHaveClass("mem-open");
    expect(within(thread()).getByRole("button", { name: /Show the list$/ })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("accessibility", () => {
  it("passes the axe rules jsdom can judge, with a thread open and with a menu and the listbox open", async () => {
    vi.useRealTimers();
    const { container } = page();
    await flush();
    await open("d:dm:s-dash|s-tester");
    fireEvent.click(screen.getByRole("button", { name: "Actions for claude-dashboard, Tester" }));
    // The box is a textarea that carries role=combobox while its @ or / list is open (the spec's "a combobox", #1233), which axe's
    // `aria-allowed-role` does not list for a textarea; it is judged off only for the pass that has the list open.
    const run = async (listOpen = false) => {
      const r = await axe.run(container, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
        rules: { "aria-allowed-role": { enabled: !listOpen }, "color-contrast": { enabled: false }, "target-size": { enabled: false }, "scrollable-region-focusable": { enabled: false }, "link-in-text-block": { enabled: false }, region: { enabled: false } },
      });
      return { violations: r.violations };
    };
    expect((await run()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await open("c:group");
    fireEvent.change(box(), { target: { value: "@te" } });
    await flush();
    expect((await run(true)).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    // The members panel, open beside the thread with a row's menu open (#1236).
    fireEvent.change(box(), { target: { value: "" } });
    fireEvent.click(within(thread()).getByRole("button", { name: /Show the list$/ }));
    fireEvent.click(within(screen.getByTestId("chat-members")).getByRole("button", { name: "Actions for claude-dashboard" }));
    expect((await run()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  });
});

// ---- A conversation across owners (#1034) -------------------------------------------------------------------------------

const MAYA: Party = { sessionId: "person:maya", name: "Maya", machine: "", reporterKey: "", kind: "person", live: true, status: null };

/** Ed's `claude-dashboard` and Maya, as the server lists it for Ed (the owner) or for Maya (the sender). */
function crossWorld(viewer: "owner" | "sender" | "admin", cross: Partial<Cross> = {}, over: Partial<DirectInfo> = {}) {
  const w = world();
  const c: Cross = { person: "Maya", owner: "Ed", link: "open", viewerIs: viewer, ...cross };
  const d = direct(MAYA, DASH, { thread: "dm:person:maya|s-dash", owner: "Ed", messages: 3, cross: c, state: c.link === "waiting" ? "waiting" : "active", ...over });
  w.overview.directs = [d];
  if (viewer === "sender") w.overview.me = { name: "Maya", admin: false, person: true };
  w.dms = {
    "person:maya|s-dash": {
      messages: [
        dmsg("x1", MAYA, DASH, "Can you check the build?", { state: "approval", waitingFor: "Ed", to: [{ sessionId: "s-dash", name: "claude-dashboard", machine: "ed-mbp", state: "approval", why: null }] }),
        dmsg("x2", MAYA, DASH, "Also the lint.", { state: "declined", reason: "Ed declined it." }),
        dmsg("x3", MAYA, DASH, "And the docs.", { state: "dropped", why: "link-removed", reason: "Ed removed the link." }),
      ],
    },
  };
  return fakeChat(w);
}

describe("commands in a message to your own agent (#1051, mockup/podium-chat-security.html)", () => {
  const OWN = "d:dm:person:ed|s-notes";
  const type = (v: string) => fireEvent.change(box(), { target: { value: v } });
  const commands = () => screen.queryByRole("listbox", { name: "Commands" });
  const names = () => within(commands()!).getAllByRole("option").map((o) => o.querySelector(".cn")!.textContent);
  const opencode = () => makeSession({ id: "s-notes", name: "infra-notes", status: "running", lastSeenAt: T0, owner: "Ed", machine: { name: "ed-mbp", id: "m1", os: "macOS 26.1" }, capabilities: { context: false, effort: false, commands: ["compact"] } });

  it("lists /clear and /compact on a slash, with the footer, and chooses with the arrow keys and Tab", async () => {
    page();
    await flush();
    await open(OWN);
    expect(commands()).toBeNull();
    type("/");
    expect(names()).toEqual(["/clear", "/compact"]);
    expect(commands()).toHaveTextContent("Other commands run only in the terminal.");
    expect(box()).toHaveAttribute("role", "combobox");
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "Tab" });
    expect(box().value).toBe("/compact");
    expect(commands()).toBeNull();
  });

  it("lists only what the session's reporter declared (OpenCode: /compact)", async () => {
    page({ sessions: [opencode()] });
    await flush();
    await open(OWN);
    type("/");
    expect(names()).toEqual(["/compact"]);
    type("/clear");
    expect(box().closest(".ch-composer")).toHaveTextContent("/clear runs only in the terminal. From here you can send /compact.");
    expect(screen.getByTestId("chat-send")).toBeDisabled();
  });

  it("asks before /clear, in the Activity window's words, and sends nothing on Cancel", async () => {
    const p = page();
    await flush();
    await open(OWN);
    type("/clear");
    fireEvent.keyDown(box(), { key: "Enter" });
    await flush();
    const ask = screen.getByRole("alertdialog", { name: "Clear the conversation?" });
    expect(ask).toHaveTextContent("infra-notes starts over with an empty context. Podium shows the cleared part as its own session in History, linked to this one.");
    expect(p.chat.api.sendDm).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog", { name: "Clear the conversation?" })).toBeNull();
    fireEvent.click(screen.getByTestId("chat-send"));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Clear the conversation?" })).getByRole("button", { name: "Clear conversation" }));
    await flush();
    expect(p.chat.api.sendDm).toHaveBeenCalledTimes(1);
    expect(p.chat.api.sendDm).toHaveBeenCalledWith("person:ed", "s-notes", "/clear");
    expect(box().value).toBe("");
  });

  it("sends /compact at once", async () => {
    const p = page();
    await flush();
    await open(OWN);
    type("/compact");
    fireEvent.keyDown(box(), { key: "Enter" });
    await flush();
    expect(p.chat.api.sendDm).toHaveBeenCalledWith("person:ed", "s-notes", "/compact");
    expect(screen.queryByRole("alertdialog", { name: "Clear the conversation?" })).toBeNull();
  });

  it("does not send an unknown command, and says it runs in the terminal", async () => {
    const p = page();
    await flush();
    await open(OWN);
    type("/x");
    expect(box().closest(".ch-composer")).toHaveTextContent("/x runs only in the terminal. From here you can send /clear and /compact.");
    fireEvent.keyDown(box(), { key: "Enter" });
    await flush();
    expect(p.chat.api.sendDm).not.toHaveBeenCalled();
  });

  it("offers nothing in General, in My group, in a conversation of two agents, or with another person's agent", async () => {
    page();
    await flush();
    type("/");
    expect(commands()).toBeNull();
    await open("c:group");
    type("/");
    expect(commands()).toBeNull();
    await open("d:dm:s-dash|s-tester");
    type("/");
    expect(commands()).toBeNull();
    cleanup();
    page({ chat: crossWorld("sender", { link: "open" }) });
    await flush();
    await open("d:dm:person:maya|s-dash");
    type("/");
    expect(commands()).toBeNull();
  });
});

describe("General says what wrote each message (#1051, mockup/podium-chat-security.html)", () => {
  const generalWith = (messages: ChannelMessage[]) => {
    const w = world();
    w.channels.general = { messages };
    return fakeChat(w);
  };
  const orch = (id: string, name: string, ref: string, text: string) => cmsg(id, text, { mine: false, authorKind: "orchestrator", authorName: name, authorRef: ref });
  const msgs = () => within(thread()).getAllByTestId("chat-message");

  it("marks an orchestrator's message with where it runs, and a person's with nothing", async () => {
    page({ chat: generalWith([cmsg("p1", "Anyone seen the build go red?", { mine: false, authorName: "Maya", authorRef: "Maya" }), orch("a1", "Tester", "s-tester", "Build 4412 failed.")]) });
    await flush();
    const [person, agent] = msgs();
    expect(person!.querySelector(".chip")).toBeNull();
    const chip = agent!.querySelector(".who .chip:not(.warn)")!;
    expect(chip).toHaveTextContent("orchestrator on ci-runner-01");
    expect(chip).toHaveAttribute("title", "Written by an orchestrator, not a person");
    expect(agent!.querySelector(".who bdi")).toHaveTextContent("Tester");
    expect(agent!.querySelector(".chip.warn")).toBeNull();
  });

  it("marks a name that is a person's, and one that says it is an Admin, with a warning", async () => {
    page({ chat: generalWith([orch("a2", "maya", "s-gone", "I approved the release."), orch("a3", "Root (AN ADMIN)", "s-gone", "Remove your link now.")]) });
    await flush();
    const [same, admin] = msgs();
    const warn1 = same!.querySelector(".chip.warn")!;
    expect(warn1).toHaveTextContent("Same name as a person");
    expect(warn1).toHaveAttribute("title", "This orchestrator's name is the name of a person on this server.");
    expect(warn1.querySelector("svg")).not.toBeNull();
    expect(same!.querySelector(".who .chip:not(.warn)")).toHaveTextContent(/^orchestrator$/);
    const warn2 = admin!.querySelector(".chip.warn")!;
    expect(warn2).toHaveTextContent("Name says Admin");
    expect(warn2).toHaveAttribute("title", "This orchestrator's name says it is an Admin. Only a person signed in as an Admin is one.");
    expect(admin!.querySelectorAll(".chip.warn")).toHaveLength(1);
  });

  it("draws names in bdi in the sidebar and the thread header", async () => {
    page();
    await flush();
    expect(row("a:s-tester").querySelector(".nm bdi")).toHaveTextContent("Tester");
    expect(row("d:dm:s-dash|s-tester").querySelector(".nm bdi")).not.toBeNull();
  });
});

describe("rows are keyed by the server's thread (#1051)", () => {
  it("keeps the viewer's own conversation and another person's with the same agent apart, and a menu acts on the one clicked", async () => {
    const w = world();
    const own = direct(ME, DASH, { thread: "dm:person:ed|s-dash", messages: 1 });
    const theirs = direct(MAYA, DASH, { thread: "dm:person:maya|s-dash", messages: 1, cross: { person: "Maya", owner: "Ed", link: "open", viewerIs: "owner" } });
    w.overview.directs = [own, theirs];
    w.dms = {
      "person:ed|s-dash": { messages: [dmsg("o1", ME, DASH, "Mine.")], total: 1 },
      "person:maya|s-dash": { messages: [dmsg("t1", MAYA, DASH, "Hers.")], total: 1 },
    };
    const chat = fakeChat(w);
    page({ chat });
    await flush();
    expect(row("d:dm:person:ed|s-dash")).toHaveTextContent("You and one agent");
    expect(row("d:dm:person:maya|s-dash")).toHaveTextContent("Maya and your agent");
    fireEvent.click(within(row("d:dm:person:maya|s-dash")).getByRole("button", { name: /^Actions for/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete conversation…" }));
    await flush();
    expect(thread()).toHaveTextContent("Hers.");
    fireEvent.click(within(screen.getByTestId("chat-confirm")).getByRole("button", { name: "Delete conversation" }));
    await flush();
    expect(chat.api.deleteDm).toHaveBeenCalledWith("person:maya", "s-dash");
    expect(chat.api.deleteDm).toHaveBeenCalledTimes(1);
    expect(row("d:dm:person:ed|s-dash")).toBeInTheDocument();
  });
});

describe("a conversation across owners", () => {
  const more = (name: string) => screen.getByRole("button", { name: `Actions for ${name}` });
  const items = () => within(screen.getByRole("menu")).getAllByRole("menuitem");

  it("says who the two people are and who may read, and the state of each message in words with the server's reason", async () => {
    page({ chat: crossWorld("owner") });
    await flush();
    await open("d:dm:person:maya|s-dash");
    expect(thread()).toHaveTextContent("Maya (a person using Chat) writes to Ed's agent claude-dashboard. Only Maya, Ed and an Admin can read this.");
    const msgs = within(thread()).getAllByTestId("chat-message");
    expect(msgs[0]).toHaveTextContent("Waiting for Ed to approve it.");
    expect(msgs[1]).toHaveTextContent("Declined at");
    expect(msgs[1]).toHaveTextContent("Ed declined it.");
    expect(msgs[2]).toHaveTextContent("Dropped at");
    expect(msgs[2]).toHaveTextContent("Ed removed the link.");
    // The sender's name is Maya's, not "You", for the owner reading.
    expect(msgs[0]!.querySelector(".who")).toHaveTextContent("Maya");
  });

  it("gives the agent's owner Pause link, Remove link and Delete conversation, and pauses through the link route", async () => {
    const chat = crossWorld("owner");
    page({ chat });
    await flush();
    fireEvent.click(more("Maya, claude-dashboard"));
    expect(items().map((i) => i.textContent)).toEqual(["Pause link", "Remove link…", "Delete conversation…"]);
    fireEvent.click(items()[0]!);
    await flush();
    expect(chat.api.link).toHaveBeenCalledWith("person:maya", "s-dash", "pause");
    expect(chat.api.pauseLink).not.toHaveBeenCalled();
    fireEvent.click(more("Maya, claude-dashboard"));
    expect(items()[0]).toHaveTextContent("Resume link");
    fireEvent.click(items()[0]!);
    await flush();
    expect(chat.api.link).toHaveBeenLastCalledWith("person:maya", "s-dash", "resume");
  });

  it("shows Resume link disabled with who paused it when the viewer may not resume, and does nothing on a click", async () => {
    const chat = crossWorld("sender", { link: "paused", pausedBy: "owner", canResume: false });
    page({ chat });
    await flush();
    fireEvent.click(more("Maya, claude-dashboard"));
    const resume = items()[0]!;
    expect(resume).toHaveTextContent("Resume link");
    expect(resume).toHaveAttribute("aria-disabled", "true");
    expect(resume).toHaveTextContent("Paused by Ed");
    fireEvent.click(resume);
    await flush();
    expect(chat.api.link).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("lets the person who paused it resume it when the server says canResume, and treats a missing canResume as yes", async () => {
    const chat = crossWorld("sender", { link: "paused", pausedBy: "sender" });
    page({ chat });
    await flush();
    fireEvent.click(more("Maya, claude-dashboard"));
    expect(items()[0]).not.toHaveAttribute("aria-disabled");
    fireEvent.click(items()[0]!);
    await flush();
    expect(chat.api.link).toHaveBeenCalledWith("person:maya", "s-dash", "resume");
  });

  it("asks before it removes a link across owners, then removes it with the link route", async () => {
    const chat = crossWorld("owner");
    page({ chat });
    await flush();
    fireEvent.click(more("Maya, claude-dashboard"));
    fireEvent.click(items()[1]!);
    const box_ = screen.getByTestId("chat-confirm");
    expect(box_).toHaveTextContent("Remove the link between Maya and claude-dashboard?");
    expect(box_).toHaveTextContent("and only Ed can open it again.");
    fireEvent.click(within(box_).getByRole("button", { name: "Remove link" }));
    await flush();
    expect(chat.api.link).toHaveBeenCalledWith("person:maya", "s-dash", "remove");
    expect(chat.api.removeLink).not.toHaveBeenCalled();
  });

  it("offers Allow again to the owner and an Admin after a removal, and not to the person who wrote", async () => {
    const chat = crossWorld("owner", { link: "removed" });
    page({ chat });
    await flush();
    fireEvent.click(more("Maya, claude-dashboard"));
    expect(items().map((i) => i.textContent)).toEqual(["Allow again", "Delete conversation…"]);
    fireEvent.click(items()[0]!);
    await flush();
    expect(chat.api.link).toHaveBeenCalledWith("person:maya", "s-dash", "allow");
    cleanup();
    page({ chat: crossWorld("admin", { link: "removed" }) });
    await flush();
    fireEvent.click(more("Maya, claude-dashboard"));
    expect(items()[0]).toHaveTextContent("Allow again");
    cleanup();
    page({ chat: crossWorld("sender", { link: "removed" }) });
    await flush();
    fireEvent.click(more("Maya, claude-dashboard"));
    expect(items().map((i) => i.textContent)).toEqual(["Delete conversation…"]);
  });

  it("says in the message box why the person cannot write: removed, paused by whom, waiting for approval", async () => {
    page({ chat: crossWorld("sender", { link: "removed" }) });
    await flush();
    await open("d:dm:person:maya|s-dash");
    expect(box()).toBeDisabled();
    expect(box()).toHaveAttribute("placeholder", "Link removed");
    expect(thread()).toHaveTextContent("The link was removed, so nothing can be sent. Only Ed can open it again.");
    cleanup();
    page({ chat: crossWorld("sender", { link: "paused", pausedBy: "owner", canResume: false }) });
    await flush();
    await open("d:dm:person:maya|s-dash");
    expect(box()).toBeDisabled();
    expect(thread()).toHaveTextContent("Paused by Ed: messages are held. Only Ed can resume it.");
    cleanup();
    page({ chat: crossWorld("sender", { link: "waiting" }) });
    await flush();
    await open("d:dm:person:maya|s-dash");
    expect(box()).not.toBeDisabled();
    expect(thread()).toHaveTextContent("Waiting for Ed to approve your message. It is delivered once Ed allows it.");
    cleanup();
    page({ chat: crossWorld("owner") });
    await flush();
    await open("d:dm:person:maya|s-dash");
    expect(box()).toBeDisabled();
    expect(thread()).toHaveTextContent("Only Maya writes in this conversation. You can pause or remove its link from the menu.");
  });

  it("tags the row with the link's state", async () => {
    page({ chat: crossWorld("owner", { link: "waiting" }) });
    await flush();
    expect(row("d:dm:person:maya|s-dash")).toHaveTextContent("Waiting for approval");
    expect(row("d:dm:person:maya|s-dash")).toHaveTextContent("Maya and your agent");
    expect(row("d:dm:person:maya|s-dash")).not.toHaveTextContent("You and one agent");
    cleanup();
    page({ chat: crossWorld("sender") });
    await flush();
    expect(row("d:dm:person:maya|s-dash")).toHaveTextContent("You and Ed's agent");
    cleanup();
    page({ chat: crossWorld("admin") });
    await flush();
    expect(row("d:dm:person:maya|s-dash")).toHaveTextContent("Maya and Ed's agent");
  });
});

describe("messages from other people waiting for the owner", () => {
  it("shows a notice row in Direct Messages that links to My reporters, with the count", async () => {
    const w = world();
    w.overview.approvals = 2;
    page({ chat: fakeChat(w) });
    await flush();
    const link = screen.getByRole("link", { name: /for your approval/ });
    expect(link).toHaveAttribute("href", "#/me/reporters");
    expect(link).toHaveTextContent("2 messages from other people wait for your approval in My reporters.");
  });

  it("says it in the singular, and shows nothing when none wait", async () => {
    const w = world();
    w.overview.approvals = 1;
    page({ chat: fakeChat(w) });
    await flush();
    expect(screen.getByRole("link", { name: /for your approval/ })).toHaveTextContent("1 message from another person waits for your approval in My reporters.");
    cleanup();
    page();
    await flush();
    expect(screen.queryByRole("link", { name: /for your approval/ })).toBeNull();
  });

  it("reads again on the chat signal, which carries the new count", async () => {
    const w = world();
    const p = page({ chat: fakeChat(w) });
    await flush();
    expect(screen.queryByRole("link", { name: /for your approval/ })).toBeNull();
    w.overview.approvals = 3;
    p.signal();
    await flush();
    expect(screen.getByRole("link", { name: /for your approval/ })).toHaveTextContent("3 messages from other people wait");
  });
});

// ---- An Admin reading (#1034) --------------------------------------------------------------------------------------------------

const live = (admin: string, since = T0 - 60_000, until = T0 + 30_000) => ({ admin, since, until });
const ago = (ms: number) => T0 - ms;

describe("the person an Admin reads, told in the console", () => {
  const withReaders = (readers: ReturnType<typeof live>[], groupReaders: ReturnType<typeof live>[] = []) => {
    const w = world();
    w.overview.directs = [direct(DASH, TESTER, { adminReading: readers }), direct(ME, NOTES, { thread: "dm:person:ed|s-notes", messages: 2 })];
    w.overview.channels = [channelOf("general"), channelOf("group", { adminReading: groupReaders })];
    return fakeChat(w);
  };

  it("shows a red banner above the messages, naming the Admin, and an Admin reading tag on the row", async () => {
    page({ chat: withReaders([live("Root")]) });
    await flush();
    expect(within(row("d:dm:s-dash|s-tester")).getByText("Admin reading")).toBeInTheDocument();
    expect(within(row("d:dm:person:ed|s-notes")).queryByText("Admin reading")).toBeNull();
    await open("d:dm:s-dash|s-tester");
    const banner = within(thread()).getByTestId("chat-reading-banner");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveClass("crit");
    expect(banner).toHaveTextContent("Root (an Admin) is reading this conversation.");
    expect(banner).toHaveTextContent("Only you and Admins can read it. The notice clears about 30 seconds after Root stops.");
    expect(within(row("c:general")).queryByText("Admin reading")).toBeNull();
  });

  it("names the first two Admins inline and the rest by count, and lists all of them with their start times in a tip", async () => {
    page({ chat: withReaders([live("Root", T0 - 120_000), live("Alex", T0 - 60_000), live("Sam", T0 - 30_000), live("Kim", T0 - 10_000)]) });
    await flush();
    await open("d:dm:s-dash|s-tester");
    const banner = within(thread()).getByTestId("chat-reading-banner");
    expect(banner).toHaveTextContent("Root, Alex and 2 more Admins are reading this conversation.");
    expect(banner).toHaveTextContent("after the last of them stops");
    const trigger = within(banner).getByText("Who is reading");
    const tip = within(trigger.closest("[aria-describedby]") as HTMLElement).getByRole("tooltip", { hidden: true });
    expect(trigger.closest("[aria-describedby]")).toHaveAttribute("aria-describedby", tip.id);
    expect(tip).toHaveTextContent("Reading now: Root since 14:28, Alex since 14:29, Sam since 14:29, Kim since 14:29.");
    expect(tip).not.toBeVisible();
    fireEvent.focus(trigger.closest("[aria-describedby]")!);
    expect(tip).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(tip).not.toBeVisible();
  });

  it("tells a group's person the same, above My group", async () => {
    page({ chat: withReaders([], [live("Root"), live("Alex")]) });
    await flush();
    expect(within(row("c:group")).getByText("Admin reading")).toBeInTheDocument();
    await open("c:group");
    expect(within(thread()).getByTestId("chat-reading-banner")).toHaveTextContent("Root and Alex (Admins) are reading this conversation.");
  });

  it("drops a reading once its time has passed, without waiting for the server", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const chat = withReaders([live("Root", T0 - 5000, T0 + 4000)]);
    // The server's clock moves with the test's, so a read after the reading's end can say it ended (#1051).
    const real = chat.api.overview.getMockImplementation()!;
    chat.api.overview.mockImplementation(async (owner?: string | null) => ({ ...(await real(owner)), serverTime: Date.now() }));
    page({ chat });
    await flush();
    expect(within(row("d:dm:s-dash|s-tester")).getByText("Admin reading")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(within(row("d:dm:s-dash|s-tester")).queryByText("Admin reading")).toBeNull();
  });

  it("reads again before the earliest reading runs out, so a live read is not hidden at 30 seconds (#1051)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const chat = withReaders([live("Root", T0 - 5000, T0 + 30_000)]);
    const real = chat.api.overview.getMockImplementation()!;
    let reads = 0;
    chat.api.overview.mockImplementation(async (owner?: string | null) => {
      const o = await real(owner);
      reads++;
      // The first read says 30 seconds; the Admin's pings keep the read going, so a later read says 30 seconds from then.
      o.serverTime = Date.now();
      o.directs[0]!.adminReading = [live("Root", T0 - 5000, reads === 1 ? T0 + 30_000 : Date.now() + 30_000)];
      return o;
    });
    page({ chat });
    await flush();
    expect(within(row("d:dm:s-dash|s-tester")).getByText("Admin reading")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(reads).toBeGreaterThan(1);
    expect(within(row("d:dm:s-dash|s-tester")).getByText("Admin reading")).toBeInTheDocument();
  });

  it("keeps a reading shown after its time until a read confirms it ended, then drops it (#1051)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const chat = withReaders([live("Root", T0 - 5000, T0 + 10_000)]);
    const real = chat.api.overview.getMockImplementation()!;
    let down = false;
    chat.api.overview.mockImplementation(async (owner?: string | null) => {
      if (down) throw new RespondError(500, { error: "busy" });
      const o = await real(owner);
      o.serverTime = Date.now();
      return o;
    });
    page({ chat });
    await flush();
    down = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(within(row("d:dm:s-dash|s-tester")).getByText("Admin reading")).toBeInTheDocument();
    down = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(within(row("d:dm:s-dash|s-tester")).queryByText("Admin reading")).toBeNull();
  });

  describe("an Admin looking at the person's list of conversations (#1051)", () => {
    const REST = "is looking at your list of conversations now: who you talk to and how many messages, not what they say.";
    const listWorld = (over: { listReading?: ReturnType<typeof live>[]; listReads?: { admin: string; startedAt: number; lastSeenAt: number; kind?: "read" }[] }) => {
      const w = world();
      Object.assign(w.overview, over);
      return fakeChat(w);
    };

    it("shows a full-width red banner naming the Admin while the look is live, with the words of the mockup", async () => {
      page({ chat: listWorld({ listReading: [live("Root")] }) });
      await flush();
      const banner = screen.getByTestId("chat-list-reading-banner");
      expect(banner).toHaveAttribute("role", "status");
      expect(banner).toHaveClass("ch-nav", "ro", "crit");
      expect(banner).toHaveTextContent(`Root (an Admin) ${REST}`);
      // It is above the page's two panes, not inside the list.
      expect(within(screen.getByTestId("chat-split")).queryByTestId("chat-list-reading-banner")).toBeNull();
      expect(banner.compareDocumentPosition(screen.getByTestId("chat-split")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("names two Admins and counts the rest", async () => {
      page({ chat: listWorld({ listReading: [live("Root"), live("Alex"), live("Sam"), live("Kim")] }) });
      await flush();
      expect(screen.getByTestId("chat-list-reading-banner")).toHaveTextContent("Root, Alex and 2 more Admins are looking at your list of conversations now");
    });

    it("shows nothing when no one looks, and a quiet record line afterward with the date and time", async () => {
      const at = new Date(2026, 10, 6, 14, 20).getTime();
      page({ chat: listWorld({ listReading: [], listReads: [{ admin: "Root", startedAt: at, lastSeenAt: at }] }) });
      await flush();
      expect(screen.queryByTestId("chat-list-reading-banner")).toBeNull();
      const line = screen.getByTestId("chat-list-record");
      expect(line).toHaveClass("ch-nav", "ro");
      expect(line).not.toHaveClass("crit");
      expect(line).toHaveTextContent("Root (an Admin) looked at your list of conversations on Nov 6 at 14:20. They saw who you talk to and message counts, not the messages.");
    });

    it("draws an Admin's name as text, never as markup", async () => {
      const name = '<img src=x onerror="alert(1)">';
      page({ chat: listWorld({ listReading: [live(name)], listReads: [{ admin: name, startedAt: ago(60_000), lastSeenAt: ago(60_000) }] }) });
      await flush();
      expect(document.querySelector("img[src='x']")).toBeNull();
      expect(screen.getByTestId("chat-list-reading-banner")).toHaveTextContent(name);
      expect(screen.getByTestId("chat-list-record")).toHaveTextContent(name);
    });

    it("drops the banner once its time has passed and a read confirms it, and keeps the record", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0);
      const chat = listWorld({ listReading: [live("Root", T0 - 5000, T0 + 4000)], listReads: [{ admin: "Root", startedAt: T0 - 5000, lastSeenAt: T0 - 5000 }] });
      const real = chat.api.overview.getMockImplementation()!;
      chat.api.overview.mockImplementation(async (owner?: string | null) => ({ ...(await real(owner)), serverTime: Date.now() }));
      page({ chat });
      await flush();
      expect(screen.getByTestId("chat-list-reading-banner")).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(screen.queryByTestId("chat-list-reading-banner")).toBeNull();
      expect(screen.getByTestId("chat-list-record")).toBeInTheDocument();
    });

    it("keeps the banner up past 30 seconds while the Admin keeps looking (the overview is read again before it ends)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0);
      const chat = listWorld({ listReading: [live("Root", T0 - 5000, T0 + 30_000)] });
      const real = chat.api.overview.getMockImplementation()!;
      let reads = 0;
      chat.api.overview.mockImplementation(async (owner?: string | null) => {
        const o = await real(owner);
        reads++;
        o.serverTime = Date.now();
        o.listReading = [live("Root", T0 - 5000, reads === 1 ? T0 + 30_000 : Date.now() + 30_000)];
        return o;
      });
      page({ chat });
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      expect(reads).toBeGreaterThan(1);
      expect(screen.getByTestId("chat-list-reading-banner")).toBeInTheDocument();
    });
  });

  describe("the records of a conversation that has since been deleted (#1051)", () => {
    const gone = (over: Partial<GoneRead> = {}): GoneRead => ({ admin: "Root", startedAt: new Date(2026, 10, 5, 9, 12).getTime(), kind: "read", with: "Tester", ...over });
    const goneWorld = (goneReads: GoneRead[]) => {
      const w = world();
      w.overview.goneReads = goneReads;
      return fakeChat(w);
    };

    it("shows each as a quiet line at the top of the list, with the words of the mockup, names in bdi", async () => {
      page({ chat: goneWorld([gone(), gone({ admin: "Alex", startedAt: new Date(2026, 9, 30, 11, 5).getTime(), with: "Review (Alex's agent)" })]) });
      await flush();
      const lines = screen.getAllByTestId("chat-gone-record");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toHaveClass("ch-nav", "ro");
      expect(lines[0]).not.toHaveClass("crit");
      expect(lines[0]).toHaveAttribute("role", "status");
      expect(lines[0]).toHaveTextContent("Root (an Admin) read your conversation with Tester on Nov 5 at 09:12. That conversation has since been deleted.");
      expect(lines[1]).toHaveTextContent("Alex (an Admin) read your conversation with Review (Alex's agent) on Oct 30 at 11:05. That conversation has since been deleted.");
      expect([...lines[0]!.querySelectorAll("bdi")].map((b) => b.textContent)).toEqual(["Root (an Admin)", "Tester"]);
      expect(lines[0]!.compareDocumentPosition(screen.getByTestId("chat-split")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("says what an Admin did when it was not a read, and shows nothing when the server sends none", async () => {
      page({ chat: goneWorld([gone({ kind: "cleared" }), gone({ kind: "paused", with: "Notes" })]) });
      await flush();
      const lines = screen.getAllByTestId("chat-gone-record");
      expect(lines[0]).toHaveTextContent("Root (an Admin) removed all messages in your conversation with Tester on Nov 5 at 09:12. That conversation has since been deleted.");
      expect(lines[1]).toHaveTextContent("Root (an Admin) paused your conversation with Notes on Nov 5 at 09:12. That conversation has since been deleted.");
      cleanup();
      page({ chat: fakeChat(world()) });
      await flush();
      expect(screen.queryByTestId("chat-gone-record")).toBeNull();
    });

    it("words an Admin's stop or delete of the person's own things without a conversation (#1078)", async () => {
      page({ chat: goneWorld([gone({ kind: "recording_stopped", with: "" }), gone({ kind: "access_revoked", with: "" }), gone({ kind: "reporter_removed", with: "" })]) });
      await flush();
      const lines = screen.getAllByTestId("chat-gone-record");
      expect(lines.map((l) => l.textContent)).toEqual([
        "Root (an Admin) stopped a recording of one of your sessions on Nov 5 at 09:12.",
        "Root (an Admin) revoked your Podium access on Nov 5 at 09:12.",
        "Root (an Admin) removed one of your reporters from the Reporters list on Nov 5 at 09:12.",
      ]);
      expect([...lines[0]!.querySelectorAll("bdi")].map((b) => b.textContent)).toEqual(["Root (an Admin)"]);
    });

    it("draws a name as text, never as markup", async () => {
      const name = '<img src=x onerror="alert(1)">';
      page({ chat: goneWorld([gone({ admin: name, with: name })]) });
      await flush();
      expect(document.querySelector("img[src='x']")).toBeNull();
      expect(screen.getByTestId("chat-gone-record")).toHaveTextContent(`${name} (an Admin) read your conversation with ${name}`);
    });

    it("keeps the lines for as long as the page stays open, though the server sends each only once", async () => {
      const chat = goneWorld([gone()]);
      const real = chat.api.overview.getMockImplementation()!;
      let reads = 0;
      chat.api.overview.mockImplementation(async (owner?: string | null) => {
        const o = await real(owner);
        reads++;
        if (reads > 1) o.goneReads = [];
        return o;
      });
      const p = page({ chat });
      await flush();
      p.signal();
      await flush();
      expect(reads).toBeGreaterThan(1);
      expect(screen.getAllByTestId("chat-gone-record")).toHaveLength(1);
    });

    it("keeps a record that came in a read a newer read replaced, because the server sends it once", async () => {
      const chat = goneWorld([]);
      const real = chat.api.overview.getMockImplementation()!;
      let reads = 0;
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      chat.api.overview.mockImplementation(async (owner?: string | null) => {
        const o = await real(owner);
        reads++;
        if (reads === 1) {
          // The older read carries the record and lands after a newer one has started.
          o.goneReads = [gone()];
          await held;
        }
        return o;
      });
      const p = page({ chat });
      await flush();
      p.signal();
      await flush();
      expect(reads).toBe(2);
      expect(screen.queryByTestId("chat-gone-record")).toBeNull();
      await act(async () => {
        release();
      });
      await flush();
      expect(screen.getAllByTestId("chat-gone-record")).toHaveLength(1);
    });
  });

  it("puts a record line among the messages in time order, one for each thing an Admin did", async () => {
    const w = world();
    w.reads = {
      "s-dash|s-tester": [
        { admin: "Root", startedAt: ago(495_000), lastSeenAt: ago(480_000) },
        { admin: "Root", startedAt: ago(485_000), lastSeenAt: ago(485_000), kind: "paused" },
        { admin: "Alex", startedAt: ago(100_000), lastSeenAt: ago(90_000), kind: "resumed" },
        { admin: "Alex", startedAt: ago(50_000), lastSeenAt: ago(50_000), kind: "cleared" },
      ],
    };
    const msgs = w.dms["s-dash|s-tester"]!.messages;
    [500_000, 490_000, 200_000].forEach((ms, i) => (msgs[i]!.sentAt = ago(ms)));
    page({ chat: fakeChat(w) });
    await flush();
    await open("d:dm:s-dash|s-tester");
    const items = [...thread().querySelectorAll("ol.ch-msgs > li:not(.ch-day):not(.ch-newline)")].map((li) => (li.classList.contains("ch-rec") ? `rec:${li.textContent}` : `msg:${li.querySelector(".who")?.textContent}`));
    expect(items).toEqual([
      "msg:claude-dashboard",
      "rec:Root (an Admin) read this conversation on Oct 12 at 14:21.",
      "msg:Tester",
      "rec:Root (an Admin) paused this link on Oct 12 at 14:21.",
      "msg:You",
      "rec:Alex (an Admin) resumed this link on Oct 12 at 14:28.",
      "rec:Alex (an Admin) removed all messages on Oct 12 at 14:29.",
    ]);
    expect(thread().querySelectorAll(".ch-rec input, .ch-rec button")).toHaveLength(0);
  });

  it("holds a link an Admin paused: the tag, the banner and the box name the Admin, and the owner cannot resume it", async () => {
    const w = world();
    w.overview.directs = [direct(DASH, TESTER, { state: "paused", paused: true, pausedBy: "admin", pausedByAdmin: "Root" })];
    page({ chat: fakeChat(w) });
    await flush();
    expect(within(row("d:dm:s-dash|s-tester")).getByText("Paused by an Admin")).toBeInTheDocument();
    await open("d:dm:s-dash|s-tester");
    expect(within(thread()).getByTestId("chat-admin-pause-banner")).toHaveTextContent("Root (an Admin) paused this link. Messages are held and nothing is sent. Only an Admin can resume it.");
    fireEvent.click(screen.getByRole("button", { name: "Actions for claude-dashboard, Tester" }));
    const item = screen.getByRole("menuitem", { name: /Resume link/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent("Paused by Root (an Admin). Only an Admin can resume this link.");
  });

  it("tells both people of a conversation across owners, each naming the other", async () => {
    const w = world();
    const across = direct(ME, agent("s-n", "maya-bot", "maya-mbp"), { owner: "Maya", cross: { person: "Ed", owner: "Maya", link: "open", viewerIs: "owner" }, adminReading: [live("Root")] });
    w.overview.directs = [across];
    w.dms["person:ed|s-n"] = { messages: [dmsg("c1", ME, agent("s-n", "maya-bot", "maya-mbp"), "Hello.")], total: 1 };
    page({ chat: fakeChat(w), me: { ...ED, name: "Maya" } });
    await flush();
    await open("d:dm:person:ed|s-n");
    expect(within(thread()).getByTestId("chat-reading-banner")).toHaveTextContent("Only you, Ed and Admins can read it.");
  });

  it("keeps a group's Resume item off for its person while an Admin's pause holds it", async () => {
    const w = world();
    w.overview.channels = [channelOf("general"), channelOf("group", { paused: true, pausedByAdmin: "Root" })];
    const chat = fakeChat(w);
    page({ chat });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Actions for My group" }));
    const item = screen.getByRole("menuitem", { name: /Resume every agent in the group/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(item);
    await flush();
    expect(chat.api.pause).not.toHaveBeenCalled();
  });

  it("holds a group an Admin paused", async () => {
    const w = world();
    w.overview.channels = [channelOf("general"), channelOf("group", { paused: true, pausedByAdmin: "Root" })];
    page({ chat: fakeChat(w) });
    await flush();
    expect(within(row("c:group")).getByText("Paused by an Admin")).toBeInTheDocument();
    await open("c:group");
    expect(within(thread()).getByTestId("chat-admin-pause-banner")).toHaveTextContent("Root (an Admin) paused every agent in this group.");
    expect(screen.getByTestId("chat-box")).toBeDisabled();
    expect(thread()).toHaveTextContent("Paused by Root (an Admin): messages are held. Only an Admin can resume it.");
  });
});

describe("an Admin reading a person's conversations", () => {
  const MAYA_DM = direct(agent("m-1", "maya-api", "maya-mbp"), agent("m-2", "maya-ui", "maya-mbp"), { owner: "Maya", thread: "dm:m-1|m-2", unread: 5 });
  const adminWorld = () => {
    const w = world();
    w.overview.me = { name: "Root", admin: true, person: false };
    w.overview.channels = [channelOf("general", { can: { pause: false, pauseEveryone: true, disconnect: false, removeAll: true, editDescription: false, removeChannel: false } })];
    w.overview.directs = [];
    w.overview.agents = [];
    w.overview.people = [{ name: "Ed", you: false }, { name: "Maya", you: false }];
    w.owners = {
      Maya: {
        channels: [channelOf("general", { can: { pause: false, pauseEveryone: true, disconnect: false, removeAll: true, editDescription: false, removeChannel: false } }), channelOf("group", { thread: "group:maya", messages: 1, adminReading: [] })],
        directs: [MAYA_DM],
      },
    };
    w.channels.group = { messages: [cmsg("q1", "run the tests", { mine: false, authorName: "Maya", authorRef: "Maya" })] };
    w.dms["m-1|m-2"] = { messages: [dmsg("x1", agent("m-1", "maya-api", "maya-mbp"), agent("m-2", "maya-ui", "maya-mbp"), "Maya's agents talking.")], total: 1 };
    return w;
  };
  const pickPerson = async (name = "Maya") => {
    fireEvent.change(screen.getByLabelText("Read a person's conversations"), { target: { value: name } });
    await flush();
  };

  it("offers a picker of the other people and shows only General until one is chosen", async () => {
    page({ chat: fakeChat(adminWorld()), me: ROOT });
    await flush();
    const sel = screen.getByLabelText("Read a person's conversations") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(["Choose a person…", "Ed", "Maya"]);
    const nav = within(screen.getByRole("navigation", { name: "Chat" }));
    expect(nav.getByRole("heading", { name: "Read as an Admin" })).toBeInTheDocument();
    expect(nav.queryByRole("heading", { name: "Direct Messages" })).toBeNull();
    expect(row("c:general")).toBeInTheDocument();
  });

  it("lets an Admin stop reading in place, from the picker and from the thread, and shows no such button to anyone else (#1066)", async () => {
    page({ chat: fakeChat(adminWorld()), me: ROOT });
    await flush();
    expect(screen.queryByTestId("chat-stop-reading")).toBeNull();
    await pickPerson();
    const stop = screen.getByTestId("chat-stop-reading");
    expect(stop).toHaveTextContent("Stop reading");
    const picker = screen.getByLabelText("Read a person's conversations") as HTMLSelectElement;
    expect(picker.value).toBe("Maya");
    expect(screen.getByRole("heading", { name: /^Direct Messages/ })).toBeInTheDocument();
    fireEvent.click(stop);
    await flush();
    expect(screen.queryByTestId("chat-stop-reading")).toBeNull();
    expect((screen.getByLabelText("Read a person's conversations") as HTMLSelectElement).value).toBe("");
    expect(screen.queryByRole("heading", { name: /^Direct Messages/ })).toBeNull();
    expect(screen.getByText("Back to your own conversations.")).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(document.activeElement).toBe(screen.getByLabelText("Read a person's conversations"));
    cleanup();
    page({ chat: fakeChat(world()), me: ED });
    await flush();
    expect(screen.queryByLabelText("Read a person's conversations")).toBeNull();
    expect(screen.queryByTestId("chat-stop-reading")).toBeNull();
  });

  it("keeps the long reading note behind an (i) tip on the picker's label (#1066)", async () => {
    page({ chat: fakeChat(adminWorld()), me: ROOT });
    await flush();
    const tip = screen.getByLabelText("About reading as an Admin");
    const note = document.getElementById(tip.getAttribute("aria-describedby")!)!;
    expect(note).toHaveAttribute("role", "tooltip");
    expect(note).toHaveTextContent("the person sees a red notice");
    expect(note).toHaveTextContent("never the text");
  });

  it("draws Loading, not the previous person's list, menus and box, while the chosen person's list is read (#1051)", async () => {
    const w = world();
    w.overview.me = { name: "Root", admin: true, person: true };
    w.overview.people = [{ name: "Root", you: true }, { name: "Maya", you: false }];
    w.owners = { Maya: { directs: [] } };
    const chat = fakeChat(w);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const real = chat.api.overview.getMockImplementation()!;
    chat.api.overview.mockImplementation(async (owner?: string | null) => {
      if (owner === "Maya") await held;
      return real(owner);
    });
    page({ chat, me: ROOT });
    await flush();
    expect(row("d:dm:s-dash|s-tester")).toBeInTheDocument();
    await pickPerson();
    expect(screen.queryByTestId("chat-row-d:dm:s-dash|s-tester")).toBeNull();
    expect(screen.queryByTestId("chat-box")).toBeNull();
    expect(screen.queryByTestId("chat-split")).toBeNull();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    release();
    await flush();
    expect(screen.getByText("Maya has no Direct Messages.")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-row-d:dm:s-dash|s-tester")).toBeNull();
  });

  it("never offers the picker to someone who is not an Admin", async () => {
    page();
    await flush();
    expect(screen.queryByLabelText("Read a person's conversations")).toBeNull();
  });

  it("shows the chosen person's My group and Direct Messages as read only, with no People and agents", async () => {
    const p = page({ chat: fakeChat(adminWorld()), me: ROOT });
    await flush();
    await pickPerson();
    expect(p.chat.api.overview).toHaveBeenLastCalledWith("Maya");
    const nav = within(screen.getByRole("navigation", { name: "Chat" }));
    expect(titles(nav)).toEqual(["Read as an Admin", "Channels", "Direct Messages"]);
    expect(row("c:group")).toHaveTextContent("read only");
    expect(row("d:dm:m-1|m-2")).toHaveTextContent("Two agents, and Maya, read only");
    expect(row("d:dm:m-1|m-2")).toHaveTextContent("maya-api, maya-ui");
    expect(within(row("d:dm:m-1|m-2")).queryByLabelText(/new/)).toBeNull();
  });

  it("opens a thread with a red banner, a message box that is off with the reason, and records nothing as read", async () => {
    const p = page({ chat: fakeChat(adminWorld()), me: ROOT });
    await flush();
    await pickPerson();
    await open("d:dm:m-1|m-2");
    const banner = within(thread()).getByTestId("chat-ro-banner");
    expect(banner).toHaveClass("crit");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveTextContent("Reading Maya's conversation as an Admin. You cannot send here.");
    expect(banner).toHaveTextContent("Maya is told while you read, and a line stays in the conversation afterward.");
    const box = screen.getByTestId("chat-box");
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute("placeholder", "An Admin cannot send here");
    expect(screen.getByTestId("chat-send")).toBeDisabled();
    expect(screen.getByTestId("chat-ro-note")).toHaveTextContent("You are reading as an Admin, so nothing can be sent here.");
    expect(thread().querySelectorAll(".ch-pick")).toHaveLength(0);
    expect(p.chat.api.markRead).not.toHaveBeenCalled();
    expect(p.chat.api.addresses).not.toHaveBeenCalled();
  });

  it("tells both people of a conversation across owners while an Admin reads it, and marks nothing read for an Admin who is a person", async () => {
    const w = adminWorld();
    w.overview.me = { name: "Root", admin: true, person: true };
    w.owners!.Maya!.directs = [direct(agent("m-1", "maya-api", "maya-mbp"), { ...ME, sessionId: "person:ed" }, { owner: "Maya", thread: "dm:m-1|person:ed", unread: 3, cross: { person: "Ed", owner: "Maya", link: "open", viewerIs: "admin" } })];
    w.dms["m-1|person:ed"] = { messages: [dmsg("x2", ME, agent("m-1", "maya-api", "maya-mbp"), "Hi Maya's agent.")], total: 1 };
    const p = page({ chat: fakeChat(w), me: ROOT });
    await flush();
    await pickPerson();
    await open("d:dm:m-1|person:ed");
    expect(within(thread()).getByTestId("chat-ro-banner")).toHaveTextContent("Reading Maya's conversation as an Admin. You cannot send here. Maya and Ed are told while you read");
    expect(p.chat.api.markRead).not.toHaveBeenCalled();
  });

  it("tells the Admin who paused a group that they did, by the name the server records for them, and names any other Admin", async () => {
    for (const [by, you] of [["Admin secret", true], ["Root", false]] as const) {
      const w = adminWorld();
      w.overview.me = { name: "Admin", actor: "Admin secret", admin: true, person: false };
      w.owners!.Maya!.channels = [channelOf("general"), channelOf("group", { thread: "group:maya", messages: 1, adminReading: [], paused: true, pausedByAdmin: by })];
      page({ chat: fakeChat(w), me: ROOT });
      await flush();
      await pickPerson();
      await open("c:group");
      const banner = within(thread()).getByTestId("chat-admin-pause-banner");
      if (you) expect(banner).toHaveTextContent("You paused every agent in this group. Messages are held until you resume it from its menu.");
      else expect(banner).toHaveTextContent("Root (an Admin) paused every agent in this group.");
      cleanup();
    }
  });

  it("reads another person's group by naming its owner", async () => {
    const p = page({ chat: fakeChat(adminWorld()), me: ROOT });
    await flush();
    await pickPerson();
    await open("c:group");
    expect(p.chat.api.channelMessages).toHaveBeenCalledWith("group", expect.objectContaining({ owner: "Maya" }));
    expect(within(thread()).getByTestId("chat-ro-banner")).toBeInTheDocument();
  });

  it("gives a group menu Pause, Disconnect and Remove all messages, each naming the owner", async () => {
    const p = page({ chat: fakeChat(adminWorld()), me: ROOT });
    await flush();
    await pickPerson();
    fireEvent.click(screen.getByRole("button", { name: "Actions for My group" }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Pause every agent in Maya's group", "Disconnect every agent in Maya's group", "Remove all messages…"]);
    fireEvent.click(screen.getByRole("menuitem", { name: /Pause every agent/ }));
    await flush();
    expect(p.chat.api.pause).toHaveBeenCalledWith("group", true, false, "Maya");
    fireEvent.click(screen.getByRole("button", { name: "Actions for My group" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Disconnect every agent/ }));
    await flush();
    expect(p.chat.api.disconnect).toHaveBeenCalledWith("group", true, "Maya");
    fireEvent.click(screen.getByRole("button", { name: "Actions for My group" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove all messages…" }));
    await flush();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove all messages" }));
    await flush();
    expect(p.chat.api.clear).toHaveBeenCalledWith("group", "Maya");
  });

  it("gives a Direct Message menu Pause link and nothing else, and pauses through Chat's link route", async () => {
    const p = page({ chat: fakeChat(adminWorld()), me: ROOT });
    await flush();
    await pickPerson();
    fireEvent.click(screen.getByRole("button", { name: "Actions for maya-api, maya-ui" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Pause link"]);
    expect(menu).toHaveTextContent("An Admin reads a Direct Message and cannot send in it. Maya removes the link or deletes the conversation.");
    fireEvent.click(screen.getByRole("menuitem", { name: "Pause link" }));
    await flush();
    expect(p.chat.api.link).toHaveBeenCalledWith("m-1", "m-2", "pause");
    expect(p.chat.api.pauseLink).not.toHaveBeenCalled();
  });

  it("offers Resume link on a link that is paused, whoever paused it", async () => {
    const w = adminWorld();
    w.owners!.Maya!.directs = [{ ...MAYA_DM, state: "paused", paused: true, pausedBy: "owner" }];
    page({ chat: fakeChat(w), me: ROOT });
    await flush();
    await pickPerson();
    fireEvent.click(screen.getByRole("button", { name: "Actions for maya-api, maya-ui" }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Resume link"]);
  });

  describe("keeping the reading alive", () => {
    const hide = (v: "hidden" | "visible") => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
    afterEach(() => hide("visible"));

    it("pings a group every 15 seconds while it is open, and stops when another thread opens", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0);
      const p = page({ chat: fakeChat(adminWorld()), me: ROOT });
      await flush();
      await pickPerson();
      await open("c:group");
      expect(p.chat.api.readingChannel).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(p.chat.api.readingChannel).toHaveBeenCalledTimes(1);
      expect(p.chat.api.readingChannel).toHaveBeenCalledWith("group", "Maya");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(p.chat.api.readingChannel).toHaveBeenCalledTimes(2);
      await open("c:general");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(45_000);
      });
      expect(p.chat.api.readingChannel).toHaveBeenCalledTimes(2);
      expect(p.chat.api.readingDm).not.toHaveBeenCalled();
    });

    it("pings a Direct Message by its two ids, skips a hidden tab, and says nothing when a ping fails", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0);
      const chat = fakeChat(adminWorld());
      chat.api.readingDm.mockRejectedValue(new RespondError(500, { error: "busy" }));
      page({ chat, me: ROOT });
      await flush();
      await pickPerson();
      await open("d:dm:m-1|m-2");
      hide("hidden");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(chat.api.readingDm).not.toHaveBeenCalled();
      hide("visible");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(chat.api.readingDm).toHaveBeenCalledWith("m-1", "m-2", "Maya");
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("pings nothing for the Admin's own thread or for a person who is not an Admin", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0);
      const p = page();
      await flush();
      await open("c:group");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(p.chat.api.readingChannel).not.toHaveBeenCalled();
    });
  });

  it("returns to the Admin's own view when the choice is cleared", async () => {
    const p = page({ chat: fakeChat(adminWorld()), me: ROOT });
    await flush();
    await pickPerson();
    await pickPerson("");
    expect(p.chat.api.overview).toHaveBeenLastCalledWith(null);
    expect(screen.queryByTestId("chat-row-c:group")).toBeNull();
  });

  it("shows an Admin who is not reading the Read as an Admin section, an empty thread area that says what to do, and no row selected", async () => {
    const w = adminWorld();
    page({ chat: fakeChat(w), me: ROOT });
    await flush();
    const nav = within(screen.getByRole("navigation", { name: "Chat" }));
    expect(titles(nav)[0]).toBe("Read as an Admin");
    expect(nav.getByText(/belong to a person/)).toBeInTheDocument();
    const idle = screen.getByTestId("chat-idle");
    expect(idle).toHaveTextContent("Choose General or a channel to read it.");
    expect(idle).toHaveTextContent("To read a person's conversations, choose a person under Read as an Admin.");
    expect(screen.queryByTestId("chat-thread")).toBeNull();
    expect(row("c:general")).not.toHaveClass("on");
    await open("c:general");
    expect(screen.queryByTestId("chat-idle")).toBeNull();
    expect(screen.getByTestId("chat-thread")).toBeInTheDocument();
  });

  it("keeps the whole note behind the (i) of the picker and says what is shown once a person is chosen", async () => {
    page({ chat: fakeChat(adminWorld()), me: ROOT });
    await flush();
    const tip = screen.getByLabelText("About reading as an Admin");
    expect(tip.closest(".rd-head")).not.toBeNull();
    expect(within(tip.closest("[aria-describedby]") as HTMLElement).getByRole("tooltip", { hidden: true })).toHaveTextContent("Podium records in the audit log that you read it, never the text.");
    await pickPerson();
    expect(screen.getByTestId("chat-stop-reading")).toHaveTextContent("Stop reading");
    expect(screen.getByText(/'s My group and Direct Messages. Read only./)).toHaveTextContent("Showing Maya's My group and Direct Messages. Read only.");
    expect(row("c:group")).toHaveTextContent("Maya's own orchestrators and subagents, read only");
  });

  it("shows a person's My group with the @ tool off beside the box, so nothing can be addressed", async () => {
    page({ chat: fakeChat(adminWorld()), me: ROOT });
    await flush();
    await pickPerson();
    await open("c:group");
    expect(screen.getByTestId("chat-box")).toHaveAttribute("placeholder", "An Admin cannot send here");
    expect(screen.getByTestId("chat-tool-at")).toBeDisabled();
  });

  it("stops reading from the thread's own button, and leaves nothing that sends in the thread", async () => {
    page({ chat: fakeChat(adminWorld()), me: ROOT });
    await flush();
    await pickPerson();
    await open("d:dm:m-1|m-2");
    expect(screen.getByTestId("chat-box")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Message maya/ })).toBeNull();
    fireEvent.click(screen.getByTestId("chat-stop-reading-thread"));
    await flush();
    expect(screen.queryByTestId("chat-ro-banner")).toBeNull();
    expect(screen.queryByTestId("chat-stop-reading")).toBeNull();
  });
});

// #1067 (mockup/podium-orchestrator-chat-button.html): the orchestrator page's "Chat with Agent" button opens #/chat?with=<id>, and
// Chat opens the person's own conversation with that orchestrator, or one ready to start when there is none.
describe("the chat an address names (#1067)", () => {
  it("opens the conversation the person already has with that orchestrator", async () => {
    window.location.hash = "#/chat?with=s-notes";
    page();
    await flush();
    expect(within(thread()).getByRole("heading", { level: 2 })).toHaveTextContent("infra-notes");
    expect(within(thread()).getByText("Add the install steps.")).toBeInTheDocument();
    expect(row("d:dm:person:ed|s-notes")).toHaveClass("on");
  });

  it("opens one ready to start when there is none, and sends to it through 'me'", async () => {
    const w = world();
    w.overview.directs = [];
    const chat = fakeChat(w);
    chat.api.dmMessages.mockImplementation(async () => ({ ok: true, thread: "dm:x", a: ME, b: DASH, messages: [], older: null, total: 0, ended: [], owner: "Ed", paused: false, roundTrips: { used: 0, cap: 0 } }));
    window.location.hash = "#/chat?with=s-dash";
    page({ chat });
    await flush();
    expect(chat.api.dmMessages).toHaveBeenCalledWith("me", "s-dash", expect.anything());
    expect(screen.getByText("Message claude-dashboard")).toBeInTheDocument();
    expect(screen.queryByText(/could not|failed/i)).toBeNull();
    fireEvent.change(box(), { target: { value: "hello" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    await flush();
    expect(chat.api.sendDm).toHaveBeenCalledWith("me", "s-dash", "hello");
  });

  it("falls back to General, with no error, for a session Chat does not list", async () => {
    window.location.hash = "#/chat?with=s-gone";
    page();
    await flush();
    expect(within(thread()).getByRole("heading", { level: 2 })).toHaveTextContent("General");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens General first when the address names no one", async () => {
    window.location.hash = "#/chat";
    page();
    await flush();
    expect(within(thread()).getByRole("heading", { level: 2 })).toHaveTextContent("General");
  });

  it("leaves the person's later choice alone when the console redraws", async () => {
    window.location.hash = "#/chat?with=s-notes";
    const p = page();
    await flush();
    await open("c:general");
    p.signal();
    await flush();
    expect(within(thread()).getByRole("heading", { level: 2 })).toHaveTextContent("General");
  });

  it("opens the same conversation again when the person leaves the address and the button is used once more", async () => {
    window.location.hash = "#/chat?with=s-notes";
    const p = page();
    await flush();
    expect(within(thread()).getByRole("heading", { level: 2 })).toHaveTextContent("infra-notes");
    // The top bar's Chat link goes to #/chat, which names no one, and the person picks General.
    window.location.hash = "#/chat";
    p.signal();
    await flush();
    await open("c:general");
    expect(within(thread()).getByRole("heading", { level: 2 })).toHaveTextContent("General");
    // Back, or the button again, names the same session: it opens that conversation again.
    window.location.hash = "#/chat?with=s-notes";
    p.signal();
    await flush();
    expect(within(thread()).getByRole("heading", { level: 2 })).toHaveTextContent("infra-notes");
  });

  it("shows no Admin notice: opening one's own conversation is not an Admin read", async () => {
    window.location.hash = "#/chat?with=s-notes";
    page();
    await flush();
    // The red notice, the red tag and the record line are what an Admin's read draws; none is on the person's own conversation.
    expect(document.querySelector(".ch-nav.crit, .tag.crit, .ch-rec")).toBeNull();
  });
});

describe("the Chat button on the orchestrator page (#1067)", () => {
  const consoleWith = (peers: boolean) => {
    window.location.hash = "#/?open=s-dash";
    const state = stateFrom({
      sessions: [makeSession({ id: "s-dash", name: "claude-dashboard", status: "running", lastSeenAt: T0, owner: "Ed" })],
      features: { "activity-feed": true, "peer-messaging": peers },
    });
    return render(<FleetView respondApi={respondApi(ED)} peersApi={peersApi()} chatApi={fakeChat().api} state={state} />);
  };

  it("shows beside the name while orchestrator messaging is on, and opens that orchestrator's chat", async () => {
    consoleWith(true);
    await flush();
    const link = screen.getByRole("link", { name: "Chat with Agent" });
    expect(link).toHaveAttribute("href", "#/chat?with=s-dash");
    expect(link.closest(".nm-row")?.querySelector("h1")).toHaveTextContent("claude-dashboard");
  });

  it("is absent while orchestrator messaging is off", async () => {
    consoleWith(false);
    await flush();
    expect(screen.queryByRole("link", { name: "Chat with Agent" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: /claude-dashboard/ })).toBeInTheDocument();
  });
});

describe("opening a thread moves the focus to its heading", () => {
  it("only once the thread's screen is showing, even when an earlier render's effects were still waiting", async () => {
    const p = page();
    await flush();
    // The narrow layout hides the thread until data-pane says "thread"; a focus() on the hidden heading does nothing.
    const panes: (string | null)[] = [];
    const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement) {
      if (this.id === "th-h") panes.push(screen.getByTestId("chat-split").getAttribute("data-pane"));
    });
    try {
      // A signal lands, and the person's click comes before its effects have run.
      await act(async () => {
        p.signal();
        fireEvent.click(rowBtn("d:dm:s-dash|s-tester"));
      });
      await flush();
      expect(panes.length).toBeGreaterThan(0);
      expect(panes).not.toContain("side");
      expect(panes[panes.length - 1]).toBe("thread");
    } finally {
      focus.mockRestore();
    }
  });
});

// ---- Public channels, New channel and New direct message (#1035, mockup/podium-channels.html) ------------------------------

const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
const OWN_CAN = { pause: true, pauseEveryone: false, disconnect: true, removeAll: false, editDescription: true, removeChannel: false };
const ELSE_CAN = { ...OWN_CAN, editDescription: false };
const ADMIN_CAN = { pause: true, pauseEveryone: true, disconnect: true, removeAll: true, editDescription: true, removeChannel: true };
const DESC = "Public channels: design questions, and who is working on what.";

/** Ed's overview with General, two public channels (one Maya opened, one Ed opened, nothing in it) and My group. */
function chanWorld(admin = false) {
  const w = world();
  const can = (own: boolean) => (admin ? ADMIN_CAN : own ? OWN_CAN : ELSE_CAN);
  w.overview.channels = [
    channelOf("general"),
    channelOf("issue-1035", { description: DESC, link: { kind: "issue", ref: "1035" }, openedBy: "Maya", unread: 3, messages: 2, can: can(false) }),
    channelOf("mine-chan", { description: "Ed's own scratch channel.", openedBy: "Ed", messages: 0, can: can(true) }),
    channelOf("group", { mentions: 1, messages: 2 }),
  ];
  if (admin) w.overview.me = { name: "Ed", admin: true, person: true };
  w.channels["issue-1035"] = {
    messages: [
      cmsg("p1", "Decision: only the orchestrator posts here.", { mine: false, authorName: "Maya", authorRef: "Maya" }),
      cmsg("p2", "Reading this before I draft. <b>bold</b><script>alert(1)</script>", { mine: false, authorKind: "orchestrator", authorName: "docs-writer", authorRef: "s-docs", authorOwner: "Maya" }),
    ],
  };
  w.channels["mine-chan"] = { messages: [] };
  return w;
}
const TARGETS: DirectTarget[] = [
  { sessionId: "s-dash", name: "claude-dashboard", machine: "ed-mbp", address: "claude-dashboard@ed-mbp", owner: "Ed", own: true, status: "running", waitReason: null, canMessage: true, why: null, needsApproval: false, link: null, thread: "dm:person:ed|s-dash" },
  { sessionId: "s-docs", name: "docs-writer", machine: "maya-laptop", address: "docs-writer@maya-laptop", owner: "Maya", own: false, status: "running", waitReason: null, canMessage: true, why: null, needsApproval: true, link: "none", thread: "dm:person:ed|s-docs" },
  { sessionId: "s-gone", name: "old-agent", machine: "maya-laptop", address: "old-agent@maya-laptop", owner: "Maya", own: false, status: "done", waitReason: null, canMessage: true, why: null, needsApproval: true, link: "none", thread: "dm:person:ed|s-gone" },
  { sessionId: "s-blocked", name: "release-bot", machine: "maya-laptop", address: "release-bot@maya-laptop", owner: "Maya", own: false, status: "waiting", waitReason: "input", canMessage: false, why: "Maya removed the link to release-bot, so it takes no messages from you.", needsApproval: false, link: "removed", thread: "dm:person:ed|s-blocked" },
];
const AXE_RULES = {
  runOnly: { type: "tag" as const, values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
  rules: { "color-contrast": { enabled: false }, "target-size": { enabled: false }, "scrollable-region-focusable": { enabled: false }, "link-in-text-block": { enabled: false }, region: { enabled: false } },
};

describe("public channels in the sidebar", () => {
  it("lists General, then the public channels, then My group, each with its description, its unread badge and its menu", async () => {
    page({ chat: fakeChat(chanWorld()) });
    await flush();
    const keys = within(screen.getByRole("navigation", { name: "Chat" })).getAllByTestId(/^chat-row-c:/).map((r) => r.getAttribute("data-testid"));
    expect(keys).toEqual(["chat-row-c:general", "chat-row-c:issue-1035", "chat-row-c:mine-chan", "chat-row-c:group"]);
    const r = row("c:issue-1035");
    expect(r.querySelector(".nm")).toHaveTextContent("issue-1035");
    expect(r.querySelector(".sub")).toHaveTextContent(DESC);
    expect(r.querySelector(".unread")).toHaveAttribute("aria-label", "3 new");
    expect(within(r).getByRole("button", { name: "Actions for issue-1035" })).toBeInTheDocument();
    expect(row("c:mine-chan").querySelector(".sub")).toHaveTextContent("Ed's own scratch channel.");
    expect(row("c:general").querySelector(".sub")).toHaveTextContent("Everyone signed in to this server");
  });

  it("puts each section's title and its + in one row: the fold button first, with its count, then the + with its tip", async () => {
    page({ chat: fakeChat(chanWorld()) });
    await flush();
    for (const [h, b, tip] of [["Channels", "New channel", "Create a channel"], ["Direct Messages", "New direct message", "Start a direct message"]] as const) {
      const heading = screen.getByRole("heading", { level: 2, name: new RegExp(`^${h}`) });
      const btn = screen.getByRole("button", { name: b });
      expect(heading).toContainElement(btn);
      expect(btn).toHaveAttribute("aria-haspopup", "dialog");
      expect(btn).toHaveAccessibleDescription(tip);
      expect(heading.firstElementChild).toBe(within(heading).getByRole("button", { name: new RegExp(`^${h}`) }));
      expect(heading.querySelector(".ch-fold .ch-count")).toHaveTextContent(/^\d+$/);
    }
  });

  it("says so when a channel has no description yet", async () => {
    const w = chanWorld();
    w.overview.channels[2] = channelOf("mine-chan", { description: "", openedBy: "Ed", can: OWN_CAN });
    page({ chat: fakeChat(w) });
    await flush();
    expect(row("c:mine-chan").querySelector(".sub")).toHaveTextContent("No description yet.");
  });

  it("opens the channel's menu with a right-click as well", async () => {
    page({ chat: fakeChat(chanWorld()) });
    await flush();
    fireEvent.contextMenu(row("c:issue-1035"));
    expect(screen.getByRole("menu", { name: "Actions for issue-1035" })).toBeInTheDocument();
  });

  it("draws a description as text, never as HTML", async () => {
    const w = chanWorld();
    w.overview.channels[1] = channelOf("issue-1035", { description: "<b>loud</b><script>alert(1)</script>", openedBy: "Maya", can: ELSE_CAN });
    page({ chat: fakeChat(w) });
    await flush();
    await open("c:issue-1035");
    expect(row("c:issue-1035").querySelector("b, script")).toBeNull();
    expect(row("c:issue-1035").querySelector(".sub")).toHaveTextContent("<b>loud</b><script>alert(1)</script>");
    expect(screen.getByTestId("chat-desc").querySelector("b, script")).toBeNull();
    expect(screen.getByTestId("chat-desc")).toHaveTextContent("<b>loud</b><script>alert(1)</script>");
  });

  it("turns New channel off at the limit and says why in the server's words", async () => {
    const w = chanWorld();
    w.overview.channels = [channelOf("general"), ...Array.from({ length: 50 }, (_, i) => channelOf(`c-${i}`, { description: "x", can: ELSE_CAN })), channelOf("group")];
    page({ chat: fakeChat(w) });
    await flush();
    const btn = screen.getByRole("button", { name: "New channel" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription(/This server has 50 channels besides General, the most it keeps\. An Admin can remove one that is no longer used\./);
    fireEvent.click(btn);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("has New channel on while the server is below the limit", async () => {
    page({ chat: fakeChat(chanWorld()) });
    await flush();
    expect(screen.getByRole("button", { name: "New channel" })).toBeEnabled();
    expect(screen.queryByText(/the most it keeps/)).toBeNull();
  });
});

describe("a public channel's thread", () => {
  it("shows the link chip, who opened it, the count, the description and the scope line, and 'orchestrator of' on an agent's message", async () => {
    page({ chat: fakeChat(chanWorld()) });
    await flush();
    await open("c:issue-1035");
    const t = thread();
    expect(within(t).getByRole("heading", { level: 2, name: /issue-1035/ })).toBeInTheDocument();
    expect(screen.getByTestId("chat-link-chip")).toHaveTextContent("Issue #1035");
    expect(t).toHaveTextContent("Opened by Maya");
    expect(t).toHaveTextContent("2 messages");
    expect(screen.getByTestId("chat-desc")).toHaveTextContent(DESC);
    expect(t).toHaveTextContent("Every person and Admin signed in to this server can read and post here. An orchestrator reads or posts here only when an @ called it in during the last hour, and sees at most that hour. A subagent does not post here; its orchestrator does.");
    const msgs = within(t).getAllByTestId("chat-message");
    expect(msgs[1]).toHaveTextContent("docs-writer");
    expect(msgs[1]).toHaveTextContent("orchestrator of Maya");
    expect(msgs[0]).not.toHaveTextContent("orchestrator of");
    // The text of a message is a text node.
    expect(msgs[1].querySelector("b, script")).toBeNull();
    expect(msgs[1]).toHaveTextContent("<b>bold</b><script>alert(1)</script>");
    expect(screen.getByTestId("chat-box")).toBeEnabled();
    expect(screen.getByLabelText("Message issue-1035")).toBeInTheDocument();
  });

  it("names a link to a milestone and to a project", async () => {
    const w = chanWorld();
    w.overview.channels[1] = channelOf("issue-1035", { description: "d", link: { kind: "milestone", ref: "v1.7" }, can: ELSE_CAN });
    w.overview.channels[2] = channelOf("mine-chan", { description: "d", link: { kind: "project", ref: "podium" }, can: OWN_CAN });
    page({ chat: fakeChat(w) });
    await flush();
    await open("c:issue-1035");
    expect(screen.getByTestId("chat-link-chip")).toHaveTextContent("Milestone v1.7");
    await open("c:mine-chan");
    expect(screen.getByTestId("chat-link-chip")).toHaveTextContent("Project podium");
  });

  it("shows an issue number with one # and any other issue reference as it is, never ## or none", async () => {
    const w = chanWorld();
    w.overview.channels[1] = channelOf("issue-1035", { description: "d", link: { kind: "issue", ref: "PODIUM-7" }, can: ELSE_CAN });
    w.overview.channels[2] = channelOf("mine-chan", { description: "d", link: { kind: "milestone", ref: "1035" }, can: OWN_CAN });
    page({ chat: fakeChat(w) });
    await flush();
    await open("c:issue-1035");
    expect(screen.getByTestId("chat-link-chip").textContent).toBe("Issue PODIUM-7");
    await open("c:mine-chan");
    expect(screen.getByTestId("chat-link-chip").textContent).toBe("Milestone 1035");
  });

  it("has no link chip, no description and no 'Opened by' when the channel has none of them", async () => {
    const w = chanWorld();
    w.overview.channels[2] = channelOf("mine-chan", { description: "", can: OWN_CAN });
    page({ chat: fakeChat(w) });
    await flush();
    await open("c:mine-chan");
    expect(screen.queryByTestId("chat-link-chip")).toBeNull();
    expect(screen.queryByTestId("chat-desc")).toBeNull();
    expect(thread()).not.toHaveTextContent("Opened by");
  });

  it("starts an empty channel with an introduction above the composer, and posts to it by its name", async () => {
    const chat = fakeChat(chanWorld());
    page({ chat });
    await flush();
    await open("c:mine-chan");
    const intro = within(thread()).getByTestId("chat-intro");
    expect(intro).toHaveTextContent("This is the start of");
    expect(intro).toHaveTextContent("Say something, or type @ to hand work to an agent.");
    fireEvent.change(box(), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await flush();
    expect(chat.api.post).toHaveBeenCalledWith("mine-chan", "first");
  });

  it("reads again on the chat signal when a channel is described or removed, and falls back to General once it is gone", async () => {
    const chat = fakeChat(chanWorld());
    const p = page({ chat });
    await flush();
    await open("c:mine-chan");
    chat.w.overview.channels = chat.w.overview.channels.map((c) => (c.id === "mine-chan" ? { ...c, description: "Edited elsewhere." } : c));
    p.signal();
    await flush();
    expect(screen.getByTestId("chat-desc")).toHaveTextContent("Edited elsewhere.");
    chat.w.overview.channels = chat.w.overview.channels.filter((c) => c.id !== "mine-chan");
    p.signal();
    await flush();
    expect(screen.queryByTestId("chat-row-c:mine-chan")).toBeNull();
    expect(rowBtn("c:general")).toHaveAttribute("aria-current", "true");
  });

  it("raises no Admin notice for a public channel an Admin reads while reading a person, and lets the Admin post in it", async () => {
    const w = chanWorld();
    w.overview.me = { name: "Root", admin: true, person: false };
    w.overview.channels = [channelOf("general", { can: ADMIN_CAN }), w.overview.channels[1]!];
    w.overview.people = [{ name: "Ed", you: false }, { name: "Maya", you: false }];
    w.overview.directs = [];
    w.overview.agents = [];
    w.owners = { Maya: { channels: [channelOf("general", { can: ADMIN_CAN }), { ...w.overview.channels[1]!, can: ADMIN_CAN }, channelOf("group", { thread: "group:maya" })], directs: [] } };
    w.channels.group = { messages: [] };
    const chat = fakeChat(w);
    page({ chat, me: ROOT });
    await flush();
    fireEvent.change(screen.getByLabelText("Read a person's conversations"), { target: { value: "Maya" } });
    await flush();
    await open("c:issue-1035");
    expect(screen.queryByTestId("chat-ro-note")).toBeNull();
    expect(screen.queryByText(/Reading Maya's conversation as an Admin/)).toBeNull();
    expect(screen.getByTestId("chat-box")).toBeEnabled();
    expect(chat.api.readingChannel).not.toHaveBeenCalled();
  });
});

describe("a public channel's menu", () => {
  const items = () => within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent);

  it("offers a person who did not open it only to pause or disconnect their own agents, and says what is an Admin's", async () => {
    page({ chat: fakeChat(chanWorld()) });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Actions for issue-1035" }));
    expect(items()).toEqual(["Pause my agents in issue-1035", "Disconnect my agents in issue-1035"]);
    expect(screen.getByRole("menu")).toHaveTextContent("Only an Admin can pause issue-1035 for everyone or remove its messages or the channel.");
  });

  it("adds Edit description to the channel's opener", async () => {
    page({ chat: fakeChat(chanWorld()) });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Actions for mine-chan" }));
    expect(items()).toEqual(["Pause my agents in mine-chan", "Disconnect my agents in mine-chan", "Edit description…"]);
  });

  it("gives an Admin everything, in order", async () => {
    page({ chat: fakeChat(chanWorld(true)), me: ROOT });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Actions for issue-1035" }));
    expect(items()).toEqual(["Pause my agents in issue-1035", "Disconnect my agents in issue-1035", "Pause issue-1035 for everyone", "Edit description…", "Remove channel…", "Remove all messages…"]);
  });

  it("pauses and disconnects the person's own agents in that channel, and an Admin pauses it for everyone", async () => {
    const chat = fakeChat(chanWorld(true));
    page({ chat, me: ROOT });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Actions for issue-1035" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Pause my agents in issue-1035/ }));
    await flush();
    expect(chat.api.pause).toHaveBeenCalledWith("issue-1035", true);
    expect(screen.getByText("Paused.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actions for issue-1035" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Disconnect my agents in issue-1035/ }));
    await flush();
    expect(chat.api.disconnect).toHaveBeenCalledWith("issue-1035", true);
    fireEvent.click(screen.getByRole("button", { name: "Actions for issue-1035" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pause issue-1035 for everyone" }));
    await flush();
    expect(chat.api.pause).toHaveBeenCalledWith("issue-1035", true, true);
    expect(screen.getByText("issue-1035 is paused for everyone.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actions for issue-1035" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Resume issue-1035 for everyone" }));
    await flush();
    expect(screen.getByText("issue-1035 resumed.")).toBeInTheDocument();
  });

  it("says in the words when pausing a channel for everyone fails", async () => {
    const chat = fakeChat(chanWorld(true));
    chat.api.pause.mockRejectedValueOnce(new RespondError(500, { error: "The store is busy." }));
    page({ chat, me: ROOT });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Actions for issue-1035" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pause issue-1035 for everyone" }));
    await flush();
    expect(screen.getByTestId("chat-action-error")).toHaveTextContent("Could not change issue-1035: The store is busy. Nothing changed. Try again.");
  });

  it("removes the history of a public channel after a confirmation that says everyone loses it", async () => {
    const chat = fakeChat(chanWorld(true));
    page({ chat, me: ROOT });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Actions for issue-1035" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove all messages…" }));
    expect(screen.getByTestId("chat-confirm")).toHaveTextContent("Remove all 2 messages in issue-1035? Everyone loses the history, and it cannot be recovered.");
  });
});

describe("Remove channel (an Admin)", () => {
  const ask = async (chat: ReturnType<typeof fakeChat>) => {
    page({ chat, me: ROOT });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Actions for issue-1035" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove channel…" }));
  };

  it("asks first, in the mockup's words, and names who is told", async () => {
    await ask(fakeChat(chanWorld(true)));
    const c = screen.getByTestId("chat-confirm");
    expect(c).toHaveAttribute("role", "alertdialog");
    expect(c).toHaveTextContent("Remove the channel issue-1035? Its 2 messages are removed for everyone, and it cannot be recovered. Maya is told that an Admin removed it.");
    expect(screen.getByRole("button", { name: "Keep it" })).toHaveFocus();
  });

  it("removes the channel, goes back to General and says so", async () => {
    const chat = fakeChat(chanWorld(true));
    await ask(chat);
    fireEvent.click(screen.getByRole("button", { name: "Remove channel" }));
    await flush();
    expect(chat.api.removeChannel).toHaveBeenCalledWith("issue-1035");
    expect(screen.queryByTestId("chat-row-c:issue-1035")).toBeNull();
    expect(rowBtn("c:general")).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("Channel removed.")).toBeInTheDocument();
  });

  it("changes nothing on Keep it, and says what to do when the server refuses", async () => {
    const chat = fakeChat(chanWorld(true));
    await ask(chat);
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByTestId("chat-confirm")).toBeNull();
    expect(chat.api.removeChannel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Actions for issue-1035" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove channel…" }));
    chat.api.removeChannel.mockRejectedValueOnce(new RespondError(404, { error: "There is no such channel." }));
    fireEvent.click(screen.getByRole("button", { name: "Remove channel" }));
    await flush();
    expect(screen.getByTestId("chat-action-error")).toHaveTextContent("Could not remove the channel: There is no such channel. Nothing changed. Try again.");
  });

  it("leaves the opener out of the words when nobody opened the channel", async () => {
    const w = chanWorld(true);
    w.overview.channels[1] = channelOf("issue-1035", { description: "d", openedBy: null, messages: 1, can: ADMIN_CAN });
    await ask(fakeChat(w));
    expect(screen.getByTestId("chat-confirm")).toHaveTextContent(/^Remove the channel issue-1035\? Its 1 messages are removed for everyone, and it cannot be recovered\.Keep itRemove channel$/);
  });
});

describe("the New channel form", () => {
  const openForm = async (chat = fakeChat(chanWorld())) => {
    const p = page({ chat });
    await flush();
    const btn = screen.getByRole("button", { name: "New channel" });
    btn.focus();
    fireEvent.click(btn);
    await tick();
    return { chat, btn, p };
  };
  const field = (name: string) => within(screen.getByRole("dialog")).getByLabelText(name) as HTMLInputElement;
  const submit = async () => {
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create channel" }));
    await flush();
  };
  const banner = () => within(screen.getByRole("dialog")).getByRole("alert");

  it("opens a dialog with the fields, the privacy hint and the focus on Name", async () => {
    await openForm();
    const d = screen.getByRole("dialog", { name: "New channel" });
    expect(d).toHaveTextContent("Every person and Admin signed in to this server can read and post in a channel, and so can an orchestrator for the hour after an @ calls it in.");
    for (const l of ["Name", "Description", "About (optional)", "Which one"]) expect(within(d).getByLabelText(l)).toBeInTheDocument();
    expect([...(field("About (optional)") as unknown as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["Nothing", "Issue", "Milestone", "Project"]);
    expect(field("Name")).toHaveFocus();
    expect(within(d).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(d).queryByRole("alert")).toBeNull();
  });

  it("lowercases the name as it is typed and counts the description out of 280", async () => {
    await openForm();
    fireEvent.change(field("Name"), { target: { value: "Staging-Incident" } });
    expect(field("Name").value).toBe("staging-incident");
    expect(screen.getByRole("dialog")).toHaveTextContent("0 of 280");
    fireEvent.change(field("Description"), { target: { value: "hello" } });
    expect(screen.getByRole("dialog")).toHaveTextContent("5 of 280");
    expect(field("Description")).toHaveAttribute("maxlength", "280");
  });

  it("asks for a name, and refuses one the server would, before it asks the server", async () => {
    const { chat } = await openForm();
    await submit();
    expect(banner()).toHaveTextContent("Name the channel.");
    expect(field("Name")).toHaveAttribute("aria-invalid", "true");
    expect(field("Name")).toHaveFocus();
    fireEvent.change(field("Name"), { target: { value: "-bad" } });
    await submit();
    expect(banner()).toHaveTextContent("A name has lowercase letters, numbers and hyphens only, starts with a letter or a number, and is at most 40 characters.");
    expect(chat.api.createChannel).not.toHaveBeenCalled();
  });

  it("asks which issue, milestone or project when one is chosen and none is named", async () => {
    const { chat } = await openForm();
    fireEvent.change(field("Name"), { target: { value: "new-one" } });
    fireEvent.change(field("About (optional)"), { target: { value: "milestone" } });
    await submit();
    expect(banner()).toHaveTextContent("Say which milestone it is about, or choose Nothing.");
    expect(field("Which one")).toHaveAttribute("aria-invalid", "true");
    expect(field("Which one")).toHaveFocus();
    expect(chat.api.createChannel).not.toHaveBeenCalled();
  });

  it("creates the channel, selects it, closes the form, says so and leaves the focus on the thread", async () => {
    const { chat } = await openForm();
    fireEvent.change(field("Name"), { target: { value: "Staging-Incident" } });
    fireEvent.change(field("Description"), { target: { value: " What broke. " } });
    fireEvent.change(field("About (optional)"), { target: { value: "issue" } });
    fireEvent.change(field("Which one"), { target: { value: " #1035 " } });
    await submit();
    expect(chat.api.createChannel).toHaveBeenCalledWith("staging-incident", "What broke.", { kind: "issue", ref: "#1035" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rowBtn("c:staging-incident")).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("heading", { level: 2, name: /staging-incident/ })).toBeInTheDocument();
    expect(screen.getByText("Channel staging-incident created.")).toBeInTheDocument();
    await tick();
    expect(document.activeElement).toBe(document.getElementById("th-h"));
  });

  it("sends no link when About is Nothing", async () => {
    const { chat } = await openForm();
    fireEvent.change(field("Name"), { target: { value: "plain" } });
    await submit();
    expect(chat.api.createChannel).toHaveBeenCalledWith("plain", "", null);
  });

  const refused: [string, number, string, string, string][] = [
    ["a name that is taken", 409, "name-taken", "There is already a channel called issue-1035. Open it, or pick another name.", "Name"],
    ["a link that is taken", 409, "link-taken", "There is already a channel for issue #1035: issue-1035. Open it instead.", "Which one"],
    ["the limit", 409, "limit-reached", "This server has 50 channels besides General, the most it keeps. An Admin can remove one that is no longer used.", "banner"],
    ["a reserved name", 422, "reserved", "general is the name of a built-in channel.", "Name"],
    ["an invalid name", 422, "invalid", "The name must be 1 to 40 characters.", "Name"],
    ["an invalid link", 422, "invalid", "The link reference must be at most 100 characters.", "Which one"],
    ["a description that is too long", 422, "invalid", "The description must be at most 280 characters.", "Description"],
  ];
  for (const [what, status, reason, words, focus] of refused) {
    it(`shows the server's own words for ${what}, keeps the form and the draft, and focuses the field`, async () => {
      const { chat } = await openForm();
      chat.api.createChannel.mockRejectedValueOnce(new RespondError(status, { ok: false, error: words, reason }));
      fireEvent.change(field("Name"), { target: { value: "issue-1035" } });
      fireEvent.change(field("About (optional)"), { target: { value: "issue" } });
      fireEvent.change(field("Which one"), { target: { value: "#1035" } });
      await submit();
      expect(banner()).toHaveTextContent(words);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(field("Name").value).toBe("issue-1035");
      if (focus === "banner") {
        expect(banner()).toHaveFocus();
        expect(within(screen.getByRole("dialog")).getByLabelText("Name")).not.toHaveAttribute("aria-invalid");
      } else expect(field(focus)).toHaveFocus();
      expect(screen.getByRole("button", { name: "Create channel" })).toBeEnabled();
    });
  }

  it("says what went wrong and what to try when the server does not answer", async () => {
    const { chat } = await openForm();
    chat.api.createChannel.mockRejectedValueOnce(new Error("offline"));
    fireEvent.change(field("Name"), { target: { value: "one" } });
    await submit();
    expect(banner()).toHaveTextContent("Could not create the channel: the server did not answer. Nothing was saved. Try again.");
  });

  it("closes on Cancel, the X, Escape and a click on the dimmed area, each giving the focus back to New channel", async () => {
    const closers: [string, () => void][] = [
      ["Cancel", () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }))],
      ["the X", () => fireEvent.click(screen.getByRole("button", { name: "Close (Esc)" }))],
      ["Escape", () => fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })],
      ["the scrim", () => fireEvent.mouseDown(screen.getByRole("dialog").parentElement!)],
    ];
    const { btn } = await openForm();
    for (const [, close] of closers) {
      if (!screen.queryByRole("dialog")) {
        btn.focus();
        fireEvent.click(btn);
        await tick();
      }
      close();
      await tick();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(btn).toHaveFocus();
    }
  });

  it("passes the axe rules jsdom can judge, with an error showing", async () => {
    vi.useRealTimers();
    await openForm();
    await submit();
    const r = await axe.run(screen.getByRole("dialog"), AXE_RULES);
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  });
});

describe("Edit description", () => {
  const openEdit = async (chat = fakeChat(chanWorld())) => {
    page({ chat });
    await flush();
    const more = screen.getByRole("button", { name: "Actions for mine-chan" });
    more.focus();
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit description…" }));
    await tick();
    return chat;
  };

  it("opens the same form with the name fixed and the description filled in, focused", async () => {
    await openEdit();
    const d = screen.getByRole("dialog", { name: "Edit description" });
    expect(within(d).getByLabelText("Name")).toBeDisabled();
    expect(within(d).getByLabelText("Name")).toHaveValue("mine-chan");
    expect(within(d).getByLabelText("Description")).toHaveValue("Ed's own scratch channel.");
    expect(within(d).getByLabelText("Description")).toHaveFocus();
    expect(d).toHaveTextContent("A name cannot be changed after the channel is made.");
    expect(within(d).queryByLabelText("About (optional)")).toBeNull();
    expect(within(d).getByRole("button", { name: "Save description" })).toBeInTheDocument();
  });

  it("names the link it cannot change", async () => {
    const w = chanWorld();
    w.overview.channels[2] = channelOf("mine-chan", { description: "d", link: { kind: "project", ref: "podium" }, openedBy: "Ed", can: OWN_CAN });
    await openEdit(fakeChat(w));
    expect(screen.getByRole("dialog")).toHaveTextContent("Linked to Project podium. The link cannot be changed.");
  });

  it("saves the new description, shows it in the row and says so", async () => {
    const chat = await openEdit();
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: " A better line. " } });
    fireEvent.click(screen.getByRole("button", { name: "Save description" }));
    await flush();
    expect(chat.api.describeChannel).toHaveBeenCalledWith("mine-chan", "A better line.");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(row("c:mine-chan").querySelector(".sub")).toHaveTextContent("A better line.");
    expect(screen.getByText("Description saved.")).toBeInTheDocument();
    await tick();
    expect(document.activeElement).toBe(within(row("c:mine-chan")).getByRole("button", { name: "Actions for mine-chan" }));
  });

  it("shows the server's refusal and keeps the form", async () => {
    const chat = await openEdit();
    chat.api.describeChannel.mockRejectedValueOnce(new RespondError(403, { ok: false, error: "Only Ed or an Admin can change the description of mine-chan." }));
    fireEvent.click(screen.getByRole("button", { name: "Save description" }));
    await flush();
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("Only Ed or an Admin can change the description of mine-chan.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("passes the axe rules jsdom can judge", async () => {
    vi.useRealTimers();
    await openEdit();
    const r = await axe.run(screen.getByRole("dialog"), AXE_RULES);
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  });
});

describe("the New direct message form", () => {
  const withTargets = (targets: DirectTarget[] = TARGETS) => {
    const w = chanWorld();
    w.targets = targets;
    return fakeChat(w);
  };
  const openForm = async (chat = withTargets()) => {
    const p = page({ chat });
    await flush();
    const btn = screen.getByRole("button", { name: "New direct message" });
    btn.focus();
    fireEvent.click(btn);
    await flush();
    await tick();
    return { chat, btn, p };
  };
  const dlg = () => within(screen.getByRole("dialog", { name: "New direct message" }));
  const sendBtn = () => dlg().getByRole("button", { name: "Send message" });

  it("puts a + named New direct message, with the tip Start a direct message and no visible words, in the Direct Messages title", async () => {
    page({ chat: withTargets() });
    await flush();
    const b = screen.getByRole("button", { name: "New direct message" });
    expect(b).toHaveAttribute("aria-label", "New direct message");
    expect(b).toHaveTextContent("");
    expect(b).toHaveAccessibleDescription("Start a direct message");
    expect(b.closest("section")).toContainElement(screen.getByRole("heading", { name: /^Direct Messages/ }));
  });

  it("lists your agents, then other people's, hides an ended agent of another person and focuses the search", async () => {
    await openForm();
    const d = screen.getByRole("dialog");
    expect(within(d).getByRole("heading", { level: 3, name: "Your agents" })).toBeInTheDocument();
    expect(within(d).getByRole("heading", { level: 3, name: "Other people's agents" })).toBeInTheDocument();
    expect(within(d).getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual(["s-dash", "s-docs", "s-blocked"]);
    expect(within(d).queryByText(/old-agent/)).toBeNull();
    expect(within(d).getByLabelText(/claude-dashboard/)).toBeEnabled();
    expect(d).toHaveTextContent("Your orchestrator, running");
    expect(d).toHaveTextContent("Maya approves before it is delivered.");
    expect(dlg().getByLabelText("Find an agent or person")).toHaveFocus();
    expect(d).toHaveTextContent("A Direct Message is read only by you, the agent's owner and an Admin.");
    expect(d).toHaveTextContent("Another person's agent gets it only after its owner approves, in their My reporters.");
  });

  it("shows a target that cannot take a message disabled, with the server's reason", async () => {
    await openForm();
    const blocked = dlg().getByLabelText(/release-bot/);
    expect(blocked).toBeDisabled();
    expect(screen.getByRole("dialog")).toHaveTextContent("Maya removed the link to release-bot, so it takes no messages from you.");
  });

  it("searches as it is typed, asking the server, and says when nothing matches", async () => {
    const { chat } = await openForm();
    fireEvent.change(dlg().getByLabelText("Find an agent or person"), { target: { value: "docs" } });
    await flush();
    expect(chat.api.directTargets).toHaveBeenLastCalledWith("docs");
    expect(dlg().getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual(["s-docs"]);
    expect(screen.queryByRole("heading", { level: 3, name: "Your agents" })).toBeNull();
    fireEvent.change(dlg().getByLabelText("Find an agent or person"), { target: { value: "zzz" } });
    await flush();
    expect(screen.getByRole("dialog")).toHaveTextContent("No agent matches that.");
  });

  it("says so when no orchestrator is reporting", async () => {
    await openForm(withTargets([]));
    expect(screen.getByRole("dialog")).toHaveTextContent("No orchestrator is reporting yet.");
  });

  it("says what went wrong when the list cannot be read", async () => {
    const chat = withTargets();
    chat.api.directTargets.mockRejectedValueOnce(new RespondError(500, { error: "The store is busy." }));
    await openForm(chat);
    expect(dlg().getByRole("alert")).toHaveTextContent("Could not read who you can message: The store is busy. Try again.");
  });

  it("asks who to message, then for the first message, before it sends anything", async () => {
    const { chat } = await openForm();
    fireEvent.click(sendBtn());
    await flush();
    expect(dlg().getByRole("alert")).toHaveTextContent("Choose who to message.");
    expect(dlg().getByLabelText("Find an agent or person")).toHaveFocus();
    fireEvent.click(dlg().getByLabelText(/claude-dashboard/));
    fireEvent.click(sendBtn());
    await flush();
    expect(dlg().getByRole("alert")).toHaveTextContent("Write the first message.");
    expect(dlg().getByLabelText("Message")).toHaveFocus();
    expect(chat.api.sendDm).not.toHaveBeenCalled();
  });

  it("sends to your own agent, opens the conversation and says so", async () => {
    const { chat } = await openForm();
    fireEvent.click(dlg().getByLabelText(/claude-dashboard/));
    fireEvent.change(dlg().getByLabelText("Message"), { target: { value: " hello there " } });
    fireEvent.click(sendBtn());
    await flush();
    expect(chat.api.sendDm).toHaveBeenCalledWith("me", "s-dash", "hello there");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: /claude-dashboard/ })).toBeInTheDocument();
    expect(screen.getByText("Sent to claude-dashboard.")).toBeInTheDocument();
  });

  it("sends to another person's agent, selects the conversation and says it waits for the owner", async () => {
    const chat = withTargets();
    const cross: Cross = { person: "Ed", owner: "Maya", link: "waiting", viewerIs: "sender" };
    const docs = agent("s-docs", "docs-writer", "maya-laptop");
    chat.api.sendDm.mockImplementationOnce(async (_a: string, _b: string, text: string) => {
      chat.w.overview.directs.push(direct(ME, docs, { thread: "dm:person:ed|s-docs", owner: "Maya", messages: 1, state: "waiting", cross }));
      chat.w.dms["person:ed|s-docs"] = { messages: [dmsg("x1", ME, docs, text, { state: "approval", waitingFor: "Maya", to: [{ sessionId: "s-docs", name: "docs-writer", machine: "maya-laptop", state: "approval", why: null }] })] };
      return { ok: true as const, message: dmsg("x1", ME, docs, text, { state: "approval", waitingFor: "Maya" }), skipped: [], errors: [] };
    });
    await openForm(chat);
    fireEvent.click(dlg().getByLabelText(/docs-writer/));
    fireEvent.change(dlg().getByLabelText("Message"), { target: { value: "Run the notes through link-check?" } });
    fireEvent.click(sendBtn());
    await flush();
    expect(chat.api.sendDm).toHaveBeenCalledWith("me", "s-docs", "Run the notes through link-check?");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rowBtn("d:dm:person:ed|s-docs")).toHaveAttribute("aria-current", "true");
    expect(row("d:dm:person:ed|s-docs")).toHaveTextContent("Waiting for approval");
    expect(screen.getByText("Sent. It waits for Maya to approve it.")).toBeInTheDocument();
    expect(thread()).toHaveTextContent("Waiting for Maya to approve it.");
  });

  it("says what could not be delivered when the server sent the message but skipped or failed an agent", async () => {
    const chat = withTargets();
    chat.api.sendDm.mockResolvedValueOnce({ ok: true as const, message: dmsg("y1", ME, agent("s-dash", "claude-dashboard"), "hi", { state: "queued" }), skipped: [{ name: "claude-dashboard", why: "Its link is paused." }], errors: [{ name: "x", error: "no route" }] });
    await openForm(chat);
    fireEvent.click(dlg().getByLabelText(/claude-dashboard/));
    fireEvent.change(dlg().getByLabelText("Message"), { target: { value: "hi" } });
    fireEvent.click(sendBtn());
    await flush();
    expect(screen.getByText("Sent, but x: no route Its link is paused.")).toBeInTheDocument();
  });

  it("shows the server's refusal in the banner and keeps the form, with the draft", async () => {
    const { chat } = await openForm();
    chat.api.sendDm.mockRejectedValueOnce(new RespondError(422, { ok: false, error: "claude-dashboard's reporter does not take messages from Podium." }));
    fireEvent.click(dlg().getByLabelText(/claude-dashboard/));
    fireEvent.change(dlg().getByLabelText("Message"), { target: { value: "hello" } });
    fireEvent.click(sendBtn());
    await flush();
    expect(dlg().getByRole("alert")).toHaveTextContent("claude-dashboard's reporter does not take messages from Podium.");
    expect(dlg().getByLabelText("Message")).toHaveValue("hello");
    chat.api.sendDm.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(sendBtn());
    await flush();
    expect(dlg().getByRole("alert")).toHaveTextContent("Could not send the message: the server did not answer. Nothing was sent. Try again.");
  });

  it("closes on Cancel, Escape and the dimmed area, giving the focus back to the button", async () => {
    const { btn } = await openForm();
    for (const close of [() => fireEvent.click(dlg().getByRole("button", { name: "Cancel" })), () => fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }), () => fireEvent.mouseDown(screen.getByRole("dialog").parentElement!)]) {
      if (!screen.queryByRole("dialog")) {
        btn.focus();
        fireEvent.click(btn);
        await flush();
      }
      close();
      await tick();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(btn).toHaveFocus();
    }
  });

  it("ignores an answer to an older search, whether it lands or fails after the newer one", async () => {
    const chat = withTargets();
    let late: (v: { ok: true; targets: DirectTarget[] }) => void = () => {};
    let lateFail: (e: unknown) => void = () => {};
    chat.api.directTargets.mockImplementation(async (q = "") => {
      if (q === "a") return new Promise((res) => (late = res));
      if (q === "b") return new Promise((_, rej) => (lateFail = rej));
      return { ok: true as const, targets: TARGETS.filter((t) => t.name.includes(q)) };
    });
    await openForm(chat);
    fireEvent.change(dlg().getByLabelText("Find an agent or person"), { target: { value: "a" } });
    fireEvent.change(dlg().getByLabelText("Find an agent or person"), { target: { value: "b" } });
    fireEvent.change(dlg().getByLabelText("Find an agent or person"), { target: { value: "docs" } });
    await flush();
    expect(dlg().getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual(["s-docs"]);
    await act(async () => {
      late({ ok: true, targets: [] });
      lateFail(new Error("offline"));
    });
    expect(dlg().getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual(["s-docs"]);
    expect(dlg().queryByText(/Could not read who you can message/)).toBeNull();
  });

  it("falls back to the owner's name when the server names nobody to approve, and to plain words when it gives no reason", async () => {
    const chat = withTargets([TARGETS[1]!, { ...TARGETS[3]!, why: null }]);
    chat.api.sendDm.mockResolvedValueOnce({ ok: true as const, message: dmsg("z1", ME, agent("s-docs", "docs-writer", "maya-laptop"), "hi", { state: "approval" }), skipped: [], errors: [] });
    await openForm(chat);
    expect(screen.getByRole("dialog")).toHaveTextContent("It takes no messages now.");
    fireEvent.click(dlg().getByLabelText(/docs-writer/));
    fireEvent.change(dlg().getByLabelText("Message"), { target: { value: "hi" } });
    fireEvent.click(sendBtn());
    await flush();
    expect(screen.getByText("Sent. It waits for Maya to approve it.")).toBeInTheDocument();
  });

  it("is not offered to an Admin who is reading a person", async () => {
    const w = chanWorld();
    w.overview.me = { name: "Root", admin: true, person: false };
    w.overview.people = [{ name: "Ed", you: false }, { name: "Maya", you: false }];
    w.owners = { Maya: { channels: [channelOf("general", { can: ADMIN_CAN })], directs: [] } };
    page({ chat: fakeChat(w), me: ROOT });
    await flush();
    fireEvent.change(screen.getByLabelText("Read a person's conversations"), { target: { value: "Maya" } });
    await flush();
    expect(screen.getByRole("heading", { name: /^Direct Messages/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New direct message" })).toBeNull();
  });

  it("passes the axe rules jsdom can judge, with an error showing", async () => {
    vi.useRealTimers();
    await openForm();
    fireEvent.click(sendBtn());
    await flush();
    const r = await axe.run(screen.getByRole("dialog"), AXE_RULES);
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  });
});

describe("a refusal that is not about a field (#1035)", () => {
  const dlg = () => within(screen.getByRole("dialog"));
  const anyInvalid = () => screen.getByRole("dialog").querySelectorAll('[aria-invalid="true"]').length;
  const limited = () => new RespondError(429, { ok: false, error: "Too many requests. Wait a minute and try again." });

  it("in create mode shows a 429 in the banner, focuses the banner and marks no field invalid", async () => {
    const chat = fakeChat(chanWorld());
    chat.api.createChannel.mockRejectedValueOnce(limited());
    page({ chat });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "New channel" }));
    await tick();
    fireEvent.change(dlg().getByLabelText("Name"), { target: { value: "fine-name" } });
    fireEvent.click(dlg().getByRole("button", { name: "Create channel" }));
    await flush();
    const banner = dlg().getByRole("alert");
    expect(banner).toHaveTextContent("Too many requests. Wait a minute and try again.");
    expect(banner).toHaveFocus();
    expect(anyInvalid()).toBe(0);
  });

  it("in edit mode shows a 429 in the banner, keeps the focus in the dialog and never marks the disabled name", async () => {
    const chat = fakeChat(chanWorld());
    chat.api.describeChannel.mockRejectedValueOnce(limited());
    page({ chat });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Actions for mine-chan" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit description…" }));
    await tick();
    fireEvent.click(dlg().getByRole("button", { name: "Save description" }));
    await flush();
    const banner = dlg().getByRole("alert");
    expect(banner).toHaveTextContent("Too many requests. Wait a minute and try again.");
    expect(banner).toHaveFocus();
    expect(dlg().getByLabelText("Name")).not.toHaveAttribute("aria-invalid");
    expect(anyInvalid()).toBe(0);
  });

  it("in edit mode puts an invalid description on the description, and a network failure in the banner", async () => {
    const chat = fakeChat(chanWorld());
    chat.api.describeChannel.mockRejectedValueOnce(new RespondError(422, { ok: false, error: "The description is too long.", reason: "invalid" }));
    page({ chat });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Actions for mine-chan" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit description…" }));
    await tick();
    fireEvent.click(dlg().getByRole("button", { name: "Save description" }));
    await flush();
    expect(dlg().getByLabelText("Description")).toHaveAttribute("aria-invalid", "true");
    expect(dlg().getByLabelText("Description")).toHaveFocus();
    expect(dlg().getByLabelText("Name")).not.toHaveAttribute("aria-invalid");
    chat.api.describeChannel.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(dlg().getByRole("button", { name: "Save description" }));
    await flush();
    expect(dlg().getByRole("alert")).toHaveFocus();
    expect(anyInvalid()).toBe(0);
  });

  it("an unknown reason in create mode is a banner too, and a reserved name still marks the name", async () => {
    const chat = fakeChat(chanWorld());
    chat.api.createChannel.mockRejectedValueOnce(new RespondError(409, { ok: false, error: "Something else.", reason: "mystery" }));
    page({ chat });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "New channel" }));
    await tick();
    fireEvent.change(dlg().getByLabelText("Name"), { target: { value: "general" } });
    fireEvent.click(dlg().getByRole("button", { name: "Create channel" }));
    await flush();
    expect(dlg().getByRole("alert")).toHaveFocus();
    expect(anyInvalid()).toBe(0);
    chat.api.createChannel.mockRejectedValueOnce(new RespondError(422, { ok: false, error: "general is built in.", reason: "reserved" }));
    fireEvent.click(dlg().getByRole("button", { name: "Create channel" }));
    await flush();
    expect(dlg().getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
    expect(dlg().getByLabelText("Name")).toHaveFocus();
  });
});

describe("message rows, one bubble, dividers and code blocks (#1232)", () => {
  const MIN = 60_000;
  const DAY = 86_400_000;
  const general = (messages: ChannelMessage[], unread = 0) => {
    const w = world();
    w.channels.general = { messages };
    w.overview.channels = w.overview.channels.map((c) => (c.id === "general" ? { ...c, unread, messages: messages.length } : c));
    return fakeChat(w);
  };
  const maya = (id: string, text: string, at: number, over: Partial<ChannelMessage> = {}) => cmsg(id, text, { mine: false, authorName: "Maya", authorRef: "Maya", createdAt: at, updatedAt: at, ...over });
  const rows = () => within(thread()).getAllByTestId("chat-message");
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

  it("shares one avatar, name and time across a run, and starts another for a new sender, a gap over five minutes or a new day", async () => {
    page({
      chat: general([
        maya("a", "first", T0 - DAY - 5 * MIN),
        maya("b", "second", T0 - 9 * MIN),
        maya("c", "third", T0 - 7 * MIN),
        maya("d", "after a gap", T0 - MIN),
        cmsg("e", "mine", { createdAt: T0 - 30_000 }),
      ]),
    });
    await flush();
    await open("c:general");
    const r = rows();
    expect(r.map((x) => (x.classList.contains("cont") ? "cont" : "first"))).toEqual(["first", "first", "cont", "first", "first"]);
    expect(r[1]!.querySelector(".ch-av.person")).not.toBeNull();
    expect(r[1]!.querySelector(".who")).toHaveTextContent("Maya");
    expect(r[2]!.querySelector(".ch-av, .who, .at")).toBeNull();
    expect(r[2]!.querySelector(".ch-gut")).toHaveTextContent(/^\d\d:\d\d$/);
    expect(r[2]!.querySelector(".ch-tx")).toHaveTextContent("third");
  });

  it("puts your messages on the right in the same bubble as everyone's, with the inverted disc and You", async () => {
    page({ chat: general([maya("a", "hello", T0 - 5 * MIN), cmsg("b", "hi back", { createdAt: T0 - 4 * MIN })]) });
    await flush();
    await open("c:general");
    const [theirs, mine] = rows();
    expect(theirs).not.toHaveClass("mine");
    expect(mine).toHaveClass("mine");
    expect(mine!.querySelector(".ch-av.me")).not.toBeNull();
    expect(mine!.querySelector(".who")).toHaveTextContent("You");
    expect(mine!.querySelector(".ch-tx")!.className).toBe(theirs!.querySelector(".ch-tx")!.className);
  });

  it("draws an agent as a tile with its model and state, and says Agent and the model beside the name", async () => {
    page({ chat: general([cmsg("a", "On it.", { mine: false, authorKind: "orchestrator", authorName: "Tester", authorRef: "s-tester", createdAt: T0 - MIN })]) });
    await flush();
    await open("c:general");
    const m = rows()[0]!;
    expect(m.querySelector(".ch-av.agent")).not.toBeNull();
    expect(m.querySelector(".chip.model")).toHaveTextContent(/^Agent · /);
  });

  it("draws a day divider for Yesterday and Today, and a New line at the first unread message with the word", async () => {
    page({ chat: general([maya("a", "old", T0 - DAY), maya("b", "read", T0 - 3 * MIN), maya("c", "unread one", T0 - 2 * MIN), maya("d", "unread two", T0 - MIN)], 2) });
    await flush();
    await open("c:general");
    const flow = [...thread().querySelectorAll("ol.ch-msgs > li")].map((li) => (li.classList.contains("ch-day") ? `day:${li.textContent}` : li.classList.contains("ch-newline") ? `new:${li.textContent}` : `msg:${li.querySelector(".ch-tx")?.textContent}`));
    expect(flow).toEqual(["day:Yesterday", "msg:old", "day:Today", "msg:read", "new:New", "msg:unread one", "msg:unread two"]);
  });

  it("draws no New line when nothing was unread, and keeps it where it was after the thread is read", async () => {
    const p = page({ chat: general([maya("a", "one", T0 - 3 * MIN), maya("b", "two", T0 - 2 * MIN), maya("c", "three", T0 - MIN)], 1) });
    await flush();
    await open("c:general");
    expect(thread().querySelectorAll(".ch-newline")).toHaveLength(1);
    p.chat.w.overview.channels = p.chat.w.overview.channels.map((c) => (c.id === "general" ? { ...c, unread: 0 } : c));
    p.signal();
    await flush();
    expect(thread().querySelectorAll(".ch-newline")).toHaveLength(1);
    await open("c:group");
    expect(thread().querySelectorAll(".ch-newline")).toHaveLength(0);
  });

  it("draws a fenced block as text in a focusable monospace block with its language word, and a tag in a message as text", async () => {
    const text = "run it:\n```sh\nnpm test <script>alert(1)</script>\n```\ndone `x`";
    page({ chat: general([maya("a", text, T0 - MIN)]) });
    await flush();
    await open("c:general");
    const block = within(thread()).getByTestId("chat-code");
    const pre = block.querySelector("pre")!;
    expect(pre).toHaveAttribute("tabindex", "0");
    expect(pre.querySelector("code")!.textContent).toBe("npm test <script>alert(1)</script>");
    expect(block).toHaveTextContent("sh");
    expect(thread().querySelector("script")).toBeNull();
    expect(rows()[0]!.querySelector(".ch-inline")).toHaveTextContent("x");
    // The line break against the block is its edge, not a blank line.
    expect(rows()[0]!.querySelector(".ch-tx")!.firstChild!.textContent).toBe("run it:");
  });

  it("copies a block and says Copied, or says Select and copy when the clipboard is refused or missing", async () => {
    page({ chat: general([maya("a", "```\nls\n```", T0 - MIN)]) });
    await flush();
    await open("c:general");
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const copy = () => within(thread()).getByRole("button", { name: /Copy|Copied|Select and copy/ });
    fireEvent.click(copy());
    await flush();
    expect(writeText).toHaveBeenCalledWith("ls");
    expect(copy()).toHaveTextContent("Copied");
    writeText.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(copy());
    await flush();
    expect(copy()).toHaveTextContent("Select and copy");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    fireEvent.click(copy());
    await flush();
    expect(copy()).toHaveTextContent("Select and copy");
    await settle();
    await settle();
  });

  it("shows a message that was not delivered in the critical color with the icon and the words", async () => {
    page({ chat: general([cmsg("a", "go @Tester@ci-runner-01", { mentions: [{ typed: "Tester@ci-runner-01", sessionId: "s-tester", state: "not-delivered", why: "it ended", stateAt: T0 }] })]) });
    await flush();
    await open("c:general");
    const bad = rows()[0]!.querySelector(".ds.bad")!;
    expect(bad).toHaveTextContent("Not delivered to Tester");
    expect(bad.querySelector("svg")).not.toBeNull();
  });

  describe("the live region", () => {
    const log = () => within(thread()).getByRole("log", { name: "Messages" });
    it("is a polite log of additions, and does not announce what loads with the conversation", async () => {
      page({ chat: general([maya("a", "history", T0 - MIN)]) });
      await flush();
      await open("c:general");
      expect(log()).toHaveAttribute("aria-live", "off");
      expect(log()).toHaveAttribute("aria-relevant", "additions");
      expect(log()).toHaveAttribute("aria-atomic", "false");
      await settle();
      expect(log()).toHaveAttribute("aria-live", "polite");
    });

    it("announces a message that arrives while the conversation is open", async () => {
      const p = page({ chat: general([maya("a", "history", T0 - MIN)]) });
      await flush();
      await open("c:general");
      await settle();
      p.chat.w.channels.general!.messages.push(maya("b", "arrived", T0));
      p.signal();
      await flush();
      expect(log()).toHaveAttribute("aria-live", "polite");
      expect(rows()).toHaveLength(2);
      await settle();
      expect(log()).toHaveAttribute("aria-live", "polite");
    });

    it("does not announce a message the person has just sent, a record line or earlier messages", async () => {
      const w = world();
      w.channels.general = { messages: [maya("a", "history", T0 - MIN)] };
      const p = page({ chat: fakeChat(w) });
      await flush();
      await open("c:general");
      await settle();
      w.channels.general!.messages.push(cmsg("m", "mine", { createdAt: T0 }));
      p.signal();
      await flush();
      expect(log()).toHaveAttribute("aria-live", "off");
      await settle();
      expect(log()).toHaveAttribute("aria-live", "polite");
    });
    it("does not announce earlier messages a person asks for", async () => {
      page();
      await flush();
      await open("d:dm:s-dash|s-tester");
      await settle();
      expect(log()).toHaveAttribute("aria-live", "polite");
      fireEvent.click(within(thread()).getByRole("button", { name: "Earlier messages" }));
      await flush();
      expect(within(thread()).getAllByTestId("chat-message")[0]).toHaveTextContent("An older message.");
      expect(log()).toHaveAttribute("aria-live", "off");
      await settle();
      expect(log()).toHaveAttribute("aria-live", "polite");
    });

    it("does not announce a record line an Admin's reading leaves", async () => {
      const w = world();
      const p = page({ chat: fakeChat(w) });
      await flush();
      await open("d:dm:s-dash|s-tester");
      await settle();
      w.reads = { "s-dash|s-tester": [{ admin: "Root", startedAt: T0, lastSeenAt: T0 }] };
      p.signal();
      await flush();
      expect(within(thread()).getByTestId("chat-record")).toBeInTheDocument();
      expect(log()).toHaveAttribute("aria-live", "off");
      await settle();
    });
  });
});

// ---- The sidebar redesign (#1234, mockup/podium-chat-redesign.html) ---------------------------------------------------------
describe("the redesigned sidebar", () => {
  const nav = () => screen.getByRole("navigation", { name: "Chat" });
  const section = (id: string) => nav().querySelector(`section:has(#sec-${id})`) as HTMLElement;
  const fold = (id: string) => within(section(id)).getAllByRole("button")[0]!;

  it("folds a section from its title: aria-expanded flips, the count stays, and the others do not move", async () => {
    page();
    await flush();
    const f = fold("ch");
    expect(f).toHaveAttribute("aria-expanded", "true");
    expect(f).toHaveAttribute("aria-controls", "list-ch");
    expect(nav().querySelector("#list-ch")).toBeInTheDocument();
    fireEvent.click(f);
    expect(f).toHaveAttribute("aria-expanded", "false");
    expect(section("ch")).toHaveClass("shut");
    expect(section("dm")).not.toHaveClass("shut");
    expect(f.querySelector(".ch-count")).toHaveTextContent("2");
    fireEvent.click(f);
    expect(f).toHaveAttribute("aria-expanded", "true");
    expect(section("ch")).not.toHaveClass("shut");
  });

  it("counts the rows of each section in its title", async () => {
    page();
    await flush();
    expect(fold("ch").querySelector(".ch-count")).toHaveTextContent("2");
    expect(fold("dm").querySelector(".ch-count")).toHaveTextContent("3");
    // three orchestrators and the one other person
    expect(fold("pe").querySelector(".ch-count")).toHaveTextContent("4");
  });

  it("shows the + tip on hover and on keyboard focus, takes no tab stop of its own, and hides it on blur", async () => {
    page();
    await flush();
    const btn = screen.getByRole("button", { name: "New channel" });
    const wrap = btn.closest(".ch-addwrap") as HTMLElement;
    expect(wrap).not.toHaveAttribute("tabindex");
    const tip = within(wrap).getByRole("tooltip", { hidden: true });
    expect(tip).toHaveTextContent("Create a channel");
    expect(tip).not.toBeVisible();
    fireEvent.mouseEnter(wrap);
    expect(tip).toBeVisible();
    fireEvent.mouseLeave(wrap);
    expect(tip).not.toBeVisible();
    fireEvent.focus(btn);
    expect(tip).toBeVisible();
    fireEvent.blur(btn);
    expect(tip).not.toBeVisible();
    expect(btn).toHaveAttribute("aria-describedby", expect.stringContaining(tip.id));
  });

  it("gives an Admin who reads a person no + in Direct Messages and a + in Channels", async () => {
    const w = world();
    w.overview.me = { name: "Root", admin: true, person: false };
    page({ chat: fakeChat(w), me: ROOT });
    await flush();
    expect(screen.getByRole("button", { name: "New channel" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New direct message" })).toBeNull();
  });

  it("draws one agent's tile for a conversation with one agent, and an overlapped pair for two parties", async () => {
    const w = world();
    const across = direct({ ...ME, sessionId: "person:maya", name: "Maya Kim" }, agent("s-mb", "maya-main", "maya-mbp"), { thread: "dm:person:maya|s-mb", owner: "Ed", cross: { person: "Maya Kim", owner: "Ed", link: "open", viewerIs: "owner" } });
    w.overview.directs = [...w.overview.directs, across];
    page({ chat: fakeChat(w) });
    await flush();
    const own = rowBtn("d:dm:person:ed|s-notes");
    expect(own.querySelector(".ch-av-pair")).toBeNull();
    expect(own.querySelector(".ch-av.agent .ch-av-st")).toBeInTheDocument();
    const link = rowBtn("d:dm:s-dash|s-tester");
    expect(link.querySelectorAll(".ch-av-pair .ch-av.agent")).toHaveLength(2);
    const cross = rowBtn("d:dm:person:maya|s-mb");
    const kinds = [...cross.querySelectorAll(".ch-av-pair .ch-av")].map((e) => (e.classList.contains("person") ? "person" : "agent"));
    expect(kinds).toEqual(["person", "agent"]);
    expect(cross.querySelector(".nm")).toHaveTextContent("Maya Kim, maya-main");
    expect(cross.querySelector(".sub")).toHaveTextContent("Maya Kim and your agent");
  });

  it("draws a plain conversation icon for a conversation with no agent in it", async () => {
    const w = world();
    w.overview.directs = [direct(ME, { ...ME, sessionId: "person:x", name: "Xi" }, { thread: "dm:person:ed|person:x" })];
    page({ chat: fakeChat(w) });
    await flush();
    const r = rowBtn("d:dm:person:ed|person:x");
    expect(r.querySelector(".ic-wrap svg")).toBeInTheDocument();
    expect(r.querySelector(".ch-av")).toBeNull();
  });

  it("marks a row with unread messages or mentions so its name is bold", async () => {
    page();
    await flush();
    expect(row("d:dm:s-dash|s-tester")).toHaveClass("un");
    expect(row("c:group")).toHaveClass("un");
    expect(row("c:general")).not.toHaveClass("un");
    expect(row("d:dm:person:ed|s-notes")).not.toHaveClass("un");
  });

  it("lists the other people in People and agents, not you, each with a menu that offers Message and Mention", async () => {
    page();
    await flush();
    expect(screen.queryByTestId("chat-row-p:Ed")).toBeNull();
    const r = row("p:Maya");
    expect(r.closest("section")).toContainElement(screen.getByRole("heading", { name: /^People and agents/ }));
    expect(r).toHaveTextContent("Maya");
    expect(r).toHaveTextContent("Person");
    expect(r.querySelector(".ch-av.person")).toBeInTheDocument();
    fireEvent.click(within(r).getByRole("button", { name: "Actions for Maya" }));
    const menu = screen.getByTestId("chat-menu");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Message Maya", "Mention Maya"]);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByTestId("chat-menu")).toBeNull();
    fireEvent.contextMenu(r);
    expect(screen.getByTestId("chat-menu")).toBeInTheDocument();
  });

  it("opens New direct message with the person's name searched, from the row and from its menu", async () => {
    const w = world();
    w.targets = TARGETS;
    const chat = fakeChat(w);
    page({ chat });
    await flush();
    fireEvent.click(rowBtn("p:Maya"));
    await flush();
    const dlg = within(screen.getByRole("dialog", { name: "New direct message" }));
    expect(dlg.getByLabelText("Find an agent or person")).toHaveValue("Maya");
    expect(chat.api.directTargets).toHaveBeenLastCalledWith("Maya");
    expect(dlg.getAllByRole("radio").map((x) => (x as HTMLInputElement).value)).toEqual(["s-docs", "s-blocked"]);
    // Her one orchestrator that takes a message is chosen, the one that cannot is not, and the message box has the focus.
    expect(dlg.getByRole("radio", { name: /docs-writer/ })).toBeChecked();
    expect(dlg.getByRole("radio", { name: /release-bot/ })).not.toBeChecked();
    await waitFor(() => expect(dlg.getByLabelText("Message")).toHaveFocus());
    fireEvent.change(dlg.getByLabelText("Message"), { target: { value: "half a draft" } });
    fireEvent.click(dlg.getByRole("button", { name: "Cancel" }));
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(row("p:Maya")).getByRole("button", { name: "Actions for Maya" }));
    fireEvent.click(within(screen.getByTestId("chat-menu")).getByRole("menuitem", { name: "Message Maya" }));
    await flush();
    expect(within(screen.getByRole("dialog")).getByLabelText("Find an agent or person")).toHaveValue("Maya");
    // Closing reset the draft: this dialog starts with an empty message box.
    expect(within(screen.getByRole("dialog")).getByLabelText("Message")).toHaveValue("");
  });

  it("chooses nothing and keeps the focus on the search when a person has two orchestrators that take a message", async () => {
    const w = world();
    w.targets = [TARGETS[1], { ...TARGETS[1], sessionId: "s-two", name: "docs-two", thread: "dm:person:ed|s-two" }];
    page({ chat: fakeChat(w) });
    await flush();
    fireEvent.click(rowBtn("p:Maya"));
    await flush();
    const dlg = within(screen.getByRole("dialog", { name: "New direct message" }));
    expect(dlg.getAllByRole("radio")).toHaveLength(2);
    for (const r of dlg.getAllByRole("radio")) expect(r).not.toBeChecked();
    await waitFor(() => expect(dlg.getByLabelText("Find an agent or person")).toHaveFocus());
  });

  it("does not choose over a pick the person made after the dialog opened", async () => {
    const w = world();
    w.targets = TARGETS;
    page({ chat: fakeChat(w) });
    await flush();
    fireEvent.click(rowBtn("p:Maya"));
    await flush();
    const dlg = within(screen.getByRole("dialog", { name: "New direct message" }));
    fireEvent.change(dlg.getByLabelText("Find an agent or person"), { target: { value: "docs" } });
    await flush();
    expect(dlg.getByRole("radio", { name: /docs-writer/ })).toBeChecked();
  });

  it("still offers Message on a person with no orchestrator that takes one, and the dialog says why", async () => {
    const w = world();
    w.targets = [];
    page({ chat: fakeChat(w) });
    await flush();
    fireEvent.click(rowBtn("p:Maya"));
    await flush();
    expect(screen.getByRole("dialog")).toHaveTextContent("Maya has no orchestrator that takes a message now.");
  });

  describe("a row's menu placement", () => {
    const rects = (menuBottom: number) =>
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        const r = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
        if (this.classList.contains("ch-side")) return r(0, 100);
        if (this.classList.contains("ch-menu")) return r(menuBottom - 40, menuBottom);
        if (this.classList.contains("ch-item")) return r(menuBottom - 70, menuBottom - 40);
        return r(0, 0);
      });
    afterEach(() => vi.restoreAllMocks());

    it("opens under the row", async () => {
      rects(60);
      page();
      await flush();
      fireEvent.click(within(row("c:general")).getByRole("button", { name: "Actions for General" }));
      expect(screen.getByTestId("chat-menu")).not.toHaveClass("up");
    });

    it("flips up when it would run past the bottom of the sidebar", async () => {
      rects(300);
      page();
      await flush();
      fireEvent.click(within(row("c:general")).getByRole("button", { name: "Actions for General" }));
      expect(screen.getByTestId("chat-menu")).toHaveClass("up");
    });
  });
});


describe("the menu on a sender's avatar (#1235)", () => {
  const MIN = 60_000;
  const maya = (id: string, text: string, over: Partial<ChannelMessage> = {}) => cmsg(id, text, { mine: false, authorName: "Maya", authorRef: "Maya", createdAt: T0 - 9 * MIN, updatedAt: T0 - 9 * MIN, ...over });
  const tester = (id: string, text: string) => cmsg(id, text, { mine: false, authorKind: "orchestrator", authorName: "Tester", authorRef: "s-tester", createdAt: T0 - 8 * MIN, updatedAt: T0 - 8 * MIN });
  const generalWith = (messages: ChannelMessage[], targets: DirectTarget[] = []) => {
    const w = world();
    w.channels.general = { messages };
    w.overview.channels = w.overview.channels.map((c) => (c.id === "general" ? { ...c, messages: messages.length } : c));
    w.targets = targets;
    return fakeChat(w);
  };
  const msgs = () => within(thread()).getAllByTestId("chat-message");
  const gutOf = (m: HTMLElement) => m.querySelector(".ch-gut") as HTMLElement;
  const item = (name: string) => within(screen.getByTestId("chat-menu")).getByRole("menuitem", { name });
  const items = () => within(screen.getByTestId("chat-menu")).getAllByRole("menuitem").map((i) => i.textContent);

  it("offers Message and Mention on a person's avatar, and Message opens New direct message with her orchestrator chosen", async () => {
    page({ chat: generalWith([maya("a", "hello")], TARGETS.slice(0, 2)) });
    await flush();
    fireEvent.contextMenu(gutOf(msgs()[0]!), { clientX: 120, clientY: 200 });
    expect(items()).toEqual(["Message Maya", "Mention Maya"]);
    // It hangs at the pointer, fixed, inside the page's own wrapper.
    const menu = screen.getByTestId("chat-menu");
    expect(menu).toHaveClass("at");
    expect(menu).toHaveStyle({ left: "120px", top: "200px" });
    expect(menu.closest(".podium, .adminv")).not.toBeNull();
    fireEvent.click(item("Message Maya"));
    await flush();
    const dlg = within(screen.getByRole("dialog", { name: "New direct message" }));
    expect(dlg.getByLabelText("Find an agent or person")).toHaveValue("Maya");
    expect(dlg.getByRole("radio", { name: /docs-writer/ })).toBeChecked();
  });

  it("opens the dialog and says why when the person has no orchestrator that takes a message", async () => {
    page({ chat: generalWith([maya("a", "hello")], []) });
    await flush();
    fireEvent.contextMenu(gutOf(msgs()[0]!));
    fireEvent.click(item("Message Maya"));
    await flush();
    const dlg = within(screen.getByRole("dialog", { name: "New direct message" }));
    expect(dlg.getByText("Maya has no orchestrator that takes a message now.")).toBeInTheDocument();
    expect(dlg.queryAllByRole("radio")).toHaveLength(0);
  });

  it("writes the person's address at the caret in the message box and focuses it", async () => {
    page({ chat: generalWith([maya("a", "hello")]) });
    await flush();
    const box = screen.getByTestId("chat-box") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "ping later" } });
    box.setSelectionRange(4, 4);
    fireEvent.contextMenu(gutOf(msgs()[0]!));
    fireEvent.click(item("Mention Maya"));
    await flush();
    expect(box.value).toBe("ping @Maya@console later");
    expect(box).toHaveFocus();
    expect(box.selectionStart).toBe("ping @Maya@console ".length);
    // A second Mention is a second request.
    fireEvent.contextMenu(gutOf(msgs()[0]!));
    fireEvent.click(item("Mention Maya"));
    await flush();
    expect(box.value).toBe("ping @Maya@console @Maya@console later");
  });

  it("offers an agent Message, Mention and Open orchestration page, as its sidebar row does", async () => {
    page({ chat: generalWith([tester("t", "done")]) });
    await flush();
    fireEvent.contextMenu(gutOf(msgs()[0]!));
    expect(items()).toEqual(["Message Tester", "Mention Tester", "Open orchestration page"]);
    expect(item("Open orchestration page")).toHaveAttribute("href", "#/?open=s-tester");
    fireEvent.click(item("Mention Tester"));
    await flush();
    expect((screen.getByTestId("chat-box") as HTMLTextAreaElement).value).toBe("@Tester@ci-runner-01 ");
  });

  it("starts a conversation with an agent the person owns, and finds one they do not by its name", async () => {
    const stranger = cmsg("z", "from elsewhere", { mine: false, authorKind: "orchestrator", authorName: "docs-writer", authorRef: "s-docs", createdAt: T0 - 7 * MIN, updatedAt: T0 - 7 * MIN });
    page({ chat: generalWith([tester("t", "done"), stranger], TARGETS.slice(0, 2)) });
    await flush();
    fireEvent.contextMenu(gutOf(msgs()[0]!));
    fireEvent.click(item("Message Tester"));
    await flush();
    expect(within(thread()).getByRole("heading", { level: 2 })).toHaveTextContent("Tester");
    await open("c:general");
    fireEvent.contextMenu(gutOf(msgs()[1]!));
    fireEvent.click(item("Message docs-writer"));
    await flush();
    expect(within(screen.getByRole("dialog", { name: "New direct message" })).getByLabelText("Find an agent or person")).toHaveValue("docs-writer");
  });

  it("gives your own avatar no menu", async () => {
    page({ chat: generalWith([cmsg("m", "mine", { createdAt: T0 - MIN, updatedAt: T0 - MIN })]) });
    await flush();
    fireEvent.contextMenu(gutOf(msgs()[0]!));
    expect(screen.queryByTestId("chat-menu")).toBeNull();
    fireEvent.keyDown(msgs()[0]!, { key: "Enter" });
    expect(screen.queryByTestId("chat-menu")).toBeNull();
  });

  it("keeps the list to one tab stop, opens from the keyboard under the avatar, moves, closes on Esc with focus back, and on Tab", async () => {
    const list = Array.from({ length: 12 }, (_, i) => (i % 2 ? tester(`t${i}`, `t ${i}`) : maya(`m${i}`, `m ${i}`)));
    page({ chat: generalWith(list) });
    await flush();
    const all = msgs();
    expect(all.filter((m) => m.tabIndex === 0)).toHaveLength(1);
    all[0]!.focus();
    fireEvent.keyDown(all[0]!, { key: "ArrowDown" });
    expect(all[1]).toHaveFocus();
    spyRect(gutOf(all[1]!), { left: 40, bottom: 300, top: 260 });
    fireEvent.keyDown(all[1]!, { key: "ContextMenu" });
    const menu = screen.getByTestId("chat-menu");
    expect(menu).toHaveStyle({ left: "40px", top: "300px" });
    await waitFor(() => expect(within(menu).getAllByRole("menuitem")[0]).toHaveFocus());
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(within(menu).getAllByRole("menuitem")[1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByTestId("chat-menu")).toBeNull();
    await waitFor(() => expect(all[1]).toHaveFocus());
    fireEvent.keyDown(all[1]!, { key: "F10", shiftKey: true });
    expect(screen.getByTestId("chat-menu")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("chat-menu"), { key: "Tab" });
    expect(screen.queryByTestId("chat-menu")).toBeNull();
    vi.restoreAllMocks();
  });

  it("flips above the avatar near the bottom of the window and stays inside it", async () => {
    page({ chat: generalWith([maya("a", "hello")]) });
    await flush();
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.classList.contains("ch-menu") ? ({ top: 0, left: 0, bottom: 90, right: 200, width: 200, height: 90, x: 0, y: 0, toJSON: () => ({}) } as DOMRect) : ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    });
    const bottom = window.innerHeight - 20;
    const el = gutOf(msgs()[0]!);
    fireEvent.contextMenu(el, { clientX: window.innerWidth - 5, clientY: bottom });
    const menu = screen.getByTestId("chat-menu");
    // Past the bottom and the right edge: it moves in, and sits above the pointer.
    expect(menu).toHaveStyle({ left: `${window.innerWidth - 208}px`, top: `${bottom - 90}px` });
    spy.mockRestore();
  });

  it("keeps Message everywhere, and Mention only in a channel: a Direct Message has no @", async () => {
    const w = world();
    w.dms["person:ed|s-notes"] = { messages: [dmsg("x1", NOTES, ME, "from the agent")] };
    page({ chat: fakeChat(w) });
    await flush();
    await open("d:dm:person:ed|s-notes");
    fireEvent.contextMenu(gutOf(msgs()[0]!));
    expect(items()).toEqual(["Message infra-notes", "Open orchestration page"]);
  });

  it("gives an Admin reading a person no item that sends: a note for a person, the orchestration page for an agent", async () => {
    const w = world();
    w.overview.me = { name: "Root", admin: true, person: false };
    w.overview.channels = [channelOf("general")];
    w.overview.directs = [];
    w.overview.agents = [];
    w.overview.people = [{ name: "Ed", you: false }, { name: "Maya", you: false }];
    w.owners = { Maya: { channels: [channelOf("general"), channelOf("group", { thread: "group:maya", messages: 2 })], directs: [] } };
    w.channels.group = { messages: [maya("q1", "run the tests"), cmsg("q2", "On it.", { mine: false, authorKind: "orchestrator", authorName: "maya-api", authorRef: "m-1", createdAt: T0 - 8 * MIN, updatedAt: T0 - 8 * MIN })] };
    page({ chat: fakeChat(w), me: ROOT });
    await flush();
    fireEvent.change(screen.getByLabelText("Read a person's conversations"), { target: { value: "Maya" } });
    await flush();
    await open("c:group");
    fireEvent.contextMenu(gutOf(msgs()[0]!));
    expect(screen.queryByTestId("chat-menu")).toBeNull();
    expect(screen.getByTestId("chat-menu-note")).toHaveTextContent("An Admin reading cannot send, so there is no Message or Mention.");
    fireEvent.keyDown(screen.getByTestId("chat-menu-note"), { key: "Escape" });
    fireEvent.contextMenu(gutOf(msgs()[1]!));
    expect(items()).toEqual(["Open orchestration page"]);
  });

  it("says so, and writes nothing, when the person has no address in the channel", async () => {
    const chat = generalWith([cmsg("o", "hi", { mine: false, authorName: "Zed", authorRef: "Zed", createdAt: T0 - MIN, updatedAt: T0 - MIN })]);
    page({ chat });
    await flush();
    fireEvent.contextMenu(gutOf(msgs()[0]!));
    fireEvent.click(item("Mention Zed"));
    await flush();
    expect(screen.getByTestId("chat-action-error")).toHaveTextContent("Could not find an address for Zed in this channel. Nothing was written.");
    expect((screen.getByTestId("chat-box") as HTMLTextAreaElement).value).toBe("");
  });

  it("says so when the addresses cannot be read", async () => {
    const chat = generalWith([maya("a", "hello")]);
    chat.api.addresses.mockRejectedValueOnce(new RespondError(500, { error: "The store is busy." }));
    page({ chat });
    await flush();
    fireEvent.contextMenu(gutOf(msgs()[0]!));
    fireEvent.click(item("Mention Maya"));
    await flush();
    expect(screen.getByTestId("chat-action-error")).toHaveTextContent(/Could not read who can be mentioned/);
  });
});

/** Makes one element answer getBoundingClientRect with a place of its own; restored by vi.restoreAllMocks. */
function spyRect(el: Element, r: { left: number; top: number; bottom: number }) {
  const real = el.getBoundingClientRect.bind(el);
  vi.spyOn(el, "getBoundingClientRect").mockImplementation(() => ({ ...real(), ...r, right: r.left + 40, width: 40, height: r.bottom - r.top, x: r.left, y: r.top, toJSON: () => ({}) }) as DOMRect);
}

// ---- Every Admin notice in the redesigned layout (#1238) -----------------------------------------------------------------------

describe("the notices a person gets, in the redesigned layout (#1238)", () => {
  it("tells the person in each place the layout draws: the tag on the row, the tag under the title, the red banner above the messages, and the record line among them", async () => {
    const w = world();
    w.overview.directs = [direct(DASH, TESTER, { adminReading: [live("Root")] })];
    w.reads = { "s-dash|s-tester": [{ admin: "Alex", startedAt: ago(200_000), lastSeenAt: ago(190_000) }] };
    page({ chat: fakeChat(w) });
    await flush();
    expect(within(row("d:dm:s-dash|s-tester")).getByTestId("chat-tag-reading")).toHaveTextContent("Admin reading");
    await open("d:dm:s-dash|s-tester");
    const head = thread().querySelector(".ch-head")!;
    expect(within(head as HTMLElement).getByTestId("chat-tag-reading")).toHaveTextContent("Admin reading");
    const banner = within(thread()).getByTestId("chat-reading-banner");
    expect(banner).toHaveClass("ch-nav", "ro", "crit");
    expect(head.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const list = thread().querySelector("ol.ch-msgs")!;
    expect(banner.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(list as HTMLElement).getByTestId("chat-record")).toHaveClass("ch-rec");
  });

  it("tells the person of an Admin's pause with the tag on the row, the tag under the title and the banner", async () => {
    const w = world();
    w.overview.directs = [direct(DASH, TESTER, { state: "paused", paused: true, pausedBy: "admin", pausedByAdmin: "Root" })];
    page({ chat: fakeChat(w) });
    await flush();
    expect(within(row("d:dm:s-dash|s-tester")).getByTestId("chat-tag-paused")).toHaveTextContent("Paused by an Admin");
    await open("d:dm:s-dash|s-tester");
    expect(within(thread().querySelector(".ch-head") as HTMLElement).getByTestId("chat-tag-paused")).toBeInTheDocument();
    expect(within(thread()).getByTestId("chat-admin-pause-banner")).toHaveClass("ch-nav", "ro", "crit");
  });
});
