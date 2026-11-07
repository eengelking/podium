// Chat (#1034, mockup/podium-chat.html): the sidebar, the thread, the box and its `@` combobox, the menus and their confirmations,
// what another person sees, and that the page reads again on the console's `chat` signal, against a fake server that keeps
// what it is told.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import axe from "axe-core";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { FleetView } from "./FleetApp";
import { makeSession } from "./fixtures";
import { stateFrom } from "./testState";
import { fleetReducer } from "./store";
import { RespondError, type PeersApi, type RespondApi } from "./respondApi";
import type { Address, AdminRead, ChatApi, Cross, ChatOverview, ChannelMessage, DirectInfo, DirectMessage, DirectPageRead, GoneRead, Party } from "./chatData";
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

const channelOf = (id: "general" | "group", over: Partial<ChatOverview["channels"][number]> = {}): ChatOverview["channels"][number] => ({
  id,
  name: id === "general" ? "General" : "My group",
  thread: id === "general" ? "public" : "group:ed",
  unread: 0,
  mentions: 0,
  messages: 3,
  paused: false,
  pausedForEveryone: false,
  disconnected: false,
  can: id === "general" ? { pause: true, pauseEveryone: false, disconnect: true, removeAll: false } : { pause: true, pauseEveryone: false, disconnect: true, removeAll: true },
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
      return { ok: true as const, message: m, skipped: [], errors: [] };
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
  const signal = () => view.rerender(<FleetView {...props} state={fleetReducer(state, { type: "chat" })} />);
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

  it("says in its rules who reads a conversation with another person's agent", async () => {
    page();
    await flush();
    expect(screen.getByText(/A conversation with another person's agent is read by that person, the agent's owner and an Admin/)).toBeInTheDocument();
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

describe("the sidebar", () => {
  it("lists Channels, Direct Messages with their tags and unread counts, and People and agents with state and role", async () => {
    page();
    await flush();
    const nav = within(screen.getByRole("navigation", { name: "Chat" }));
    expect(nav.getAllByRole("heading").map((h) => h.textContent)).toEqual(["Channels", "Direct Messages", "People and agents"]);
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
    w.overview.channels = [channelOf("general", { can: { pause: false, pauseEveryone: true, disconnect: false, removeAll: true } })];
    w.overview.directs = [];
    w.overview.agents = [];
    page({ chat: fakeChat(w), me: ROOT });
    await flush();
    const nav = within(screen.getByRole("navigation", { name: "Chat" }));
    expect(nav.getAllByRole("heading").map((h) => h.textContent)).toEqual(["Read as an Admin", "Channels"]);
    expect(nav.getByText(/belong to a person/)).toBeInTheDocument();
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
    const who = within(t).getByLabelText("In this conversation");
    expect(within(who).getByRole("button", { name: /claude-dashboard/ })).toBeInTheDocument();
    expect(within(who).getByRole("button", { name: /Tester/ })).toHaveAttribute("title", "Tester, waiting for you. Actions");
    expect(who).toHaveTextContent("Ed");
    expect(who.querySelector(".you")).toHaveTextContent("you");
    expect(who.querySelector(".mono-g")).not.toBeNull();
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
    const why = document.getElementById(box().getAttribute("aria-describedby")!)!;
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
    expect(box()).not.toHaveAttribute("aria-expanded");
    expect(box()).toHaveAttribute("aria-controls", list.id);
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
      await new Promise((r) => setTimeout(r, 5));
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
    w.overview.channels = [channelOf("general", { can: { pause: false, pauseEveryone: true, disconnect: false, removeAll: true } })];
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
    w.overview.channels = [channelOf("general", { can: { pause: false, pauseEveryone: false, disconnect: false, removeAll: false } }), channelOf("group")];
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
    await new Promise((r) => setTimeout(r, 5));
    expect(document.activeElement).toBe(more("General"));
  });

  it("gives an agent Message and Open orchestration page, which goes to the console with it open", async () => {
    page();
    await flush();
    fireEvent.click(more("Tester"));
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Message Tester", "Open orchestration page"]);
    expect(items[1]).toHaveAttribute("href", "#/?open=s-tester");
    fireEvent.click(items[0]!);
    await flush();
    expect(within(thread()).getByRole("heading", { level: 2 })).toHaveTextContent("Tester");
  });

  it("gives a participant chip the orchestration page and no Message", async () => {
    page();
    await flush();
    await open("d:dm:s-dash|s-tester");
    const who = within(thread()).getByLabelText("In this conversation");
    fireEvent.click(within(who).getByRole("button", { name: /claude-dashboard/ }));
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Open orchestration page"]);
    expect(items[0]).toHaveAttribute("href", "#/?open=s-dash");
  });
});

describe("accessibility", () => {
  it("passes the axe rules jsdom can judge, with a thread open and with a menu and the listbox open", async () => {
    vi.useRealTimers();
    const { container } = page();
    await flush();
    await open("d:dm:s-dash|s-tester");
    fireEvent.click(screen.getByRole("button", { name: "Actions for claude-dashboard, Tester" }));
    const run = async () => {
      const r = await axe.run(container, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
        rules: { "color-contrast": { enabled: false }, "target-size": { enabled: false }, "scrollable-region-focusable": { enabled: false }, "link-in-text-block": { enabled: false }, region: { enabled: false } },
      });
      return { violations: r.violations };
    };
    expect((await run()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await open("c:group");
    fireEvent.change(box(), { target: { value: "@te" } });
    await flush();
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
    const tip = screen.getByRole("tooltip", { hidden: true });
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
    const items = [...thread().querySelectorAll("ol.feed > li")].map((li) => (li.classList.contains("ch-rec") ? `rec:${li.textContent}` : `msg:${li.querySelector(".who")?.textContent}`));
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
    w.overview.channels = [channelOf("general", { can: { pause: false, pauseEveryone: true, disconnect: false, removeAll: true } })];
    w.overview.directs = [];
    w.overview.agents = [];
    w.overview.people = [{ name: "Ed", you: false }, { name: "Maya", you: false }];
    w.owners = {
      Maya: {
        channels: [channelOf("general", { can: { pause: false, pauseEveryone: true, disconnect: false, removeAll: true } }), channelOf("group", { thread: "group:maya", messages: 1, adminReading: [] })],
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
    expect(screen.getByRole("heading", { name: "Direct Messages" })).toBeInTheDocument();
    fireEvent.click(stop);
    await flush();
    expect(screen.queryByTestId("chat-stop-reading")).toBeNull();
    expect((screen.getByLabelText("Read a person's conversations") as HTMLSelectElement).value).toBe("");
    expect(screen.queryByRole("heading", { name: "Direct Messages" })).toBeNull();
    expect(screen.getByText("Back to your own conversations.")).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
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
    expect(nav.getAllByRole("heading").map((h) => h.textContent)).toEqual(["Read as an Admin", "Channels", "Direct Messages"]);
    expect(row("c:group")).toHaveTextContent("read only");
    expect(row("d:dm:m-1|m-2")).toHaveTextContent("Two agents, and Maya, read only");
    expect(row("d:dm:m-1|m-2")).toHaveTextContent("maya-api, maya-ui");
    expect(within(row("d:dm:m-1|m-2")).queryByLabelText(/new/)).toBeNull();
  });

  it("opens a thread with a red banner, no message box and the reason, and records nothing as read", async () => {
    const p = page({ chat: fakeChat(adminWorld()), me: ROOT });
    await flush();
    await pickPerson();
    await open("d:dm:m-1|m-2");
    const banner = within(thread()).getByTestId("chat-ro-banner");
    expect(banner).toHaveClass("crit");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveTextContent("Reading Maya's conversation as an Admin. You cannot send here.");
    expect(banner).toHaveTextContent("Maya is told while you read, and a line stays in the conversation afterward.");
    expect(screen.queryByTestId("chat-box")).toBeNull();
    expect(screen.getByTestId("chat-ro-note")).toHaveTextContent("You are reading as an Admin, so there is no message box.");
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
