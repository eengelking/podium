// The Chat screens, the notices an Admin's read leaves for the person, and the pages beside them (#1034, #1073 to #1075, #726): each is the real
// component against a small fake server with the data the page tests use. Times count from the harness clock (T0).
import { act, fireEvent, screen } from "@testing-library/react";
import { vi, type MockInstance } from "vitest";
import { FleetView } from "../FleetApp";
import { FocusView } from "../components/FocusView";
import { SessionReadNotes } from "../components/SessionReadNotes";
import { MyUsagePage } from "../MyUsage";
import { makeAgent, makeRecording, makeSession } from "../fixtures";
import { SessionReadsProvider } from "../sessionReads";
import { ReplayReadsProvider } from "../replayReads";
import { stateFrom } from "../testState";
import { RespondProvider } from "../useRespond";
import type { Address, AdminRead, AdminReading, ChannelMessage, ChatApi, ChatOverview, DirectInfo, DirectMessage, DirectPageRead, Party } from "../chatData";
import type { ReportReply, ReportsClient } from "../admin/reportsApi";
import type { PeersApi, RespondApi } from "../respondApi";
import type { RespondMe } from "../types";
import type { Screen } from "./screens";

const T0 = new Date(2026, 9, 12, 14, 30).getTime();
const ED: RespondMe = { enabled: true, signedIn: true, name: "Ed", admin: false };
const ROOT: RespondMe = { enabled: true, signedIn: true, name: "Admin", admin: true };
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
let clock: MockInstance<() => number> | undefined;
const stopClock = () => clock?.mockRestore();

const agent = (sessionId: string, name: string, machine = "ed-mbp", over: Partial<Party> = {}): Party => ({ sessionId, name, machine, reporterKey: `k-${machine}`, kind: "agent", live: true, status: "running", ...over });
const ME: Party = { sessionId: "person:ed", name: "Ed", machine: "", reporterKey: "", kind: "person", live: true, status: null };
const DASH = agent("s-dash", "claude-dashboard");
const TESTER = agent("s-tester", "Tester", "ci-runner-01", { status: "waiting" });
const NOTES = agent("s-notes", "infra-notes");

const direct = (a: Party, b: Party, over: Partial<DirectInfo> = {}): DirectInfo => ({
  thread: `dm:${a.sessionId}|${b.sessionId}`, a, b, owner: "Ed", messages: 6, lastAt: T0, state: "active", paused: false, canSend: { aToB: true, bToA: true }, roundTrips: { used: 3, cap: 10 }, ended: [], unread: 0, mentions: 0, hiddenAt: null, ...over,
});
const channelOf = (id: "general" | "group", over: Partial<ChatOverview["channels"][number]> = {}): ChatOverview["channels"][number] => ({
  id, name: id === "general" ? "General" : "My group", thread: id === "general" ? "public" : "group:ed", unread: 0, mentions: 0, messages: 3, paused: false, pausedForEveryone: false, disconnected: false,
  can: id === "general" ? { pause: true, pauseEveryone: false, disconnect: true, removeAll: false } : { pause: true, pauseEveryone: false, disconnect: true, removeAll: true }, ...over,
});
const cmsg = (id: string, text: string, over: Partial<ChannelMessage> = {}): ChannelMessage => ({ id, authorKind: "person", authorName: "Ed", authorRef: "Ed", text, createdAt: T0 - 600_000, updatedAt: T0 - 600_000, replyTo: null, issue: null, project: null, milestone: null, mine: true, mentions: [], ...over });
const dmsg = (id: string, from: Party, to: Party, text: string, over: Partial<DirectMessage> = {}): DirectMessage => ({
  id, author: from.kind === "person" ? "person" : "agent", from: { kind: from.kind, sessionId: from.sessionId, name: from.name, machine: from.machine },
  to: [{ sessionId: to.sessionId, name: to.name, machine: to.machine, state: "delivered", why: null }], text, sentAt: T0 - 500_000, state: "delivered", stateAt: T0 - 490_000, why: null, approved: false, ...over,
});
const BOOK: Address[] = [
  { typed: "claude-dashboard@ed-mbp", label: "Orchestrator", role: "orchestrator", sessionId: "s-dash" },
  { typed: "Tester@ci-runner-01", label: "Orchestrator", role: "orchestrator", sessionId: "s-tester" },
  { typed: "Maya@console", label: "Person", role: "person", sessionId: null },
  { typed: "group", label: "Everyone in My group", role: "group", sessionId: null, disabled: true, why: "Off. An Admin turns it on in Admin > Settings." },
];
const live = (admin: string, since = T0 - 60_000): AdminReading => ({ admin, since, until: T0 + 30_000 });
const MAYA_DM = direct(agent("m-1", "maya-api", "maya-mbp"), agent("m-2", "maya-ui", "maya-mbp"), { owner: "Maya", thread: "dm:m-1|m-2", unread: 5 });

interface World { overview: ChatOverview; owners?: Record<string, Partial<ChatOverview>> }
function world(over: { directs?: DirectInfo[]; channels?: ChatOverview["channels"]; admin?: boolean } = {}): World {
  const overview: ChatOverview = {
    enabled: true, serverTime: T0, me: { name: "Ed", admin: false, person: true },
    settings: { maxChars: 20000, perMinute: 6, retainDays: 30, graceHours: 24, everyone: false },
    channels: over.channels ?? [channelOf("general"), channelOf("group", { mentions: 1, messages: 2 })],
    directs: over.directs ?? [direct(DASH, TESTER, { unread: 2 }), direct(ME, NOTES, { messages: 2, thread: "dm:person:ed|s-notes" }), direct(DASH, NOTES, { state: "paused", paused: true, messages: 1 })],
    agents: [
      { sessionId: "s-dash", name: "claude-dashboard", machine: "ed-mbp", reporterKey: "k-ed-mbp", address: "claude-dashboard@ed-mbp", status: "running", waitReason: null, peers: true },
      { sessionId: "s-tester", name: "Tester", machine: "ci-runner-01", reporterKey: "k-ci-runner-01", address: "Tester@ci-runner-01", status: "waiting", waitReason: "input", peers: true },
      { sessionId: "s-notes", name: "infra-notes", machine: "ed-mbp", reporterKey: "k-ed-mbp", address: "infra-notes@ed-mbp", status: "waiting", waitReason: "permission", peers: true },
    ],
    people: [{ name: "Ed", you: true }, { name: "Maya", you: false }],
  };
  if (!over.admin) return { overview };
  overview.me = { name: "Root", admin: true, person: false };
  overview.channels = [channelOf("general", { can: { pause: false, pauseEveryone: true, disconnect: false, removeAll: true } })];
  overview.directs = [];
  overview.agents = [];
  overview.people = [{ name: "Ed", you: false }, { name: "Maya", you: false }];
  return { overview, owners: { Maya: { channels: [channelOf("general", { can: { pause: false, pauseEveryone: true, disconnect: false, removeAll: true } }), channelOf("group", { thread: "group:maya", messages: 1, adminReading: [] })], directs: [MAYA_DM] } } };
}

const DMS: Record<string, DmPage> = {
  "s-dash|s-tester": { messages: [dmsg("m1", DASH, TESTER, "Please run the tests.\nReport each failure."), dmsg("m2", TESTER, DASH, "2 failed. The token is [redacted]."), dmsg("m3", ME, TESTER, "Also Debian 12.", { state: "queued" })], total: 6, older: "cur-1" },
  "person:ed|s-notes": { messages: [dmsg("n1", ME, NOTES, "Add the install steps.")], total: 2 },
  "s-dash|s-notes": { messages: [dmsg("p1", DASH, NOTES, "Here are the units.", { state: "ready" })], total: 1 },
  "m-1|m-2": { messages: [dmsg("x1", agent("m-1", "maya-api", "maya-mbp"), agent("m-2", "maya-ui", "maya-mbp"), "Maya's agents talking.")], total: 1 },
};
interface DmPage { messages: DirectMessage[]; older?: string | null; total: number }

function chatApi(w: World): ChatApi {
  const all = () => [...w.overview.directs, ...Object.values(w.owners ?? {}).flatMap((o) => o.directs ?? [])];
  return {
    overview: async (owner?: string | null) => structuredClone(owner && w.owners?.[owner] ? { ...w.overview, ...w.owners[owner] } : w.overview),
    markRead: async () => ({ ok: true as const, unread: 0, mentions: 0 }),
    addresses: async () => ({ ok: true as const, addresses: structuredClone(BOOK) }),
    channelMessages: async (channel: string) => ({ ok: true as const, channel: channel as "general", messages: [cmsg("g1", "Heads up: staging restarts at 17:00.", { mine: false, authorName: "Maya", authorRef: "Maya" }), cmsg("g2", "Thanks.")], older: null, total: 2 }),
    readingChannel: async () => ({ ok: true as const }),
    readingDm: async () => ({ ok: true as const }),
    dmMessages: async (a: string, b: string): Promise<DirectPageRead> => {
      const key = [a === "me" ? "person:ed" : a, b].sort((p, q) => p.localeCompare(q)).join("|");
      const hit = Object.keys(DMS).find((k) => k.split("|").sort((p, q) => p.localeCompare(q)).join("|") === key)!;
      const d = all().find((x) => [x.a.sessionId, x.b.sessionId].sort((p, q) => p.localeCompare(q)).join("|") === key)!;
      const t = DMS[hit]!;
      return { ok: true, thread: d.thread, a: d.a, b: d.b, messages: structuredClone(t.messages), older: t.older ?? null, total: t.total, ended: d.ended, owner: d.owner, paused: d.paused, roundTrips: d.roundTrips, cross: d.cross ?? null, pausedBy: d.pausedBy ?? null, pausedByAdmin: d.pausedByAdmin ?? null };
    },
  } as unknown as ChatApi;
}

const respondApi = (me: RespondMe) => ({ me: async () => me, signIn: vi.fn(), signOut: vi.fn(), ask: vi.fn(), answer: vi.fn(), message: vi.fn(), discard: vi.fn() }) as unknown as RespondApi;
const peersApi = () => ({ read: async () => ({ enabled: true, owner: "Ed", requests: [], reporters: [], rights: [], serverTime: T0, serverStartedAt: 0, defaults: { trust: false, onRequest: "ask", newSend: "ask", limits: {} }, limits: { server: {}, effective: {} } }), setRight: vi.fn(), setDefaults: vi.fn(), answer: vi.fn() }) as unknown as PeersApi;

function chat(w: World, me: RespondMe, after?: (b: HTMLElement) => Promise<void>): Screen {
  return {
    make: () => {
      clock = vi.spyOn(Date, "now").mockReturnValue(T0);
      window.location.hash = "#/chat";
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ entries: [], since: T0, live: true, enabled: true, serverTime: T0 }) })));
      const sessions = [
        makeSession({ id: "s-dash", name: "claude-dashboard", status: "running", lastSeenAt: T0, owner: "Ed", machine: { name: "ed-mbp", id: "m1", os: "macOS 26.1" } }),
        makeSession({ id: "s-tester", name: "Tester", status: "waiting", waitReason: "input", lastSeenAt: T0, owner: "Ed", machine: { name: "ci-runner-01", id: "m2", os: "Ubuntu 24.04" } }),
      ];
      return <FleetView chat respondApi={respondApi(me)} peersApi={peersApi()} chatApi={chatApi(w)} state={stateFrom({ sessions, features: { "activity-feed": true, "peer-messaging": true } })} />;
    },
    act: async (b) => { await flush(); await after?.(b); },
    cleanup: stopClock,
  };
}

const click = (el: Element | null) => { if (!el) throw new Error("screen: nothing to click"); fireEvent.click(el); };
const openDash = async (b: HTMLElement) => { click(b.querySelector('[data-testid="chat-row-d:dm:s-dash|s-tester"] .ch-row')); await flush(); };

const withReaders = (readers: AdminReading[], groupReaders: AdminReading[] = []) => world({ directs: [direct(DASH, TESTER, { adminReading: readers }), direct(ME, NOTES, { thread: "dm:person:ed|s-notes", messages: 2 })], channels: [channelOf("general"), channelOf("group", { adminReading: groupReaders })] });
const pickMaya = async () => { fireEvent.change(screen.getByLabelText("Read a person's conversations"), { target: { value: "Maya" } }); await flush(); };
const typeAt = async () => {
  const box = screen.getByTestId("chat-box") as HTMLTextAreaElement;
  box.focus();
  fireEvent.change(box, { target: { value: "hi @", selectionStart: 4 } });
  box.setSelectionRange(4, 4);
  fireEvent.change(box, { target: { value: "hi @" } });
  await flush();
};

// ---- the notices an Admin's read of a session leaves for its owner -------------------------------------------------
const rd = (admin: string, startedAt: number): AdminRead => ({ admin, startedAt, lastSeenAt: startedAt + 60_000, kind: "read" });
function notesFor(readers: AdminReading[], records: AdminRead[], render: (s: ReturnType<typeof makeSession>) => React.ReactElement): Screen {
  const s = makeSession({ id: "s1", name: "history-paging", owner: "Ed", agents: [makeAgent({ id: "p", description: "Port the endpoints" })] });
  return {
    make: () => {
      clock = vi.spyOn(Date, "now").mockReturnValue(T0);
      const api = {
        ...respondApi(ED),
        sessionReadRecords: async () => ({ ok: true as const, serverTime: T0, adminReads: records, adminReading: [] }),
        sessionReads: async () => ({ ok: true as const, serverTime: T0, readers: { ask: { s1: readers } } }),
        sessionReading: async () => ({ ok: true as const }),
        recordingReads: async () => ({ ok: true as const, serverTime: T0, sessions: { s1: readers } }),
        recordingConsent: async () => ({ ok: true as const, grant: makeRecording(), adminReads: records, adminReading: readers }),
      } as unknown as RespondApi;
      return (
        <RespondProvider api={api} flagsOn recordingOn>
          <SessionReadsProvider rev={1}>
            <ReplayReadsProvider rev={1}>{render(s)}</ReplayReadsProvider>
          </SessionReadsProvider>
        </RespondProvider>
      );
    },
    act: flush,
    cleanup: stopClock,
  };
}
const CFG = { staleAfterMs: 15_000, dropAfterMs: 60_000, lingerMs: 8_000, detachedHideAfterMs: 60_000 };
const noop = () => {};
const focus = (s: ReturnType<typeof makeSession>) => <FocusView s={s} now={T0} config={CFG} sort={{ key: null, dir: 1 }} onSort={noop} selectedAgent={null} flashAgent={null} onAgent={noop} />;

// ---- My usage ------------------------------------------------------------------------------------------------------
const usage = (report: string, columns: ReportReply["columns"], rows: ReportReply["rows"], total: ReportReply["total"] = {}): ReportReply =>
  ({ report, from: "2026-09-21", to: "2026-10-20", by: "day", tz: "Europe/Berlin", basedOn: "rollups and live", oldestDay: "2026-08-01", partial: false, harnesses: ["claude-code"], columns, rows, total }) as unknown as ReportReply;
const USAGE: Record<string, ReportReply> = {
  spend: usage("spend", [{ key: "period", label: "Period", unit: "date" }, { key: "key", label: "Model", unit: "text" }, { key: "sessions", label: "Sessions", unit: "count" }, { key: "costUsd", label: "Cost (USD)", unit: "usd" }], [{ period: "2026-10-05", key: "Opus 5.5", sessions: 31, costUsd: 71.2 }], { sessions: 31, costUsd: 71.2 }),
  sessions: usage("sessions", [{ key: "period", label: "Period", unit: "date" }, { key: "key", label: "Outcome", unit: "text" }, { key: "sessions", label: "Sessions", unit: "count" }], [{ period: "2026-10-05", key: "completed", sessions: 81 }]),
  failures: usage("failures", [{ key: "period", label: "Period", unit: "date" }, { key: "key", label: "Failure class", unit: "text" }, { key: "count", label: "Failures", unit: "count" }], [{ period: "2026-10-05", key: "permission", count: 3 }]),
  tools: usage("tools", [{ key: "period", label: "Period", unit: "date" }, { key: "harness", label: "Harness", unit: "text" }, { key: "tool", label: "Tool", unit: "text" }, { key: "calls", label: "Calls", unit: "count" }], [{ period: "2026-10-05", harness: "claude-code", server: "", tool: "Bash", calls: 12 }], { calls: 12 }),
};
const usageClient: ReportsClient = {
  get: async <T,>(path: string) => {
    const name = path.replace(/^\/reports\//, "").split("?")[0]!;
    return (path.includes("breakdown=project") ? usage("spend", [{ key: "period", label: "Period", unit: "date" }, { key: "key", label: "Project", unit: "text" }, { key: "sessions", label: "Sessions", unit: "count" }], [{ period: "2026-10-05", key: "podium", sessions: 52 }]) : USAGE[name]!) as unknown as T;
  },
  text: async () => "csv",
};

export const CHAT_SCREENS: Record<string, Screen> = {
  "chat-page": chat(world(), ED, openDash),
  "chat-reading": chat(withReaders([live("Root")], [live("Root")]), ED, openDash),
  "chat-menu": chat(world(), ED, async () => { click(screen.getByRole("button", { name: "Actions for claude-dashboard, Tester" })); await flush(); }),
  "chat-picker": chat(world(), ED, async () => { click(document.querySelector('[data-testid="chat-row-c:group"] .ch-row')); await flush(); await typeAt(); }),
  "chat-admin-read": chat(world({ admin: true }), ROOT, async (b) => {
    await pickMaya();
    click(b.querySelector('[data-testid="chat-row-d:dm:m-1|m-2"] .ch-row'));
    await flush();
  }),
  "chat-orchestrator-button": {
    make: () => {
      window.location.hash = "#/?open=s-dash";
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ entries: [], since: T0, live: true, enabled: true, serverTime: T0 }) })));
      const state = stateFrom({ sessions: [makeSession({ id: "s-dash", name: "claude-dashboard", status: "running", lastSeenAt: T0, owner: "Ed" })], features: { "activity-feed": true, "peer-messaging": true } });
      return <FleetView respondApi={respondApi(ED)} peersApi={peersApi()} chatApi={chatApi(world())} state={state} />;
    },
    act: flush,
  },
  "read-notes": notesFor([live("Root")], [rd("Alex", T0 - 3_600_000)], (s) => focus({ ...s, status: "waiting", waitReason: "input" } as never)),
  "read-notes-above": notesFor([], [rd("Alex", T0 - 3_600_000)], (s) => <div className="podium"><SessionReadNotes kind="ask" session={{ id: s.id, name: s.name, owner: s.owner }} placement="above" /></div>),
  "rec-notes": notesFor([live("Root")], [rd("Alex", T0 - 3_600_000)], (s) => <RespondProviderFocus s={{ ...s, recording: makeRecording() } as never} />),
  "my-usage": {
    make: () => {
      clock = vi.spyOn(Date, "now").mockReturnValue(T0);
      return <div className="podium"><MyUsagePage me={ED} on client={usageClient} /></div>;
    },
    act: async () => { await screen.findByRole("table", { name: "Spend" }); await flush(); },
    cleanup: stopClock,
  },
};

function RespondProviderFocus({ s }: { s: ReturnType<typeof makeSession> }) { return focus(s); }
