// The Admin screens (#354): the real AdminView against the same in-memory stand-in for /api/admin that the Admin tests use.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";
import { AdminView } from "../admin/AdminView";
import { fakeCert, fakeCerts, fakeServer, type FakePeerRef, type FakePeers } from "../admin/fakeAdmin";
import { makeKpis, makeSession, makeState } from "../fixtures";
import type { RecordingAdminRow } from "../types";
import type { FleetSource } from "../useFleet";
import type { Screen } from "./screens";

class QuietSource {
  onerror = null;
  readyState = 1;
  addEventListener() {}
  close() {}
}

/** Lets the fake server's replies land and React draw them. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });

type Fetch = typeof fetch;
/** Wraps the fake server's fetch so one path answers differently. */
function answer(path: string, reply: () => Response | Promise<Response>) {
  const base = globalThis.fetch as Fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => (new URL(String(input), "https://x").pathname.endsWith(path) ? reply() : base(input, init)));
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function admin(tab: RegExp | null, opts: Parameters<typeof fakeServer>[0] = {}, after?: () => Promise<void>, tweak?: (srv: ReturnType<typeof fakeServer>) => void): Screen {
  return {
    make: () => {
      vi.stubGlobal("EventSource", QuietSource);
      const srv = fakeServer({ unlocked: true, people: 6, ...opts });
      srv.groups.push({ id: 1, name: "Platform" }, { id: 2, name: "Data", builtIn: false }, { id: 3, name: "Administrators", builtIn: true });
      srv.people[0].groupId = 1;
      srv.people[1].groupId = 2;
      srv.people[2].groupId = 3;
      srv.people[3].revokedAt = 50_000;
      tweak?.(srv);
      const state = makeState({
        sessions: [makeSession({ id: "s1", owner: "person-000", ownerGroup: "Platform" })],
        kpis: makeKpis({ costTodayByOwner: [{ owner: "person-000", group: "Platform", costUsd: 12.4 }, { owner: "person-001", group: "Data", costUsd: 3.1 }] }),
      });
      const quiet = new QuietSource() as unknown as FleetSource;
      return <AdminView fleetOptions={{ open: () => quiet, fetchState: async () => state }} />;
    },
    act: async () => {
      await screen.findByRole("navigation", { name: "Admin sections" });
      // The count beside People is set by the People tab, which is the one open at first, when its list arrives. Wait for it before
      // any click, so every sample shows it the way the app does once loaded, and not only the ones whose list beat the click.
      await waitFor(() => {
        if (!within(screen.getByRole("navigation", { name: "Admin sections" })).getByRole("button", { name: /^People(?! and)/ }).querySelector(".n")) throw new Error("the People count is not drawn yet");
      });
      if (tab) fireEvent.click(screen.getByRole("button", { name: tab }));
      await settle();
      await after?.();
    },
  };
}

// Dana's three reporters and the one that reports with the Admin's secret, as the Messaging tests have them.
const STUDIO: FakePeerRef = { key: "9f3a1c7d2e40", machine: "studio-m2", owner: "Dana", adminSecret: false, os: "macOS 26.1", peers: true, version: "1.2.0" };
const CI: FakePeerRef = { key: "lnx01", machine: "ci-01", owner: "Dana", adminSecret: false, os: "Ubuntu 24.04", peers: true, version: "1.2.0" };
const WIN: FakePeerRef = { key: "win01", machine: "win-lab", owner: "Dana", adminSecret: false, os: "Windows 11", peers: false, version: "1.1.0" };
const SECRET: FakePeerRef = { key: "addr:10.4.0.52", machine: "10.4.0.52", owner: "Admin", adminSecret: true, os: null, peers: true, version: "1.2.0" }; // NOSONAR S1313: a made-up private address in sample data

/** Orchestrator messaging on, with its limits and Dana's reporters; `peers` changes what the Messaging section finds. */
const messagingOn = (peers: Partial<FakePeers> = {}) => (srv: ReturnType<typeof fakeServer>) => {
  srv.features["peer-messaging"] = true;
  srv.peerLimits = { roundTrips: 10, perMinute: 6, maxChars: 20_000, retainDays: 30 };
  srv.peers = { reporters: [STUDIO, CI, WIN, SECRET], rights: [{ from: STUDIO.key, to: CI.key, owner: "Dana", level: "see", paused: false, setAt: 1 }], requests: [], trust: false, ...peers };
};
const openStudio = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Open details for studio-m2" }));
  await screen.findByRole("region", { name: "Messaging" });
  await settle();
};

export const ADMIN_SCREENS: Record<string, Screen> = {
  "admin-people": admin(null),
  "admin-groups": admin(/^Groups/),
  "admin-reporters": admin(/^Reporters/),
  "admin-reporting": admin(/^Security/),
  "admin-settings": admin(/^Settings/),
  "admin-prices": admin(/^Model prices/),
  "admin-spend": admin(/^Spend/),
  "admin-log": admin(/^Admin log/),
  "admin-people-created": admin(null, {}, async () => {
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Dana" } });
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));
    await screen.findByText(/token: pdm_/);
    await settle();
  }),
  "admin-reporter-detail": admin(/^Reporters/, {}, async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Open details for studio-m2" }));
    await screen.findByRole("button", { name: "Remove from list" });
    await settle();
  }),
  "admin-reporter-remove": admin(/^Reporters/, {}, async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Open details for studio-m2" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove from list" }));
    await settle();
  }),
  "admin-reporters-selected": admin(/^Reporters/, {}, async () => {
    fireEvent.click(await screen.findByLabelText("Select all 1 on this page"));
    await settle();
  }, (srv) => { srv.pageLimit = 1; }),
  "admin-reporters-ignore": admin(/^Reporters/, {}, async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Open details for studio-m2" }));
    fireEvent.click(await screen.findByRole("button", { name: "Ignore…" }));
    await settle();
  }),
  "admin-settings-messaging": admin(/^Settings/, {}, undefined, messagingOn()),
  "admin-settings-messaging-error": admin(/^Settings/, {}, async () => {
    const trips = await screen.findByLabelText(/^Round trips before/);
    fireEvent.change(trips, { target: { value: "0" } });
    fireEvent.blur(trips);
    await screen.findByRole("alert");
  }, messagingOn()),
  "admin-reporter-messaging": admin(/^Reporters/, {}, openStudio, messagingOn()),
  "admin-reporter-messaging-proposed": admin(/^Reporters/, {}, openStudio, messagingOn({ requests: [{ id: "prq_9", kind: "proposal", at: 90_000, from: { machine: "studio-m2", name: null }, to: { machine: "ci-01", name: null }, level: "send", by: "Admin", reason: null, text: null, fromKey: STUDIO.key, toKey: CI.key, messageId: null }] })),
  "admin-reporter-messaging-trust": admin(/^Reporters/, {}, openStudio, messagingOn({ trust: true })),
  "admin-prices-edit": admin(/^Model prices/, {}, async () => {
    fireEvent.change(await screen.findByLabelText("Sonnet 5.5 input"), { target: { value: "2.4" } });
    await settle();
  }),
  "admin-groups-filled": admin(/^Groups/, {}, undefined, () => {
    answer("/groups", () => json(200, { total: 3, page: 1, pageSize: 50, rows: [{ id: 3, name: "Administrators", createdAt: 1, members: ["person-002"], builtIn: true }, { id: 1, name: "Platform", createdAt: 1, members: ["person-000", "person-004"], builtIn: false }, { id: 2, name: "Data", createdAt: 1, members: ["person-001"], builtIn: false }] }));
  }),
  "admin-groups-error": admin(/^Groups/, {}, undefined, () => answer("/groups", () => json(500, { ok: false, error: "database is locked" }))),
  "admin-settings-error": admin(/^Settings/, {}, undefined, () => answer("/settings", () => json(500, { ok: false, error: "database is locked" }))),
  "admin-reporters-compat": admin(/^Reporters/, {}, undefined, (srv) => {
    srv.reporters.push(
      { key: "aa11", state: "reporting", name: "ci-runner", named: true, who: "Dana", credential: "pdm_aa11", adminSecret: false, version: "9.0.0", compat: "newer", firstSeenAt: 1_000, lastSeenAt: 40_000, sessions: 4, live: 1 },
      { key: "bb22", state: "idle", name: "hooks-only", named: true, who: "Priya", credential: null, adminSecret: false, version: "", compat: "unknown", firstSeenAt: 1_000, lastSeenAt: 30_000, sessions: 2, live: 0 },
    );
  }),
  "admin-prices-tags": admin(/^Model prices/, {}, undefined, (srv) => {
    srv.prices["my-local-model"] = { std: { input: 0.2, output: 0.6, cacheRead: 0.02, cacheWrite: 0.25, cacheWrite1h: 0.4 } };
    srv.prices["sonnet-5-5"].std.input = 3;
  }),
  "admin-certs": admin(/^Certificates/, {}, undefined, (srv) => { srv.certs = fakeCerts(); }),
  "admin-certs-expiring": admin(/^Certificates/, {}, undefined, (srv) => { srv.certs = fakeCerts({ serving: fakeCert(10), lastFailure: { at: new Date(Date.now() - 3_600_000).toISOString(), reason: "Could not write the new certificate.", trigger: "scheduled" } }); }),
  "admin-certs-off": admin(/^Certificates/, {}, undefined, (srv) => { srv.certs = null; }),
  "admin-certs-names": admin(/^Certificates/, {}, async () => {
    fireEvent.click(await screen.findByRole("button", { name: /and \d+ more/ }));
    await settle();
  }, (srv) => { srv.certs = fakeCerts(); }),
  "admin-data": admin(/^Data/),
  "admin-stored": admin(/^Stored activity/),
  "admin-report-usage": admin(/^Usage/),
  "admin-report-people": admin(/^People and groups/),
  "admin-report-sessions": admin(/^Sessions/),
  "admin-report-failures": admin(/^Failures/),
  "admin-report-activity": admin(/^Admin activity/),
  "admin-people-menu": admin(null, {}, async () => {
    fireEvent.click(await screen.findByLabelText("Actions for person-000"));
    await settle();
  }),
  "admin-settings-recording": admin(/^Settings/, {}, undefined, (srv) => {
    const rec = (over: Partial<RecordingAdminRow> = {}): RecordingAdminRow => ({ sessionId: "s1", name: "api-refactor", owner: "person-000", startedBy: "person-000", state: "recording", limit: null, loops: 4, label: "orchestrator and 3 agents", bytes: 18 * 1024 * 1024, keptUntil: 1_900_000_000_000, ...over });
    const rows = [rec(), rec({ sessionId: "s2", name: "flaky-tests", state: "stopped", owner: null, startedBy: "Admin", bytes: 21 * 1024 * 1024 }), rec({ sessionId: "s3", name: "docs-sweep", state: "limit", limit: "session", keptUntil: null }), rec({ sessionId: "s4", name: "big", state: "limit", limit: "budget" })];
    srv.features["session-recording"] = true;
    srv.recording = { settings: { keepHours: 6, budgetMb: 4096, sessionMb: 512 }, totals: { recordings: rows.length, bytes: 41 * 1024 * 1024, running: 1 }, authOn: true };
    srv.recordings = rows;
  }),
  "admin-certs-soon": admin(/^Certificates/, {}, undefined, (srv) => { srv.certs = fakeCerts({ serving: fakeCert(20) }); }),
  "admin-settings-recording-saved": admin(/^Settings/, {}, async () => {
    fireEvent.change(await screen.findByRole("combobox", { name: "Unit" }), { target: { value: "days" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
  }, (srv) => {
    srv.features["session-recording"] = true;
    srv.recording = { settings: { keepHours: 6, budgetMb: 4096, sessionMb: 512 }, totals: { recordings: 0, bytes: 0, running: 0 }, authOn: true };
  }),
  "admin-report-partial": admin(/^Usage/, {}, undefined, (srv) => {
    srv.reports.usage = { report: "usage", from: "2026-01-01", to: "2026-03-31", by: "day", tz: "UTC", basedOn: "daily rollups", oldestDay: "2026-03-02", partial: true, columns: [{ key: "period", label: "Day" }, { key: "sessions", label: "Sessions" }], rows: [{ period: "2026-03-02", sessions: 4 }], total: null };
  }),
  "admin-people-confirm": admin(null, {}, async () => {
    const opener = await screen.findByLabelText("Actions for person-000");
    fireEvent.click(opener);
    fireEvent.click(within(opener.closest("details")!).getByRole("menuitem", { name: "Rotate token" }));
    await settle();
  }),
  "admin-locked": {
    make: () => {
      vi.stubGlobal("EventSource", QuietSource);
      fakeServer({ unlocked: false });
      return <AdminView />;
    },
    act: async () => {
      await screen.findByLabelText("Name");
    },
  },
};
