// Screens for session recording (#353), the replay, the fold of the Plan / Files column (#604), the certificate pill (#590) and
// an opened Bash row (#431), the update notice (#499) and a pinned card (#496), so the standards show each of them (#664). Fixture data, the app's own components.
import { act, fireEvent, within } from "@testing-library/react";
import { vi, type MockInstance } from "vitest";
import { ActivityOutputFlag } from "../components/BashRow";
import { FeedList } from "../components/ActivityFeed";
import { FocusView } from "../components/FocusView";
import { RecordPicker } from "../components/RecordPicker";
import { ReplayPage } from "../components/ReplayPage";
import { SessionCard } from "../components/SessionCard";
import { TopBar } from "../components/TopBar";
import { FleetView } from "../FleetApp";
import { makeAgent, makeKpis, makeRecording, makeSession } from "../fixtures";
import { stateFrom } from "../testState";
import { PINS_KEY } from "../usePins";
import type { FeedEntry, FeedState } from "../useActivityFeed";
import { RespondProvider } from "../useRespond";
import type { RespondApi } from "../respondApi";
import type { RecordingGrant, RecordingPage, RecordingRow, RespondMe } from "../types";
import type { Screen } from "./screens";

const at = (h: number, m: number, s = 0) => Date.UTC(2026, 9, 20, h, m, s);
const NOW = at(12, 0);
const CFG = { staleAfterMs: 15_000, dropAfterMs: 60_000, lingerMs: 8_000, detachedHideAfterMs: 60_000 };
const ME: RespondMe = { enabled: true, signedIn: true, name: "Ed", admin: false };
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const noop = () => {};

const api = (over: Partial<RespondApi> = {}) => ({ me: async () => ME, signIn: vi.fn(), signOut: vi.fn(), ask: vi.fn(), answer: vi.fn(), message: vi.fn(), discard: vi.fn(), ...over }) as unknown as RespondApi;

const AGENTS = [makeAgent({ id: "p", description: "Port the endpoints" }), makeAgent({ id: "f", parentId: "p", kind: "fork", description: "Try the second approach" })];
const focus = (over: Parameters<typeof makeSession>[0] = {}) => (
  <RespondProvider api={api()} flagsOn={false} recordingOn>
    <FocusView s={makeSession({ owner: "Ed", agents: AGENTS, ...over })} now={NOW} config={CFG} sort={{ key: null, dir: 1 }} onSort={noop} selectedAgent={null} flashAgent={null} onAgent={noop} />
  </RespondProvider>
);

// The replay's rows, as the Replay tests have them.
let n = 0;
const row = (over: Partial<RecordingRow>): RecordingRow => ({ n: ++n, seq: n, loop: "@orchestrator", at: at(11, 42), kind: "text", text: "", ...over });
const grant: RecordingGrant = { state: "stopped", consent: { admin: true, chosen: true, owner: true }, loops: ["@orchestrator", "p"], limit: null, startedBy: "Maya Okafor", startedAt: at(11, 42), stoppedBy: "Maya Okafor", stoppedAt: at(13, 2), keptUntil: at(17, 42), bytes: 18 * 1024 * 1024 };
const replayPage = (): RecordingPage => {
  n = 0;
  return {
    entries: [
      row({ kind: "prompt", text: "Migrate invoices to v2 schema." }),
      row({ kind: "thinking", at: at(11, 43) }),
      row({ kind: "text", text: "I will read the schema first, then hand the port to an agent.", at: at(11, 43, 20) }),
      row({ kind: "tool", name: "Read", text: "server/src/invoices/schema.ts", at: at(11, 44) }),
      row({ kind: "result", name: "Read", text: "export const schema = {};", at: at(11, 44, 2) }),
      row({ kind: "tool", name: "Bash", text: "npm test -w server -- invoices", loop: "p", at: at(11, 47) }),
      row({ kind: "result", name: "Bash", text: "FAIL list.test.ts\nTests: 1 failed", failed: true, loop: "p", at: at(11, 47, 30) }),
      row({ kind: "compact", at: at(12, 5) }),
      row({ kind: "text", text: "Done.", at: at(13, 2, 5) }),
      row({ kind: "stopped", by: "Maya Okafor", at: at(13, 2) }),
    ],
    olderBefore: null,
    total: 10,
    grant,
    loops: [{ loop: "@orchestrator", name: "api-refactor", recorded: true }, { loop: "p", name: "agent-port-endpoints", recorded: true }],
    owner: "Ed",
  };
};

// Bash rows, as the feed holds them.
const T0 = 1_000_000;
const entry = (seq: number, over: Partial<FeedEntry> = {}): FeedEntry => ({ seq, at: T0 + seq * 1000, kind: "tool", text: "Bash npm test", command: "npm test", ...over });
const bashFeed = (entries: FeedEntry[]): FeedState => ({ entries, stored: null, loadOlder: async () => {}, seen: entries.length, fetchedAt: T0, failed: false, live: true, adminOff: false });
const LONG_CURL = `curl -H 'Authorization: Bearer [redacted]' "https://staging.example.com/api/invoices?${Array.from({ length: 30 }, (_, i) => `field${i}=value${i}`).join("&")}"`;
const bashRows: FeedEntry[] = [
  entry(1, { command: "npm run build", text: "Bash npm run build", output: "built in 2.1s", done: true, exitCode: 0 }),
  entry(2, { command: "npm test -w frontend", text: "Bash npm test -w frontend", output: "Error: 3 tests failed\n  at invoice.test.ts:41", done: true, failed: true, exitCode: 1 }),
  entry(3, { command: LONG_CURL, text: `Bash ${LONG_CURL}`.slice(0, 300), output: "token=[redacted]\n\n[cut off at 20,000 characters]", outputCut: true, commandCut: true, done: true }),
  entry(4, { command: "git status", text: "Bash git status" }),
  // A row from a reporter that sends no command: nothing to open, and the line says it was cut.
  { seq: 5, at: T0 + 5000, kind: "tool", text: `Bash ${LONG_CURL}`.slice(0, 300) },
];

const tlsStatus = { enabled: true, expiresAt: new Date(NOW + 9 * 86_400_000).toISOString(), subject: "serving", daysLeft: 9, stage: "serious", renewalFailed: false, showCountdown: true };

let clock: MockInstance<() => number> | undefined;
const wallOf = (over: object = {}) => ({ notices: { "background-sessions": true }, showBackgroundSessions: false, cardTitleMachine: false, ...over });

export const RECORDING_SCREENS: Record<string, Screen> = {
  "app-update-notice": {
    make: () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ entries: [], since: 0, live: true, enabled: true, serverTime: 2_000_000 }) })));
      const state = stateFrom({ sessions: [makeSession({ id: "s1", name: "api-refactor" })], wall: wallOf({ update: { latest: "1.4.0", url: "https://github.com/eengelking/podium/releases/tag/v1.4.0" } }), kpis: makeKpis({ live: 1 }) });
      return <FleetView state={state} />;
    },
    act: flush,
  },
  "app-pinned": {
    make: () => {
      localStorage.setItem(PINS_KEY, JSON.stringify([{ id: "s2", slot: 0 }]));
      return <FleetView state={stateFrom({ sessions: [makeSession({ id: "s1", name: "api-refactor" }), makeSession({ id: "s2", name: "docs-rewrite" })], kpis: makeKpis({ live: 2 }) })} />;
    },
    act: flush,
  },
  "rec-card": { make: () => <div className="wall"><SessionCard s={makeSession({ recording: makeRecording() })} now={NOW} config={CFG} entering={false} leaving={false} onOpen={noop} /></div> },
  "rec-focus-idle": { make: () => focus(), act: flush },
  "rec-focus-recording": { make: () => focus({ recording: makeRecording() }), act: flush },
  "rec-focus-kept": { make: () => focus({ recording: makeRecording({ state: "stopped", stoppedBy: "Maya Okafor", stoppedAt: at(13, 2) }) }), act: flush },
  "rec-picker": {
    make: () => <div><RespondProvider api={api()} flagsOn={false} recordingOn><RecordPicker s={makeSession({ owner: "Ed", agents: AGENTS })} onClose={noop} /></RespondProvider></div>,
    act: flush,
  },
  "rec-replay": {
    make: () => {
      clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => null })));
      Element.prototype.scrollIntoView = vi.fn();
      return <RespondProvider api={api({ recordingPage: vi.fn(async () => replayPage()) } as never)} flagsOn={false} recordingOn><ReplayPage id="s1" session={makeSession({ id: "s1", name: "api-refactor", status: "running" })} now={NOW} /></RespondProvider>;
    },
    act: flush,
    cleanup: () => clock?.mockRestore(),
  },
  "focus-folded": {
    make: () => focus(),
    act: async (b) => { await flush(); fireEvent.click(within(b).getByRole("button", { name: "Hide plan and files" })); await flush(); },
  },
  "top-cert-pill": {
    make: () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => tlsStatus })));
      return <TopBar page="Admin" phase="live" reporters={2} />;
    },
    act: flush,
  },
  "feed-bash": {
    make: () => <ActivityOutputFlag.Provider value={true}><FeedList feed={bashFeed(bashRows)} startedAt={T0} empty="none" machineOutput={true} /></ActivityOutputFlag.Provider>,
    act: async (b) => {
      await flush();
      for (const i of [1, 2]) fireEvent.click(b.querySelectorAll<HTMLButtonElement>(".feed li button.tgl")[i]!);
      await flush();
    },
  },
};
