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
import type { Address, ChatApi, Cross, ChatOverview, ChannelMessage, DirectInfo, DirectMessage, DirectPageRead, Party } from "./chatData";
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
    const d = w.overview.directs.find((x) => [x.a.sessionId, x.b.sessionId].sort().join("|") === key.split("|").sort().join("|"))!;
    return {
      ok: true,
      thread: d.thread,
      a: d.a,
      b: d.b,
      messages: before ? [dmsg("old1", DASH, TESTER, "An older message.", { sentAt: T0 - 900_000 })] : structuredClone(t.messages),
      older: before ? null : (t.older ?? null),
      total: t.total ?? t.messages.length,
      ended: d.ended,
      owner: "Ed",
      paused: d.paused,
      roundTrips: d.roundTrips,
      cross: d.cross ?? null,
    };
  };
  const api = {
    overview: vi.fn(async () => structuredClone(w.overview)),
    markRead: vi.fn(async () => ({ ok: true as const, unread: 0, mentions: 0 })),
    addresses: vi.fn(async () => ({ ok: true as const, addresses: structuredClone(BOOK) })),
    channelMessages: vi.fn(async (channel: string) => {
      const c = w.channels[channel]!;
      return { ok: true as const, channel: channel as "general", messages: structuredClone(c.messages), older: c.older ?? null, total: c.messages.length };
    }),
    post: vi.fn(async (channel: string, text: string) => {
      if (w.postError) throw w.postError;
      const m = cmsg(`new-${w.channels[channel]!.messages.length}`, text);
      w.channels[channel]!.messages.push(m);
      return { ok: true as const, message: m, warnings: [] as string[] };
    }),
    pause: vi.fn(async (channel: string, paused: boolean, everyone = false) => {
      w.overview.channels = w.overview.channels.map((c) => (c.id === channel ? { ...c, paused, pausedForEveryone: everyone && paused } : c));
      return { ok: true as const };
    }),
    disconnect: vi.fn(async (channel: string, disconnected: boolean) => {
      w.overview.channels = w.overview.channels.map((c) => (c.id === channel ? { ...c, disconnected } : c));
      return { ok: true as const };
    }),
    clear: vi.fn(async (channel: string) => {
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

function page(opts: { chat?: ReturnType<typeof fakeChat>; me?: RespondMe; peersFlag?: boolean } = {}) {
  const chat = opts.chat ?? fakeChat();
  const sessions = [
    makeSession({ id: "s-dash", name: "claude-dashboard", status: "running", lastSeenAt: T0, owner: "Ed", machine: { name: "ed-mbp", id: "m1", os: "macOS 26.1" } }),
    makeSession({ id: "s-tester", name: "Tester", status: "waiting", waitReason: "input", lastSeenAt: T0, owner: "Ed", machine: { name: "ci-runner-01", id: "m2", os: "Ubuntu 24.04" } }),
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
    expect(row("d:s-dash+s-tester")).toHaveTextContent("claude-dashboard, Tester");
    expect(row("d:s-dash+s-tester")).toHaveTextContent("Two agents, and you");
    expect(within(row("d:s-dash+s-tester")).getByLabelText("2 new")).toBeInTheDocument();
    expect(row("d:s-notes")).toHaveTextContent("You and one agent");
    expect(row("d:s-dash+s-notes")).toHaveTextContent("Paused");
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
    expect(nav.getAllByRole("heading").map((h) => h.textContent)).toEqual(["Channels"]);
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
    await open("d:s-dash+s-tester");
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
    await open("d:s-dash+s-tester");
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
    expect(msgs[1]!.querySelector(".who")).toHaveTextContent("Tester replying to you");
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
    await open("d:s-dash+s-tester");
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
    await open("d:s-dash+s-tester");
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
    await open("d:s-dash+s-tester");
    expect(box()).toBeDisabled();
    expect(thread()).toHaveTextContent("Paused: messages are held.");
    await open("d:s-dash+s-notes");
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
    await open("d:s-dash+s-tester");
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
    await open("d:s-dash+s-tester");
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
    fireEvent.contextMenu(row("d:s-notes"));
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
    expect(row("d:s-dash+s-tester")).toHaveTextContent("Paused");
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
    expect(row("d:s-dash+s-tester")).toHaveTextContent("Link removed");
    expect(box()).toBeDisabled();
  });

  it("asks before it deletes a conversation, then deletes it and goes back to General", async () => {
    const p = page();
    await flush();
    fireEvent.click(within(row("d:s-notes")).getByRole("button", { name: "Actions for infra-notes" }));
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
    await open("d:s-dash+s-tester");
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
    await open("d:s-dash+s-tester");
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

describe("a conversation across owners", () => {
  const more = (name: string) => screen.getByRole("button", { name: `Actions for ${name}` });
  const items = () => within(screen.getByRole("menu")).getAllByRole("menuitem");

  it("says who the two people are and who may read, and the state of each message in words with the server's reason", async () => {
    page({ chat: crossWorld("owner") });
    await flush();
    await open("d:s-dash");
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
    await open("d:s-dash");
    expect(box()).toBeDisabled();
    expect(box()).toHaveAttribute("placeholder", "Link removed");
    expect(thread()).toHaveTextContent("The link was removed, so nothing can be sent. Only Ed can open it again.");
    cleanup();
    page({ chat: crossWorld("sender", { link: "paused", pausedBy: "owner", canResume: false }) });
    await flush();
    await open("d:s-dash");
    expect(box()).toBeDisabled();
    expect(thread()).toHaveTextContent("Paused by Ed: messages are held. Only Ed can resume it.");
    cleanup();
    page({ chat: crossWorld("sender", { link: "waiting" }) });
    await flush();
    await open("d:s-dash");
    expect(box()).not.toBeDisabled();
    expect(thread()).toHaveTextContent("Waiting for Ed to approve your message. It is delivered once Ed allows it.");
    cleanup();
    page({ chat: crossWorld("owner") });
    await flush();
    await open("d:s-dash");
    expect(box()).toBeDisabled();
    expect(thread()).toHaveTextContent("Only Maya writes in this conversation. You can pause or remove its link from the menu.");
  });

  it("tags the row with the link's state", async () => {
    page({ chat: crossWorld("owner", { link: "waiting" }) });
    await flush();
    expect(row("d:s-dash")).toHaveTextContent("Waiting for approval");
    expect(row("d:s-dash")).toHaveTextContent("Maya and your agent");
    expect(row("d:s-dash")).not.toHaveTextContent("You and one agent");
    cleanup();
    page({ chat: crossWorld("sender") });
    await flush();
    expect(row("d:s-dash")).toHaveTextContent("You and Ed's agent");
    cleanup();
    page({ chat: crossWorld("admin") });
    await flush();
    expect(row("d:s-dash")).toHaveTextContent("Maya and Ed's agent");
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
