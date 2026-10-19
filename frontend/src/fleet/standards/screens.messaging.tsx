// The orchestrator-messaging screens (#347, #354): My reporters, Traffic and the file diff modal, each the real component against
// a small fake server with the same data the page tests use. Times count from the harness clock (2,000,000 ms).
import { act, fireEvent, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import { FleetView } from "../FleetApp";
import { FilesList } from "../components/FilesList";
import { VIEW_KEY } from "../components/PeerRights";
import { makeSession } from "../fixtures";
import type { PeerLevel, PeerReporter, PeerRequestView, PeersRead } from "../peers";
import { RespondError, type PeersApi, type RespondApi } from "../respondApi";
import { stateFrom } from "../testState";
import type { PeerMessage, TrafficApi, TrafficEnd, TrafficLink, TrafficRead } from "../trafficData";
import type { FileDiffReply, FilesReport, RespondMe } from "../types";
import { RespondProvider } from "../useRespond";
import type { Screen } from "./screens";

const T0 = 2_000_000;
const MIN = 60_000;
const ED: RespondMe = { enabled: true, signedIn: true, name: "Ed", admin: false };
const OUT: RespondMe = { enabled: true, signedIn: false, name: null, admin: false };
const ANN_ADMIN: RespondMe = { enabled: true, signedIn: true, name: "Ann", admin: true };
const flush = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });

function respondApi(me: RespondMe): RespondApi {
  return { me: async () => me, signIn: vi.fn(), signOut: vi.fn(), ask: vi.fn(), answer: vi.fn(), message: vi.fn(), discard: vi.fn() } as unknown as RespondApi;
}
const quietFeed = () => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ entries: [], since: T0, live: true, enabled: true, serverTime: T0 }) })));

// ---- My reporters -----------------------------------------------------------------------------------------------
const rep = (key: string, machine: string, over: Partial<PeerReporter> = {}): PeerReporter => ({
  key, machine, owner: "Ed", adminSecret: false, os: "macOS 26.1", peers: true, version: "1.2.0", state: "reporting", lastSeenAt: T0 - 40_000, compat: "ok", live: [], ...over,
});
const PROPOSAL: PeerRequestView = { id: "prq_p", kind: "proposal", at: T0 - 5 * MIN, from: { machine: "build-pi", name: null }, to: { machine: "ed-mbp", name: null }, fromKey: "k3", toKey: "k1", level: "ask", by: "Admin", reason: null, text: null, messageId: null };
const ACCESS: PeerRequestView = { id: "prq_a", kind: "access", at: T0 - MIN, from: { machine: "ci-runner-01", name: "Tester" }, to: { machine: "build-pi", name: null }, fromKey: "k2", toKey: "k3", level: "ask", by: "Tester", reason: "I need the arm64 build.", text: null, messageId: null };
const MESSAGE: PeerRequestView = { id: "prq_m", kind: "message", at: T0 - 42_000, from: { machine: "ed-mbp", name: "claude-dashboard" }, to: { machine: "build-pi", name: "arm64-check" }, fromKey: "k1", toKey: "k3", level: null, by: "claude-dashboard", reason: null, text: "Run npm run test:mod. The token is [redacted].", messageId: "dlv_1" };

function peersRead(over: Partial<PeersRead> = {}): PeersRead {
  return {
    enabled: true,
    owner: "Ed",
    serverTime: T0,
    serverStartedAt: T0 - 30 * MIN,
    reporters: [
      rep("k1", "ed-mbp", { live: [{ sessionId: "s-mac", name: "claude-dashboard", status: "running", peers: true }] }),
      rep("k2", "ci-runner-01", { os: "Ubuntu 24.04", state: "idle", lastSeenAt: T0 - 10 * MIN }),
      rep("k3", "build-pi", { os: "Debian 12, arm64", state: "restart", lastSeenAt: T0 - 20 * MIN }),
      rep("k4", "win-lab", { os: "Windows 11", peers: false, version: "1.1.0", state: "silent", lastSeenAt: T0 - 30 * MIN }),
    ],
    rights: [
      { from: "k1", to: "k1", owner: "Ed", level: "send", paused: true, setAt: 1 },
      { from: "k1", to: "k2", owner: "Ed", level: "send", paused: false, setAt: 1 },
      { from: "k2", to: "k1", owner: "Ed", level: "send", paused: false, setAt: 1 },
      { from: "k3", to: "k1", owner: "Ed", level: "see", paused: false, setAt: 1 },
    ],
    defaults: { trust: false, onRequest: "ask", newSend: "ask", limits: {} },
    limits: { server: { roundTrips: 10, perMinute: 6, maxChars: 20_000 }, effective: { roundTrips: 10, perMinute: 6, maxChars: 20_000 } },
    requests: [PROPOSAL, ACCESS, MESSAGE],
    ...over,
  };
}

function peersApi(read: PeersRead, over: Partial<PeersApi> = {}): PeersApi {
  return {
    read: async () => structuredClone(read),
    setRight: async (_f: string, _t: string, _l: PeerLevel) => ({ ok: true as const }),
    setDefaults: async () => ({ ok: true as const, defaults: read.defaults }),
    answer: async () => ({ ok: true as const, outcome: "allowed" }),
    ...over,
  } as unknown as PeersApi;
}

interface Opts {
  read?: Partial<PeersRead>;
  api?: Partial<PeersApi>;
  me?: RespondMe;
  flag?: boolean;
  view?: "grid" | "board";
  after?: () => unknown;
}

function mine({ read, api, me = ED, flag = true, view, after }: Opts = {}): Screen {
  return {
    make: () => {
      quietFeed();
      if (view) localStorage.setItem(VIEW_KEY, JSON.stringify(view));
      const state = stateFrom({ sessions: [makeSession({ id: "s-mac", name: "claude-dashboard", lastSeenAt: T0 - 40_000, owner: "Ed" })], features: { "activity-feed": true, "peer-messaging": flag } });
      return <FleetView myReporters state={state} respondApi={respondApi(me)} peersApi={peersApi(peersRead(read), api)} />;
    },
    act: async () => {
      await flush();
      await after?.();
      await flush();
    },
  };
}
const pick = (from: string, to: string, level: string) => fireEvent.change(screen.getByLabelText(`${from} to ${to}`), { target: { value: level } });

// ---- Traffic ----------------------------------------------------------------------------------------------------
const end = (sessionId: string, name: string, machine: string, reporterKey: string): TrafficEnd => ({ sessionId, name, machine, reporterKey });
const DEV = end("s-dev", "claude-dashboard", "ed-mbp", "k1");
const NOTES = end("s-notes", "infra-notes", "ed-mbp", "k1");
const TESTER = end("s-tester", "Tester", "ci-runner-01", "k2");
const ARM = end("s-arm", "arm64-check", "build-pi", "k3");
const link = (a: TrafficEnd, b: TrafficEnd, over: Partial<TrafficLink> = {}): TrafficLink => ({
  link: `${a.reporterKey}|${b.reporterKey}`, a, b, owner: "Ed", messages: 2, lastAt: T0 - MIN, state: "active", aToB: true, bToA: true, roundTrips: { used: 2, cap: 10 }, ...over,
});
const LINKS = (): TrafficLink[] => [
  link(DEV, TESTER, { messages: 5 }),
  link(DEV, ARM, { state: "waiting", bToA: false, roundTrips: { used: 0, cap: 10 }, lastAt: T0 - 4 * MIN }),
  link(NOTES, TESTER, { lastAt: T0 - 22 * MIN }),
  link(DEV, NOTES, { messages: 3, state: "paused", lastAt: T0 - 25 * MIN }),
];
const msg = (id: string, from: TrafficEnd, to: TrafficEnd, text: string, over: Partial<PeerMessage> = {}): PeerMessage => ({
  id, from, to, owner: "Ed", text, sentAt: T0 - 10 * MIN, state: "delivered", stateAt: T0 - 590_000, why: null, approved: false, ...over,
});
const MESSAGES: Record<string, PeerMessage[]> = {
  "s-dev|s-tester": [
    msg("m1", DEV, TESTER, "Please run the systemd unit tests.\nReport each failure."),
    msg("m2", TESTER, DEV, "2 of 14 failed. The token is [redacted], ask [redacted].", { sentAt: T0 - 500_000 }),
    msg("m3", DEV, TESTER, "Can you run the same on Debian 12 next?", { sentAt: T0 - 400_000, state: "ready" }),
  ],
  "s-dev|s-arm": [msg("m4", DEV, ARM, "Build podium-reporter for arm64.", { approved: true }), msg("m5", DEV, ARM, "Also run npm run test:mod there.", { state: "approval" })],
  "s-dev|s-notes": [msg("m7", DEV, NOTES, "Here are the unit files.", { state: "ready" }), msg("m8", NOTES, DEV, "No.", { state: "declined" })],
  "s-notes|s-tester": [msg("m6", NOTES, TESTER, "What version of systemd?", { state: "dropped", why: "receiver-ended" })],
};

function trafficApi(links: TrafficLink[], unreadable = false, rereadFails = false): TrafficApi {
  let reads = 0;
  let now = structuredClone(links);
  const between = (l: TrafficLink, a: string, b: string) => (l.a.reporterKey === a && l.b.reporterKey === b) || (l.a.reporterKey === b && l.b.reporterKey === a);
  return {
    read: async (): Promise<TrafficRead> => {
      if (rereadFails && reads++ > 0) throw new TypeError("offline");
      return { enabled: true, conversations: structuredClone(now), retainDays: 30 };
    },
    conversation: async (a: string, b: string) => {
      if (unreadable) throw new TypeError("offline");
      const m = MESSAGES[`${a}|${b}`];
      if (!m) throw new RespondError(404, { error: "no such conversation" });
      return { messages: structuredClone(m) };
    },
    pause: async () => ({ ok: true as const }),
    remove: async (a: string, b: string) => {
      now = now.map((l) => (between(l, a, b) ? { ...l, aToB: false, bToA: false } : l));
      return { ok: true as const };
    },
  } as unknown as TrafficApi;
}

const rowOf = (name: RegExp) => screen.getByRole("link", { name });
function traffic({ links = LINKS(), me = ED, unreadable = false, rereadFails = false, after }: { links?: TrafficLink[]; me?: RespondMe; unreadable?: boolean; rereadFails?: boolean; after?: () => unknown } = {}): Screen {
  return {
    make: () => {
      quietFeed();
      const sessions = [
        makeSession({ id: "s-dev", name: "claude-dashboard", status: "running", lastSeenAt: T0, owner: "Ed", machine: { name: "ed-mbp", id: "m1", os: "macOS 26.1" } }),
        makeSession({ id: "s-arm", name: "arm64-check", status: "waiting", waitReason: "input", lastSeenAt: T0, owner: "Ed", machine: { name: "build-pi", id: "m3", os: "Debian 12, arm64" } }),
      ];
      const state = stateFrom({ sessions, features: { "activity-feed": true, "peer-messaging": true } });
      return <FleetView traffic state={state} respondApi={respondApi(me)} peersApi={peersApi(peersRead())} trafficApi={trafficApi(links, unreadable, rereadFails)} />;
    },
    act: async () => {
      await flush();
      await after?.();
      await flush();
    },
  };
}
const panel = () => document.querySelector(".pm-conv") as HTMLElement;

// ---- the file diff modal ----------------------------------------------------------------------------------------
const REPORT: FilesReport = {
  files: [
    { path: "src/a.ts", status: "modified", from: null, added: 2, removed: 1 },
    { path: "docs/new.md", status: "added", from: null, added: 3, removed: 0 },
    { path: "img/logo.png", status: "modified", from: null, added: null, removed: null },
  ],
  total: 3,
  added: 5,
  removed: 1,
  since: "start",
};
const DIFF = '@@ -1,3 +1,4 @@ function f() {\n const keep = 1\n-const apiKey = "[redacted]"\n+const apiKey = process.env.KEY\n+const x = "ready"\n tail';
const diffOk = (over: Partial<FileDiffReply> = {}): FileDiffReply => ({ path: "src/a.ts", status: "ok", text: DIFF, truncated: false, shownLines: 6, totalLines: 6, redactions: 1, base: "7eb90e8", ...over });

function diff(reply: () => Promise<FileDiffReply>, wait = true): Screen {
  const api = { me: async () => ED, signIn: vi.fn(), signOut: vi.fn(), ask: vi.fn(), answer: vi.fn(), message: vi.fn(), discard: vi.fn(), fileDiff: reply } as unknown as RespondApi;
  return {
    make: () => (
      <RespondProvider api={api} flagsOn={false} diffOn>
        <FilesList report={REPORT} hint={null} session={makeSession({ id: "sess-ed", owner: "Ed", status: "running", fileDiff: true })} />
      </RespondProvider>
    ),
    act: async () => {
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "Open diff of src/a.ts" }));
      if (wait) await flush();
    },
  };
}

export const MESSAGING_SCREENS: Record<string, Screen> = {
  "my-reporters": mine(),
  "my-reporters-board": mine({ view: "board" }),
  "my-reporters-prompt": mine({ after: () => pick("ed-mbp", "build-pi", "send") }),
  "my-reporters-limits": mine({
    read: {
      defaults: { trust: false, onRequest: "ask", newSend: "ask", limits: { roundTrips: 4 } },
      limits: { server: { roundTrips: 10, perMinute: 6, maxChars: 20_000 }, effective: { roundTrips: 4, perMinute: 6, maxChars: 20_000 } },
    },
  }),
  "my-reporters-limit-refused": mine({
    api: { setDefaults: async () => { throw new RespondError(400, { error: "Round trips must be a whole number from 1 to 10" }); } },
    after: async () => {
      const box = screen.getByLabelText(/^Round trips/);
      fireEvent.change(box, { target: { value: "11" } });
      await act(async () => fireEvent.blur(box));
    },
  }),
  "my-reporters-off": mine({ flag: false }),
  "my-reporters-signed-out": mine({ me: OUT }),
  "traffic": traffic(),
  "traffic-waiting": traffic({ after: () => fireEvent.click(rowOf(/^claude-dashboard to arm64-check/)) }),
  "traffic-paused": traffic({ after: () => fireEvent.click(rowOf(/^claude-dashboard and infra-notes/)) }),
  "traffic-dropped": traffic({ after: () => fireEvent.click(rowOf(/^infra-notes and Tester/)) }),
  "traffic-confirm": traffic({ after: () => fireEvent.click(within(panel()).getByRole("button", { name: "Remove link…" })) }),
  "traffic-removed": traffic({
    after: async () => {
      fireEvent.click(within(panel()).getByRole("button", { name: "Remove link…" }));
      fireEvent.click(within(panel()).getByRole("button", { name: "Remove link" }));
      await flush();
    },
  }),
  "traffic-table": traffic({ after: () => fireEvent.click(within(screen.getByRole("radiogroup", { name: "View" })).getByRole("radio", { name: "Table" })) }),
  "traffic-error": traffic({ unreadable: true }),
  "traffic-reread-error": traffic({ rereadFails: true, after: () => fireEvent.click(screen.getByRole("radio", { name: "Last 24 hours" })) }),
  "traffic-admin": traffic({ me: ANN_ADMIN }),
  "traffic-signed-out": traffic({ me: OUT }),
  "traffic-empty": traffic({ links: [] }),
  "diff-modal": diff(async () => diffOk()),
  "diff-loading": diff(() => new Promise<FileDiffReply>(() => {}), false),
};
