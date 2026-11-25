// Editing and deleting your own Chat messages (#1269, mockup/podium-chat-edit-delete.html): the menu on a right-click (no "..." button), the
// keyboard (Up in an empty box, Up and Down through your own messages, E, Delete, Escape), the editor in place, the delete confirmation, the
// tombstone a delete leaves, the live refresh of earlier pages, and an axe pass over each new surface. Against a fake server that keeps what
// it is told, as chat.test.tsx has.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import axe from "axe-core";
import { render, screen, fireEvent, cleanup, act, within, renderHook, waitFor } from "@testing-library/react";
import { FleetView } from "./FleetApp";
import { makeSession } from "./fixtures";
import { stateFrom } from "./testState";
import { fleetReducer } from "./store";
import { RespondError, type PeersApi, type RespondApi } from "./respondApi";
import type { Address, ChannelMessage, ChatApi, ChatOverview, DirectInfo, DirectMessage, DirectPageRead, Party } from "./chatData";
import { useThread, type Selection } from "./useChat";
import { Landing } from "./landing";
import type { RespondMe } from "./types";

const ED: RespondMe = { enabled: true, signedIn: true, name: "Ed", id: 1, admin: false };
const T0 = new Date(2026, 9, 12, 14, 30).getTime();
const MIN = 60_000;
const LOCKED = "Podium has already sent this message to Tester, so it can no longer be changed.";

const agent = (sessionId: string, name: string, machine = "ed-mbp"): Party => ({ sessionId, name, machine, reporterKey: `k-${machine}`, kind: "agent", live: true, status: "running" });
const ME: Party = { sessionId: "person:ed", name: "Ed", machine: "", reporterKey: "", kind: "person", live: true, status: null };
const TESTER = agent("s-tester", "Tester", "ci-runner-01");

const cmsg = (id: string, text: string, over: Partial<ChannelMessage> = {}): ChannelMessage => ({
  id,
  authorKind: "person",
  authorName: "Ed",
  authorRef: "Ed",
  text,
  createdAt: T0 - 60 * MIN,
  updatedAt: T0 - 60 * MIN,
  replyTo: null,
  issue: null,
  project: null,
  milestone: null,
  mine: true,
  mentions: [],
  editedAt: null,
  deletedAt: null,
  canChange: true,
  changeWhy: null,
  ...over,
});
const dmsg = (id: string, text: string, over: Partial<DirectMessage> = {}): DirectMessage => ({
  id,
  author: "person",
  from: { kind: "person", sessionId: "person:ed", personId: 1, name: "Ed", machine: "" },
  to: [{ sessionId: "s-tester", name: "Tester", machine: "ci-runner-01", state: "queued", why: null }],
  text,
  sentAt: T0 - 50 * MIN,
  state: "queued",
  stateAt: T0 - 50 * MIN,
  why: null,
  approved: false,
  editedAt: null,
  deletedAt: null,
  canChange: true,
  changeWhy: null,
  ...over,
});

const channelOf = (id: string, name: string, kind: "general" | "group" | "public"): ChatOverview["channels"][number] => ({
  id,
  kind: kind === "general" ? "public" : kind,
  name,
  description: "",
  link: null,
  openedBy: null,
  thread: kind === "general" ? "public" : kind === "group" ? "group:ed" : `public:${id}`,
  unread: 0,
  mentions: 0,
  messages: 5,
  paused: false,
  pausedForEveryone: false,
  disconnected: false,
  can: { pause: true, pauseEveryone: false, disconnect: true, removeAll: false, editDescription: false, removeChannel: false },
});

/** My group: q1 (can change), a reply from an agent, q3 (sent to Tester: locked), q4 (deleted) and q5 (can change), oldest first. */
const groupMessages = (): ChannelMessage[] => [
  cmsg("q1", "run the tests @Tester@ci-runner-01", { createdAt: T0 - 60 * MIN, mentions: [{ typed: "Tester@ci-runner-01", sessionId: "s-tester", state: "not-delivered", why: "Its reporter is not taking messages now.", stateAt: T0 }] }),
  cmsg("q2", "On it.", { mine: false, authorKind: "orchestrator", authorName: "Tester", authorRef: "s-tester", createdAt: T0 - 50 * MIN, canChange: false }),
  cmsg("q3", "also lint @Tester@ci-runner-01", { createdAt: T0 - 40 * MIN, canChange: false, changeWhy: LOCKED, mentions: [{ typed: "Tester@ci-runner-01", sessionId: "s-tester", state: "done", why: null, stateAt: T0 }] }),
  cmsg("q4", "", { createdAt: T0 - 30 * MIN, deletedAt: T0 - 20 * MIN, canChange: false }),
  cmsg("q5", "last one", { createdAt: T0 - 10 * MIN }),
];

interface Fake {
  groupMsgs: ChannelMessage[];
  generalMsgs: ChannelMessage[];
  dmMsgs: DirectMessage[];
  publicMsgs: ChannelMessage[];
}
const BOOK: Address[] = [{ typed: "Tester@ci-runner-01", label: "Orchestrator", role: "orchestrator", sessionId: "s-tester" }];

function fakeChat(over: Partial<Fake> = {}) {
  const w: Fake = { groupMsgs: groupMessages(), generalMsgs: [cmsg("g1", "Heads up", { mine: false, authorName: "Maya", authorRef: "Maya", canChange: false }), cmsg("g2", "Thanks.")], dmMsgs: [dmsg("d1", "Also Debian 12.", { canChange: true })], publicMsgs: [cmsg("p1", "in the channel")], ...over };
  const dm: DirectInfo = {
    thread: "dm:person:ed|s-tester",
    a: ME,
    b: TESTER,
    owner: "Ed",
    messages: 1,
    lastAt: T0,
    state: "active",
    paused: false,
    canSend: { aToB: true, bToA: true },
    roundTrips: { used: 0, cap: 0 },
    ended: [],
    unread: 0,
    mentions: 0,
    hiddenAt: null,
  };
  const overview: ChatOverview = {
    enabled: true,
    serverTime: T0,
    me: { id: 1, name: "Ed", admin: false, person: true },
    settings: { maxChars: 20000, perMinute: 6, retainDays: 30, graceHours: 24, everyone: false },
    channels: [channelOf("general", "General", "general"), channelOf("group", "My group", "group"), channelOf("release", "release", "public")],
    directs: [dm],
    agents: [{ sessionId: "s-tester", name: "Tester", machine: "ci-runner-01", reporterKey: "k-ci-runner-01", address: "Tester@ci-runner-01", status: "waiting", waitReason: "input", peers: true }],
    people: [{ name: "Ed", you: true }, { name: "Maya", you: false }],
  };
  const lists = (channel: string) => (channel === "group" ? w.groupMsgs : channel === "general" ? w.generalMsgs : w.publicMsgs);
  const replace = <T extends { id: string }>(list: T[], id: string, next: (m: T) => T): T => {
    const at = list.findIndex((m) => m.id === id);
    list[at] = next(list[at]!);
    return list[at]!;
  };
  const api = {
    concluded: vi.fn(async () => ({ ok: true as const, concluded: [] })),
    dismissConcluded: vi.fn(async () => ({ ok: true as const })),
    overview: vi.fn(async () => structuredClone(overview)),
    markRead: vi.fn(async () => ({ ok: true as const, unread: 0, mentions: 0 })),
    addresses: vi.fn(async () => ({ ok: true as const, addresses: structuredClone(BOOK) })),
    channelMessages: vi.fn(async (channel: string) => ({ ok: true as const, channel: channel as "general", messages: structuredClone(lists(channel)), older: null, total: lists(channel).length })),
    dmMessages: vi.fn(async (): Promise<DirectPageRead> => ({ ok: true, thread: dm.thread, a: ME, b: TESTER, messages: structuredClone(w.dmMsgs), older: null, total: w.dmMsgs.length, ended: [], owner: "Ed", paused: false, roundTrips: { used: 0, cap: 0 }, cross: null, pausedBy: null, pausedByAdmin: null })),
    editChannelMessage: vi.fn(async (channel: string, id: string, text: string) => ({ ok: true as const, message: structuredClone(replace(lists(channel), id, (m) => ({ ...m, text, editedAt: T0 }))) })),
    deleteChannelMessage: vi.fn(async (channel: string, id: string) => ({ ok: true as const, message: structuredClone(replace(lists(channel), id, (m) => ({ ...m, text: "", mentions: [], deletedAt: T0, canChange: false }))) })),
    editDmMessage: vi.fn(async (_a: string, _b: string, id: string, text: string) => ({ ok: true as const, message: structuredClone(replace(w.dmMsgs, id, (m) => ({ ...m, text, editedAt: T0 }))) })),
    deleteDmMessage: vi.fn(async (_a: string, _b: string, id: string) => ({ ok: true as const, message: structuredClone(replace(w.dmMsgs, id, (m) => ({ ...m, text: "", deletedAt: T0, canChange: false }))) })),
  };
  return { api: api as unknown as ChatApi, fake: api, w };
}

const respondApi = (me: RespondMe) => ({ me: vi.fn(async () => me), signIn: vi.fn(), signOut: vi.fn(), ask: vi.fn(), answer: vi.fn(), message: vi.fn(), discard: vi.fn() }) as unknown as RespondApi;
const peersApi = () => ({ read: vi.fn(async () => ({ enabled: true, owner: "Ed", requests: [], reporters: [], rights: [], serverTime: T0, serverStartedAt: 0, defaults: { trust: false, onRequest: "ask", newSend: "ask", limits: {} }, limits: { server: {}, effective: {} } })), setRight: vi.fn(), setDefaults: vi.fn(), answer: vi.fn() }) as unknown as PeersApi;
const flush = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });

function page(chat = fakeChat()) {
  const sessions = [makeSession({ id: "s-tester", name: "Tester", status: "waiting", waitReason: "input", lastSeenAt: T0, owner: "Ed", ownerId: 1, machine: { name: "ci-runner-01", id: "m2", os: "Ubuntu 24.04" } })];
  const state = stateFrom({ sessions, features: { "activity-feed": true, "peer-messaging": true } });
  const props = { chat: true, respondApi: respondApi(ED), peersApi: peersApi(), chatApi: chat.api };
  const view = render(<FleetView {...props} state={state} />);
  let current = state;
  const signal = () => {
    current = fleetReducer(current, { type: "chat" });
    view.rerender(<FleetView {...props} state={current} />);
  };
  return { chat, signal, ...view };
}

const open = async (key: string) => {
  fireEvent.click(screen.getByTestId(`chat-row-${key}`).querySelector(".ch-row") as HTMLElement);
  await flush();
};
const msgs = () => within(screen.getByTestId("chat-thread")).getAllByTestId("chat-message");
const msg = (i: number) => msgs()[i]!;
const box = () => screen.getByTestId("chat-box") as HTMLTextAreaElement;
const said = () => screen.getByTestId("chat-msg-said");
const menu = () => screen.getByRole("menu", { name: "Your message" });
const item = (name: string) => within(menu()).getByRole("menuitem", { name });
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(el, { key: k, ...init });
const focus = (el: HTMLElement) => act(() => el.focus());
/** Opens My group and puts the focus on one of its messages as Up from the box would, then answers where it landed. */
const groupPage = async (chat = fakeChat()) => {
  const p = page(chat);
  await flush();
  await open("c:group");
  return p;
};
const upFromBox = () => {
  focus(box());
  key(box(), "ArrowUp");
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

describe("the menu on your own message", () => {
  it("opens at the pointer on a right-click, with Edit message and Delete message and their keys, and has no ... button", async () => {
    await groupPage();
    expect(document.querySelector(".ch-msg .ch-more")).toBeNull();
    expect(fireEvent.contextMenu(msg(0), { clientX: 130, clientY: 210 })).toBe(false);
    const m = menu();
    expect(m).toHaveClass("ed-menu", "at");
    expect(m).toHaveStyle({ left: "130px", top: "210px" });
    expect(within(m).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Edit message" + "E", "Delete message" + "Del"]);
    expect(item("Delete message")).toHaveClass("dng");
    expect(within(m).getAllByRole("menuitem")[0]).toHaveFocus();
    expect(item("Edit message")).not.toHaveAttribute("aria-disabled");
    expect(msg(0)).toHaveClass("menu-open");
  });

  it("marks the row with no class that a general .podium rule in fleet.css also matches, so its text keeps its size (#1326)", async () => {
    await groupPage();
    fireEvent.contextMenu(msg(0), { clientX: 130, clientY: 210 });
    const row = msg(0);
    expect(row).toHaveClass("menu-open", "ch-sel");
    // jsdom loads no stylesheet, so read the rules: a selector that is exactly `.podium .<class>` applies to that class wherever it is used.
    const css = readFileSync(resolve(process.cwd(), "src/fleet/fleet.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const general = new Set<string>();
    for (const m of css.matchAll(/([^{}]+)\{/g)) {
      for (const s of m[1]!.split(",")) {
        const one = /^\s*\.podium\s+\.([\w-]+)\s*$/.exec(s);
        if (one) general.add(one[1]!);
      }
    }
    const used = new Set<string>([...row.classList, ...(row.querySelector(".ch-col")?.classList ?? []), ...(row.querySelector(".ch-tx")?.classList ?? [])]);
    expect([...used].filter((c) => general.has(c))).toEqual([]);
  });

  it("opens beside the message text from Enter, the ContextMenu key and Shift+F10 on the focused message", async () => {
    await groupPage();
    for (const [k, init] of [["Enter", {}], ["ContextMenu", {}], ["F10", { shiftKey: true }]] as const) {
      focus(msg(0));
      key(msg(0), k, init);
      expect(menu()).toBeInTheDocument();
      key(menu(), "Escape");
      await act(async () => void (await new Promise((r) => setTimeout(r, 5))));
      expect(screen.queryByRole("menu", { name: "Your message" })).toBeNull();
      expect(msg(0)).toHaveFocus();
    }
  });

  it("offers no menu on another's message, on a deleted one, or on one of yours the server says nothing about", async () => {
    const chat = fakeChat();
    chat.w.groupMsgs.push(cmsg("q6", "from before", { canChange: false, createdAt: T0 - 5 * MIN }));
    await groupPage(chat);
    // q2 is the agent's, q4 the tombstone, q6 has neither canChange nor changeWhy: the browser's own menu stays.
    for (const i of [1, 3, 5]) {
      expect(fireEvent.contextMenu(msg(i))).toBe(true);
      expect(screen.queryByRole("menu", { name: "Your message" })).toBeNull();
    }
    focus(msg(5));
    key(msg(5), "Enter");
    expect(screen.queryByRole("menu", { name: "Your message" })).toBeNull();
  });

  it("keeps both items for a message already sent to an agent, disabled, with the reason, and a choice says why and keeps the menu open", async () => {
    await groupPage();
    fireEvent.contextMenu(msg(2));
    const edit = item("Edit message");
    const del = item("Delete message");
    expect(edit).toHaveAttribute("aria-disabled", "true");
    expect(del).toHaveAttribute("aria-disabled", "true");
    expect(menu().querySelector(".why")).toHaveTextContent(LOCKED);
    fireEvent.click(edit);
    expect(menu()).toBeInTheDocument();
    expect(said()).toHaveTextContent(LOCKED);
    expect(screen.queryByRole("textbox", { name: "Edit your message" })).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // Both stay focusable, so the reason can be read.
    key(menu(), "ArrowDown");
    expect(del).toHaveFocus();
  });

  it("moves with Up, Down, Home and End, closes on Tab, a click elsewhere and a resize, and a scroll only after 400 ms", async () => {
    await groupPage();
    fireEvent.contextMenu(msg(0), { clientX: 10, clientY: 10 });
    const [edit, del] = within(menu()).getAllByRole("menuitem");
    key(edit!, "ArrowDown");
    expect(del).toHaveFocus();
    key(del!, "ArrowDown");
    expect(edit).toHaveFocus();
    key(edit!, "End");
    expect(del).toHaveFocus();
    key(del!, "Home");
    expect(edit).toHaveFocus();
    // A scroll just after it opened (the one that brought the message into view) leaves it open.
    vi.setSystemTime(T0 + 300);
    fireEvent.scroll(document);
    expect(menu()).toBeInTheDocument();
    vi.setSystemTime(T0 + 500);
    fireEvent.scroll(document);
    expect(screen.queryByRole("menu", { name: "Your message" })).toBeNull();
    fireEvent.contextMenu(msg(0));
    fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("menu", { name: "Your message" })).toBeNull();
    fireEvent.contextMenu(msg(0));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu", { name: "Your message" })).toBeNull();
    fireEvent.contextMenu(msg(0));
    key(menu(), "Tab");
    expect(screen.queryByRole("menu", { name: "Your message" })).toBeNull();
  });

  it("starts the editor from Edit message and the confirmation from Delete message", async () => {
    await groupPage();
    fireEvent.contextMenu(msg(0));
    fireEvent.click(item("Edit message"));
    expect(screen.getByRole("textbox", { name: "Edit your message" })).toHaveFocus();
    expect(screen.queryByRole("menu", { name: "Your message" })).toBeNull();
    key(screen.getByRole("textbox", { name: "Edit your message" }), "Escape");
    fireEvent.contextMenu(msg(0));
    fireEvent.click(item("Delete message"));
    expect(screen.getByRole("alertdialog", { name: "Delete this message?" })).toBeInTheDocument();
  });
});

describe("the keyboard", () => {
  it("moves from an empty box to your latest message on Up, and says what it is and what the keys do", async () => {
    await groupPage();
    upFromBox();
    expect(msg(4)).toHaveFocus();
    expect(said()).toHaveTextContent(/^Your message, 14:20: last one\. .*Press E to edit or Delete to delete\.$/);
  });

  it("stays in the box when the box has text, a modifier is down or a list of @ choices is open", async () => {
    await groupPage();
    fireEvent.change(box(), { target: { value: "draft" } });
    upFromBox();
    expect(box()).toHaveFocus();
    fireEvent.change(box(), { target: { value: "" } });
    focus(box());
    key(box(), "ArrowUp", { shiftKey: true });
    expect(box()).toHaveFocus();
    fireEvent.change(box(), { target: { value: "@te" } });
    await flush();
    expect(screen.getByTestId("chat-listbox")).not.toHaveAttribute("hidden");
    key(box(), "ArrowUp");
    expect(box()).toHaveFocus();
    expect(msgs().some((m) => m === document.activeElement)).toBe(false);
  });

  it("does nothing on Up when there is no message of yours", async () => {
    await groupPage(fakeChat({ groupMsgs: [cmsg("x", "from her", { mine: false, authorName: "Maya", authorRef: "Maya", canChange: false })] }));
    upFromBox();
    expect(box()).toHaveFocus();
  });

  it("visits every message of yours with Up and Down, in order, and none of anyone else's, and Down past the last returns to the box", async () => {
    await groupPage();
    upFromBox();
    expect(msg(4)).toHaveFocus();
    key(msg(4), "ArrowUp");
    expect(msg(3)).toHaveFocus();
    expect(said()).toHaveTextContent("There is nothing left to change.");
    key(msg(3), "ArrowUp");
    expect(msg(2)).toHaveFocus();
    key(msg(2), "ArrowUp");
    expect(msg(0)).toHaveFocus(); // the agent's reply (msg 1) is skipped
    key(msg(0), "ArrowUp");
    expect(msg(0)).toHaveFocus();
    key(msg(0), "ArrowDown");
    expect(msg(2)).toHaveFocus();
    key(msg(2), "ArrowDown");
    key(msg(3), "ArrowDown");
    expect(msg(4)).toHaveFocus();
    key(msg(4), "ArrowDown");
    expect(box()).toHaveFocus();
  });

  it("keeps the one-stop list's arrows for a message reached by Tab or a click: Up and Down visit every message", async () => {
    await groupPage();
    focus(msg(2));
    key(msg(2), "ArrowDown");
    expect(msg(3)).toHaveFocus();
    key(msg(3), "ArrowUp");
    key(msg(2), "ArrowUp");
    key(msg(1), "ArrowUp");
    expect(msg(0)).toHaveFocus();
    // A message entered from the box and then one entered by clicking: the click returns the list to its own arrows.
    upFromBox();
    fireEvent.mouseDown(msg(4));
    focus(msg(4));
    key(msg(4), "ArrowUp");
    expect(msg(3)).toHaveFocus();
    key(msg(3), "ArrowUp");
    expect(msg(2)).toHaveFocus();
    key(msg(2), "ArrowUp");
    expect(msg(1)).toHaveFocus();
  });

  it("does not trap: Tab from a message leaves the list, and a later Tab in comes back to the list's own arrows", async () => {
    await groupPage();
    upFromBox();
    key(msg(4), "Tab");
    focus(box());
    focus(msg(4));
    key(msg(4), "ArrowUp");
    expect(msg(3)).toHaveFocus();
    key(msg(3), "ArrowUp");
    key(msg(2), "ArrowUp");
    expect(msg(1)).toHaveFocus();
  });

  it("starts the editor on E, and the confirmation on Delete and on Backspace", async () => {
    await groupPage();
    upFromBox();
    key(msg(4), "e");
    expect(screen.getByRole("textbox", { name: "Edit your message" })).toHaveValue("last one");
    key(screen.getByRole("textbox", { name: "Edit your message" }), "Escape");
    expect(msg(4)).toHaveFocus();
    key(msg(4), "Delete");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    key(screen.getByRole("button", { name: "Cancel" }), "Escape");
    expect(msg(4)).toHaveFocus();
    key(msg(4), "Backspace");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("ignores E and Delete on a message that cannot change and says why, and on a deleted one says there is nothing left", async () => {
    await groupPage();
    upFromBox();
    key(msg(4), "ArrowUp");
    key(msg(3), "e");
    expect(said()).toHaveTextContent("There is nothing left to change.");
    key(msg(3), "Delete");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    key(msg(3), "ArrowUp");
    key(msg(2), "Delete");
    expect(said()).toHaveTextContent(LOCKED);
    key(msg(2), "e");
    expect(screen.queryByRole("textbox", { name: "Edit your message" })).toBeNull();
    key(msg(2), "Enter");
    expect(menu().querySelector(".why")).toHaveTextContent(LOCKED);
  });

  it("goes back one level on Escape: the menu, then the message, then the box", async () => {
    await groupPage();
    upFromBox();
    key(msg(4), "Enter");
    expect(menu()).toBeInTheDocument();
    key(menu(), "Escape");
    await act(async () => void (await new Promise((r) => setTimeout(r, 5))));
    expect(screen.queryByRole("menu", { name: "Your message" })).toBeNull();
    expect(msg(4)).toHaveFocus();
    key(msg(4), "Escape");
    expect(box()).toHaveFocus();
  });

  it("acts only on a key pressed on the row: the Enter that saves an edit does not open the row's menu", async () => {
    await groupPage();
    upFromBox();
    key(msg(4), "e");
    const ta = screen.getByRole("textbox", { name: "Edit your message" });
    fireEvent.change(ta, { target: { value: "last one, edited" } });
    key(ta, "Enter");
    await flush();
    expect(screen.queryByRole("menu", { name: "Your message" })).toBeNull();
    expect(msg(4)).toHaveFocus();
  });

  it("leaves a key with a modifier and a held key alone", async () => {
    await groupPage();
    upFromBox();
    key(msg(4), "e", { ctrlKey: true });
    key(msg(4), "Delete", { metaKey: true });
    key(msg(4), "e", { repeat: true });
    expect(screen.queryByRole("textbox", { name: "Edit your message" })).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("the editor", () => {
  const start = async (chat = fakeChat()) => {
    await groupPage(chat);
    upFromBox();
    key(msg(4), "e");
    return { chat, ta: screen.getByRole("textbox", { name: "Edit your message" }) as HTMLTextAreaElement };
  };

  it("takes the place of the text with the box, Save and Cancel and its hint, hides the delivery line, and has the cursor at the end", async () => {
    const { ta } = await start();
    expect(ta).toHaveValue("last one");
    expect(ta).toHaveFocus();
    expect(ta.selectionStart).toBe("last one".length);
    expect(msg(4)).toHaveClass("editing");
    expect(msg(4).querySelector(".ch-tx")).toBeNull();
    const boxEl = msg(4).querySelector(".ed-box")!;
    expect(boxEl.querySelector(".ch-box")).not.toBeNull();
    expect(boxEl.querySelector(".hint")).toHaveTextContent("Enter to save · Esc to cancel");
    expect(within(boxEl as HTMLElement).getByRole("button", { name: "Save" })).toHaveClass("btn", "pri");
    expect(within(boxEl as HTMLElement).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("saves on Enter and on Save, shows edited with the time, and puts the focus back on the message", async () => {
    const { chat, ta } = await start();
    fireEvent.change(ta, { target: { value: "last one, changed" } });
    key(ta, "Enter");
    await flush();
    expect(chat.fake.editChannelMessage).toHaveBeenCalledWith("group", "q5", "last one, changed");
    expect(screen.queryByRole("textbox", { name: "Edit your message" })).toBeNull();
    const tx = msg(4).querySelector(".ch-tx")!;
    expect(tx).toHaveTextContent("last one, changed");
    const edited = tx.querySelector(".ed-edited")!;
    expect(edited).toHaveTextContent("edited 14:30");
    expect(edited).toHaveAttribute("title", new Date(T0).toLocaleString());
    expect(msg(4)).toHaveFocus();
    expect(said()).toHaveTextContent(/^Your message, 14:20: last one, changed.*edited 14:30/);
    // Save the button does the same.
    key(msg(4), "e");
    fireEvent.change(screen.getByRole("textbox", { name: "Edit your message" }), { target: { value: "third" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await flush();
    expect(chat.fake.editChannelMessage).toHaveBeenLastCalledWith("group", "q5", "third");
  });

  it("adds a line on Shift+Enter, and leaves a key while an IME composes alone", async () => {
    const { chat, ta } = await start();
    key(ta, "Enter", { shiftKey: true });
    key(ta, "Enter", { isComposing: true });
    await flush();
    expect(chat.fake.editChannelMessage).not.toHaveBeenCalled();
    expect(ta).toBeInTheDocument();
  });

  it("cancels on Escape and on Cancel, returning to the message with the text as it was", async () => {
    const { chat, ta } = await start();
    fireEvent.change(ta, { target: { value: "something else" } });
    key(ta, "Escape");
    expect(screen.queryByRole("textbox", { name: "Edit your message" })).toBeNull();
    expect(msg(4).querySelector(".ch-tx")).toHaveTextContent("last one");
    expect(msg(4)).toHaveFocus();
    key(msg(4), "e");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox", { name: "Edit your message" })).toBeNull();
    expect(msg(4)).toHaveFocus();
    expect(chat.fake.editChannelMessage).not.toHaveBeenCalled();
  });

  it("disables Save for empty text, and closes without a request when the text is unchanged", async () => {
    const { chat, ta } = await start();
    fireEvent.change(ta, { target: { value: "  " } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    key(ta, "Enter");
    expect(chat.fake.editChannelMessage).not.toHaveBeenCalled();
    expect(ta).toBeInTheDocument();
    fireEvent.change(ta, { target: { value: "last one " } });
    key(ta, "Enter");
    await flush();
    expect(chat.fake.editChannelMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Edit your message" })).toBeNull();
    expect(msg(4)).toHaveFocus();
  });

  it("shows a refusal under the box, in words, and keeps the box and the text open", async () => {
    const chat = fakeChat();
    const { ta } = await start(chat);
    for (const [status, error] of [
      [422, "To change who is mentioned, delete this message and send a new one."],
      [409, "Podium has already sent this message to Tester, so it can no longer be changed."],
      [429, "That is more than 6 messages a minute, the limit here. Try again in 4 seconds."],
      [404, "That message is gone."],
    ] as const) {
      chat.fake.editChannelMessage.mockRejectedValueOnce(new RespondError(status, { ok: false, error }));
      fireEvent.change(ta, { target: { value: `try ${status}` } });
      key(ta, "Enter");
      await flush();
      expect(within(msg(4)).getByRole("alert")).toHaveTextContent(error);
      expect(ta).toHaveValue(`try ${status}`);
      expect(ta).toBeInTheDocument();
    }
    chat.fake.editChannelMessage.mockRejectedValueOnce(new Error("offline"));
    key(ta, "Enter");
    await flush();
    expect(within(msg(4)).getByRole("alert")).toHaveTextContent("Could not save: the server did not answer. Your message is unchanged. Try again.");
  });

  it("edits a Direct Message through its own route", async () => {
    const chat = fakeChat();
    await groupPage(chat);
    await open("d:dm:person:ed|s-tester");
    focus(msg(0));
    key(msg(0), "e");
    const ta = screen.getByRole("textbox", { name: "Edit your message" });
    fireEvent.change(ta, { target: { value: "Also Debian 13." } });
    key(ta, "Enter");
    await flush();
    expect(chat.fake.editDmMessage).toHaveBeenCalledWith("person:ed", "s-tester", "d1", "Also Debian 13.");
    expect(msg(0).querySelector(".ed-edited")).toHaveTextContent("edited 14:30");
  });

  it("decides by id: a Direct Message from another person with your name is not yours, and has no Edit or Delete (#1284)", async () => {
    const chat = fakeChat();
    // The earlier Ed (id 9) was deleted; this Ed is id 1. The server would send canChange true to no one but the author, so even a stale flag must not show controls.
    chat.w.dmMsgs[0] = { ...chat.w.dmMsgs[0]!, from: { kind: "person", sessionId: "person:ed", personId: 9, name: "Ed", machine: "" } };
    await groupPage(chat);
    await open("d:dm:person:ed|s-tester");
    expect(msg(0).querySelector(".who.me")).toBeNull();
    focus(msg(0));
    key(msg(0), "e");
    expect(screen.queryByRole("textbox", { name: "Edit your message" })).toBeNull();
    key(msg(0), "Delete");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("still gives the real author, whose id matches, the message as theirs", async () => {
    const chat = fakeChat();
    await groupPage(chat);
    await open("d:dm:person:ed|s-tester");
    expect(msg(0).querySelector(".who.me")).not.toBeNull();
  });
});

describe("the delete confirmation", () => {
  const ask = async (chat = fakeChat(), where = "c:group", index = 4) => {
    await groupPage(chat);
    if (where !== "c:group") await open(where);
    focus(msg(index));
    key(msg(index), "Delete");
    return { chat, dlg: screen.getByRole("alertdialog", { name: "Delete this message?" }) };
  };

  it("is an alert dialog with the message quoted, Cancel focused first, and a Delete message button that is not the primary one", async () => {
    const { dlg } = await ask();
    expect(dlg).toHaveAttribute("aria-modal", "true");
    expect(dlg).toHaveAttribute("aria-describedby");
    expect(dlg.querySelector(".ed-q")).toHaveTextContent("last one");
    expect(dlg).toHaveTextContent("It will be deleted for everyone in My group, and the agents there will not see it. This cannot be undone.");
    expect(within(dlg).getByRole("button", { name: "Cancel" })).toHaveFocus();
    const del = within(dlg).getByRole("button", { name: "Delete message" });
    expect(del).toHaveClass("btn", "bad");
    expect(del).not.toHaveClass("pri");
    expect(msg(4)).toHaveClass("ch-sel");
  });

  it("says who loses it for General, a public channel and a Direct Message", async () => {
    const chat = fakeChat();
    await groupPage(chat);
    await open("c:general");
    focus(msg(1));
    key(msg(1), "Delete");
    expect(screen.getByRole("alertdialog")).toHaveTextContent("It will be deleted for everyone in General, and the agents there will not see it. This cannot be undone.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await open("c:release");
    focus(msg(0));
    key(msg(0), "Delete");
    expect(screen.getByRole("alertdialog")).toHaveTextContent("It will be deleted for everyone in #release, and the agents there will not see it. This cannot be undone.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await open("d:dm:person:ed|s-tester");
    focus(msg(0));
    key(msg(0), "Delete");
    expect(screen.getByRole("alertdialog")).toHaveTextContent("It will be deleted for you and for Tester, and Tester will not see it. This cannot be undone.");
  });

  it("moves between Cancel and Delete message with the arrow keys, wrapping, and Tab cycles Close, Cancel and Delete", async () => {
    const { dlg } = await ask();
    const cancel = within(dlg).getByRole("button", { name: "Cancel" });
    const del = within(dlg).getByRole("button", { name: "Delete message" });
    const close = within(dlg).getByRole("button", { name: "Close (Esc)" });
    key(cancel, "ArrowRight");
    expect(del).toHaveFocus();
    key(del, "ArrowRight");
    expect(cancel).toHaveFocus();
    key(cancel, "ArrowLeft");
    expect(del).toHaveFocus();
    key(del, "ArrowDown");
    expect(cancel).toHaveFocus();
    key(cancel, "ArrowUp");
    expect(del).toHaveFocus();
    // The page's own Tab order is Close, Cancel, Delete message; the dialog wraps at each end.
    expect(close.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cancel.compareDocumentPosition(del) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    focus(del);
    key(del, "Tab");
    expect(close).toHaveFocus();
    key(close, "Tab", { shiftKey: true });
    expect(del).toHaveFocus();
  });

  it("cancels on Escape, Cancel and the X, with the focus back on the message and nothing sent", async () => {
    const { chat } = await ask();
    key(screen.getByRole("button", { name: "Cancel" }), "Escape");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(msg(4)).toHaveFocus();
    key(msg(4), "Delete");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(msg(4)).toHaveFocus();
    key(msg(4), "Delete");
    fireEvent.click(screen.getByRole("button", { name: "Close (Esc)" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(chat.fake.deleteChannelMessage).not.toHaveBeenCalled();
  });

  it("deletes on Delete message and leaves the row with a note of who deleted it and when, no text, no menu and no status line", async () => {
    const { chat } = await ask();
    fireEvent.click(screen.getByRole("button", { name: "Delete message" }));
    await flush();
    expect(chat.fake.deleteChannelMessage).toHaveBeenCalledWith("group", "q5");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const row = msg(4);
    const gone = row.querySelector(".ed-del")!;
    expect(gone).toHaveTextContent("This message was deleted by You at 14:30.");
    expect(gone.querySelector("svg")).not.toBeNull();
    expect(row.querySelector(".ch-tx")).toBeNull();
    expect(row.querySelector(".ch-st")).toBeNull();
    expect(row).toHaveFocus();
    expect(fireEvent.contextMenu(row)).toBe(true);
    expect(screen.queryByRole("menu", { name: "Your message" })).toBeNull();
    expect(said()).toHaveTextContent("This message was deleted by You at 14:30.");
  });

  it("deletes a Direct Message through its own route", async () => {
    const { chat } = await ask(fakeChat(), "d:dm:person:ed|s-tester", 0);
    fireEvent.click(screen.getByRole("button", { name: "Delete message" }));
    await flush();
    expect(chat.fake.deleteDmMessage).toHaveBeenCalledWith("person:ed", "s-tester", "d1");
    expect(msg(0).querySelector(".ed-del")).toHaveTextContent("deleted by You");
  });

  it("shows a refusal inside the dialog and keeps it open", async () => {
    const { chat } = await ask();
    chat.fake.deleteChannelMessage.mockRejectedValueOnce(new RespondError(409, { ok: false, reason: "locked", error: LOCKED }));
    fireEvent.click(screen.getByRole("button", { name: "Delete message" }));
    await flush();
    expect(within(screen.getByRole("alertdialog")).getByRole("alert")).toHaveTextContent(LOCKED);
    chat.fake.deleteChannelMessage.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Delete message" }));
    await flush();
    expect(within(screen.getByRole("alertdialog")).getByRole("alert")).toHaveTextContent("Could not delete: the server did not answer. Your message is still there. Try again.");
  });

  it("names someone else's deleted message by its author", async () => {
    const chat = fakeChat();
    chat.w.generalMsgs[0] = cmsg("g1", "", { mine: false, authorName: "Maya", authorRef: "Maya", canChange: false, deletedAt: T0 - 5 * MIN });
    await groupPage(chat);
    await open("c:general");
    expect(msg(0).querySelector(".ed-del")).toHaveTextContent("This message was deleted by Maya at 14:25.");
    expect(msg(0).querySelector(".ch-tx")).toBeNull();
  });
});

describe("live refresh of earlier pages", () => {
  const SEL: Selection = { kind: "channel", id: "general" };
  /** The higher the number, the newer. */
  const row = (id: string, text: string, over: Partial<ChannelMessage> = {}) => cmsg(id, text, { createdAt: T0 - (7 - Number(id.slice(1))) * MIN, ...over });
  /** A server with six messages, m1 the oldest, read two at a time, newest page first. */
  function paged() {
    const all: ChannelMessage[] = ["m1", "m2", "m3", "m4", "m5", "m6"].map((id) => row(id, `text ${id}`));
    const asc = () => [...all].sort((a, b) => a.createdAt - b.createdAt);
    const channelMessages = vi.fn(async (_c: string, o: { before?: string | null; limit?: number } = {}) => {
      const list = asc();
      const end = o.before ? list.findIndex((m) => m.id === o.before) : list.length;
      const start = Math.max(0, end - 2);
      return { ok: true as const, channel: "general" as const, messages: structuredClone(list.slice(start, end)), older: start > 0 ? list[start]!.id : null, total: list.length };
    });
    return { all, channelMessages, api: { channelMessages } as unknown as ChatApi };
  }
  const ids = (r: { current: { messages: { id: string }[] } }) => r.current.messages.map((m) => m.id);
  const loaded = async (s: ReturnType<typeof paged>, pages: number) => {
    vi.useRealTimers();
    const landing = new Landing();
    const hook = renderHook(({ rev }) => useThread(s.api, SEL, rev, null, landing), { initialProps: { rev: 0 } });
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    for (let i = 0; i < pages; i++) await act(async () => void (await hook.result.current.loadEarlier()));
    return hook;
  };

  it("shows an edit and a delete made in an earlier page that is already loaded, without a reload", async () => {
    const s = paged();
    const { result, rerender } = await loaded(s, 2);
    expect(ids(result)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(result.current.older).toBeNull();
    // Another console changes a message in the oldest page and deletes one in the middle one.
    s.all[0] = row("m1", "text m1, edited", { editedAt: T0 });
    s.all[2] = row("m3", "", { deletedAt: T0 });
    rerender({ rev: 1 });
    await waitFor(() => expect(result.current.messages.find((m) => m.id === "m1")?.channel?.text).toBe("text m1, edited"));
    expect(result.current.messages.find((m) => m.id === "m3")?.channel?.deletedAt).toBe(T0);
    expect(ids(result)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(result.current.total).toBe(6);
    expect(result.current.older).toBeNull();
  });

  it("reads one request more for each earlier page it kept, and none for a thread with none", async () => {
    const s = paged();
    const { result, rerender } = await loaded(s, 0);
    s.channelMessages.mockClear();
    rerender({ rev: 1 });
    await waitFor(() => expect(s.channelMessages).toHaveBeenCalledTimes(1));
    await flush();
    await act(async () => void (await result.current.loadEarlier()));
    s.channelMessages.mockClear();
    rerender({ rev: 2 });
    await waitFor(() => expect(s.channelMessages).toHaveBeenCalledTimes(2));
    await flush();
    expect(ids(result)).toEqual(["m3", "m4", "m5", "m6"]);
  });

  it("keeps the earlier pages, and loses none off the old end, when a new message arrives", async () => {
    const s = paged();
    const { result, rerender } = await loaded(s, 1);
    expect(ids(result)).toEqual(["m3", "m4", "m5", "m6"]);
    s.all.push(row("m7", "newest"));
    rerender({ rev: 1 });
    await waitFor(() => expect(result.current.total).toBe(7));
    await waitFor(() => expect(ids(result)).toEqual(["m2", "m3", "m4", "m5", "m6", "m7"]));
    expect(result.current.older).toBe("m2");
  });

  it("does not put an earlier page of the old thread under another one when it lands after the switch (#1296)", async () => {
    const s = paged();
    vi.useRealTimers();
    const landing = new Landing();
    const hook = renderHook(({ sel }) => useThread(s.api, sel, 0, null, landing), { initialProps: { sel: SEL } });
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    let land: () => void = () => undefined;
    const held = new Promise<void>((r) => (land = r));
    const real = s.channelMessages.getMockImplementation()!;
    s.channelMessages.mockImplementationOnce(async (...a: Parameters<typeof real>) => {
      const out = await real(...a);
      await held;
      return out;
    });
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = hook.result.current.loadEarlier();
    });
    await flush();
    s.channelMessages.mockImplementationOnce(() => new Promise(() => undefined));
    hook.rerender({ sel: { kind: "channel", id: "other" } });
    await act(async () => {
      land();
      await pending;
    });
    expect(hook.result.current.messages).toEqual([]);
    expect(hook.result.current.older).toBeNull();
    expect(hook.result.current.loadingEarlier).toBe(false);
  });

  it("keeps the page Earlier messages loaded while a read for a signal waits in the Landing, and the result of that read (#1296)", async () => {
    const s = paged();
    vi.useRealTimers();
    const landing = new Landing();
    const hook = renderHook(({ rev }) => useThread(s.api, SEL, rev, null, landing), { initialProps: { rev: 0 } });
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    await act(async () => void (await hook.result.current.loadEarlier()));
    expect(ids(hook.result)).toEqual(["m3", "m4", "m5", "m6"]);
    // Another read is out, so the read for the signal waits in the Landing with its answer; a message arrives and a message is edited with it.
    let release: () => void = () => undefined;
    void landing.run(() => new Promise((done) => (release = () => done(null))), () => () => undefined);
    s.all.push(row("m7", "newest"));
    s.all[3] = row("m4", "text m4, edited", { editedAt: T0 });
    hook.rerender({ rev: 1 });
    await flush();
    // The person asks for the earlier page meanwhile.
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = hook.result.current.loadEarlier();
    });
    await flush();
    await act(async () => {
      release();
      await pending;
    });
    await waitFor(() => expect(ids(hook.result)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7"]));
    expect(hook.result.current.messages.find((m) => m.id === "m4")?.channel?.text).toBe("text m4, edited");
    expect(hook.result.current.older).toBeNull();
    expect(hook.result.current.total).toBe(7);
    expect(hook.result.current.loadingEarlier).toBe(false);
  });

  it("keeps the result of a read for a signal that comes while Earlier messages is still reading, and the page it loads (#1296)", async () => {
    const s = paged();
    vi.useRealTimers();
    const landing = new Landing();
    const hook = renderHook(({ rev }) => useThread(s.api, SEL, rev, null, landing), { initialProps: { rev: 0 } });
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    await act(async () => void (await hook.result.current.loadEarlier()));
    let land: () => void = () => undefined;
    const held = new Promise<void>((r) => (land = r));
    const real = s.channelMessages.getMockImplementation()!;
    s.channelMessages.mockImplementationOnce(async (...a: Parameters<typeof real>) => {
      const out = await real(...a);
      await held;
      return out;
    });
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = hook.result.current.loadEarlier();
    });
    await flush();
    s.all.push(row("m7", "newest"));
    s.all[3] = row("m4", "text m4, edited", { editedAt: T0 });
    hook.rerender({ rev: 1 });
    await flush();
    await act(async () => {
      land();
      await pending;
    });
    await waitFor(() => expect(ids(hook.result)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7"]));
    expect(hook.result.current.messages.find((m) => m.id === "m4")?.channel?.text).toBe("text m4, edited");
    expect(hook.result.current.older).toBeNull();
    expect(hook.result.current.loadingEarlier).toBe(false);
  });

  it("asks for no earlier page of a thread that was left for another while it waited behind a read for a signal (#1296)", async () => {
    const s = paged();
    vi.useRealTimers();
    const landing = new Landing();
    const hook = renderHook(({ sel, rev }) => useThread(s.api, sel, rev, null, landing), { initialProps: { sel: SEL, rev: 0 } });
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    await act(async () => void (await hook.result.current.loadEarlier()));
    let release: () => void = () => undefined;
    void landing.run(() => new Promise((done) => (release = () => done(null))), () => () => undefined);
    hook.rerender({ sel: SEL, rev: 1 });
    await flush();
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = hook.result.current.loadEarlier();
    });
    await flush();
    hook.rerender({ sel: { kind: "channel", id: "other" }, rev: 1 });
    await flush();
    s.channelMessages.mockClear();
    await act(async () => {
      release();
      await pending;
    });
    expect(ids(hook.result)).toEqual(["m5", "m6"]);
    expect(hook.result.current.loadingEarlier).toBe(false);
    expect(s.channelMessages.mock.calls.filter(([, o]) => o?.before)).toEqual([]);
  });

  it("still sees a clear: fewer messages than are shown drops the earlier pages", async () => {
    const s = paged();
    const { result, rerender } = await loaded(s, 1);
    expect(result.current.messages).toHaveLength(4);
    s.all.splice(0, s.all.length, row("m9", "after the clear"));
    rerender({ rev: 1 });
    await waitFor(() => expect(ids(result)).toEqual(["m9"]));
    expect(result.current.total).toBe(1);
    expect(result.current.older).toBeNull();
  });

  it("does not take a delete for a clear: the total stays, so the earlier pages stay", async () => {
    const s = paged();
    const { result, rerender } = await loaded(s, 1);
    s.all[2] = row("m3", "", { deletedAt: T0 });
    rerender({ rev: 1 });
    await waitFor(() => expect(result.current.messages.find((m) => m.id === "m3")?.channel?.deletedAt).toBe(T0));
    expect(ids(result)).toEqual(["m3", "m4", "m5", "m6"]);
  });

  it("keeps what it showed when an earlier page cannot be read again", async () => {
    const s = paged();
    const { result, rerender } = await loaded(s, 1);
    s.channelMessages.mockImplementationOnce(s.channelMessages.getMockImplementation()!);
    s.channelMessages.mockRejectedValueOnce(new Error("offline"));
    rerender({ rev: 1 });
    await flush();
    expect(ids(result)).toEqual(["m3", "m4", "m5", "m6"]);
    expect(result.current.error).toBeNull();
  });

  it("patches one row by its id, in the newest page or an earlier one, and adds none", async () => {
    const s = paged();
    const { result } = await loaded(s, 1);
    act(() => result.current.patch(row("m1", "not loaded")));
    expect(ids(result)).toEqual(["m3", "m4", "m5", "m6"]);
    act(() => result.current.patch(row("m6", "patched", { editedAt: T0 })));
    expect(result.current.messages.find((m) => m.id === "m6")?.channel?.text).toBe("patched");
    act(() => result.current.patch(row("m4", "patched earlier", { editedAt: T0 })));
    expect(result.current.messages.find((m) => m.id === "m4")?.channel?.text).toBe("patched earlier");
    expect(ids(result)).toEqual(["m3", "m4", "m5", "m6"]);
  });
});

describe("accessibility of the new surfaces", () => {
  const scan = async (root: Element) => {
    const r = await axe.run(root as axe.ElementContext, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
      rules: { "color-contrast": { enabled: false }, "target-size": { enabled: false }, "scrollable-region-focusable": { enabled: false }, "link-in-text-block": { enabled: false }, region: { enabled: false } },
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  };

  it("passes axe with the menu open, a locked menu open, the editor open and the dialog open", async () => {
    vi.useRealTimers();
    const { container } = await groupPage();
    fireEvent.contextMenu(msg(0));
    expect(await scan(container)).toEqual([]);
    key(menu(), "Escape");
    fireEvent.contextMenu(msg(2));
    expect(await scan(container)).toEqual([]);
    key(menu(), "Tab");
    focus(msg(4));
    key(msg(4), "e");
    expect(await scan(container)).toEqual([]);
    key(screen.getByRole("textbox", { name: "Edit your message" }), "Escape");
    key(msg(4), "Delete");
    expect(await scan(document.body)).toEqual([]);
  });
});
