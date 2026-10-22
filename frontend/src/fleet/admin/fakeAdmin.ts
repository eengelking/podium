// A small in-memory stand-in for /api/admin, shared by the Admin tests and the standards pages' Admin screens (#354).
import { vi } from "vitest";
import type { CertInfo, CertsView } from "./certFormat";
import type { ActivityHistoryPreview, ActivityHistoryState, StoredDeleteResult, StoredSessionRow } from "./adminApi";
import type { RecordingAdminRow, RecordingSettings } from "../types";

interface PriceSet {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}
interface P {
  id: number;
  name: string;
  groupId: number | null;
  revokedAt: number | null;
  /** The person's reporter certificate (#587): absent means none. */
  certificate?: { notAfter: string; revoked: boolean } | null;
}

/** Orchestrator messaging as the fake server keeps it (#416): one owner's reporters, the stored rights and the open requests. */
export interface FakePeerRef {
  key: string;
  machine: string;
  owner: string | null;
  adminSecret: boolean;
  os: string | null;
  peers: boolean | null;
  version: string;
}
interface FakeRight {
  from: string;
  to: string;
  owner: string;
  level: "none" | "see" | "ask" | "send";
  paused: boolean;
  setAt: number;
}
export interface FakePeers {
  reporters: FakePeerRef[];
  rights: FakeRight[];
  requests: { id: string; kind: string; fromKey: string; toKey: string; level: string | null; [k: string]: unknown }[];
  trust: boolean;
}

/** The Admin's read of one reporter, as GET /reporters/:key/peers answers it. */
function peersRead(P: FakePeers, key: string) {
  const ref = P.reporters.find((r) => r.key === key)!;
  const mine = ref.adminSecret || !ref.owner ? [] : P.reporters.filter((r) => !r.adminSecret && r.owner === ref.owner);
  const row = (a: string, b: string) => P.rights.find((r) => r.from === a && r.to === b);
  const eff = (a: string, b: string) => ({ from: a, to: b, level: P.trust ? "send" : (row(a, b)?.level ?? "none"), paused: row(a, b)?.paused ?? false });
  // Every pair of the owner's reporters, as the server reads them (#416); the effective levels are this reporter's pairs only.
  const keys = new Set(mine.map((r) => r.key));
  return {
    reporter: ref,
    peers: mine,
    trust: mine.length > 0 && P.trust,
    rights: P.rights.filter((r) => keys.has(r.from) && keys.has(r.to)),
    effective: mine.flatMap((o) => [eff(key, o.key), ...(o.key === key ? [] : [eff(o.key, key)])]),
    requests: P.requests.filter((r) => keys.has(r.fromKey) && keys.has(r.toKey)),
  };
}

/** Pause all links: every direction between `key` and the owner's reporters, a `none` row holding a pause with no right. */
function pauseAll(P: FakePeers, key: string, paused: boolean) {
  for (const o of peersRead(P, key).peers) {
    for (const [f, t] of key === o.key ? [[key, key]] : [[key, o.key], [o.key, key]]) {
      const had = P.rights.find((r) => r.from === f && r.to === t);
      if (had) had.paused = paused;
      else if (paused) P.rights.push({ from: f!, to: t!, owner: o.owner!, level: "none", paused: true, setAt: 1 });
    }
  }
  if (!paused) P.rights = P.rights.filter((r) => r.level !== "none");
}

const USAGE_COLS = [
  { key: "period", label: "Day", unit: "date" },
  { key: "people", label: "People", unit: "count" },
  { key: "reporters", label: "Reporters", unit: "count" },
  { key: "sessions", label: "Sessions", unit: "count" },
  { key: "peakLive", label: "Most live", unit: "count" },
];
const SPEND_COLS = [
  { key: "period", label: "Day", unit: "date" },
  { key: "key", label: "Model", unit: "text" },
  { key: "sessions", label: "Sessions", unit: "count" },
  { key: "tokIn", label: "Tokens in", unit: "tokens" },
  { key: "tokOut", label: "Tokens out", unit: "tokens" },
  { key: "costUsd", label: "Spend", unit: "usd" },
  { key: "unpricedSessions", label: "Unpriced sessions", unit: "count" },
];

/** A report as the server would answer it (docs/SPEC.md "Reports (#484)"), with the query echoed back. */
function fakeReport(report: string, url: URL) {
  const from = url.searchParams.get("from") ?? "2026-10-01";
  const to = url.searchParams.get("to") ?? "2026-10-20";
  const base = { report, from, to, tz: "Europe/Berlin", basedOn: "rollups and live", oldestDay: "2026-03-02" };
  const by = url.searchParams.get("by") ?? "day";
  if (report === "usage") {
    return {
      ...base,
      by,
      columns: USAGE_COLS,
      rows: [
        { period: "2026-10-19", people: 9, reporters: 13, sessions: 69, peakLive: 8 },
        { period: "2026-10-12", people: 10, reporters: 15, sessions: 88, peakLive: 9 },
      ],
      total: { period: null, people: 11, reporters: 16, sessions: 157, peakLive: 9 },
    };
  }
  if (report === "spend") {
    const rows: Record<string, unknown>[] = url.searchParams.get("breakdown") === "model" ? [{ period: "2026-10", key: "Sonnet 5.5", sessions: 181, tokIn: 88_600_000, tokOut: 5_400_000, costUsd: 301.15, unpricedSessions: 0 }, { period: "2026-10", key: "mystery-model", sessions: 3, tokIn: 400_000, tokOut: 100_000, costUsd: null, unpricedSessions: 3 }] : [{ period: "2026-10", sessions: 184, tokIn: 89_000_000, tokOut: 5_500_000, costUsd: 301.15, unpricedSessions: 3 }];
    return { ...base, by, columns: SPEND_COLS.filter((c) => c.key !== "key" || rows[0]!.key !== undefined), rows, total: { sessions: 184, tokIn: 89_000_000, tokOut: 5_500_000, costUsd: 301.15, unpricedSessions: 3 } };
  }
  if (report === "people") {
    return {
      ...base,
      columns: [{ key: "person", label: "Person", unit: "text" }, { key: "group", label: "Group", unit: "text" }, { key: "sessions", label: "Sessions", unit: "count" }, { key: "lastReportAt", label: "Last report", unit: "time" }, { key: "state", label: "State", unit: "text" }],
      rows: [
        { person: "Maya Okafor", group: "Platform", sessions: 40, lastReportAt: 1_760_000_000_000, state: "active" },
        { person: "Jonas Weber", group: null, sessions: 0, lastReportAt: null, state: "never" },
      ],
      total: null,
      summary: { people: 2, groups: 1, reporters: 3, reporterVersions: { "1.2.2": 3 }, engineVersions: { "2.1.299": 2 } },
    };
  }
  if (report === "sessions") {
    return { ...base, by, columns: [{ key: "period", label: "Day", unit: "date" }, { key: "key", label: "Outcome", unit: "text" }, { key: "sessions", label: "Sessions", unit: "count" }, { key: "avgDurationS", label: "Average duration", unit: "seconds" }, { key: "maxContextPct", label: "Fullest window", unit: "percent" }], rows: [{ period: "2026-10-19", key: "ended", sessions: 12, avgDurationS: 754, maxContextPct: 91 }], total: { sessions: 12, blowouts: 1 } };
  }
  if (report === "failures") {
    return {
      ...base,
      by,
      columns: [{ key: "period", label: "Day", unit: "date" }, { key: "key", label: "Class", unit: "text" }, { key: "count", label: "Count", unit: "count" }, { key: "people", label: "People", unit: "count" }],
      rows: [
        { period: "2026-10-19", key: "Command failed", count: 38, people: 7, sessionIds: ["s1", "s2"] },
        { period: "2026-03-05", key: "Timeout", count: 6, people: 3 },
      ],
      total: { count: 44, people: 8 },
    };
  }
  const kind = url.searchParams.get("kind");
  const entries = [{ t: 1_760_000_000_000, kind: "unlock_failed", detail: "Wrong secret (1)", source: "10.0.0.1" }, { t: 1_759_000_000_000, kind: "person_created", detail: "Created Priya", source: "10.0.0.2" }]; // NOSONAR S1313: made-up private addresses in a fake server, never connected to
  return { ...base, columns: [{ key: "t", label: "When", unit: "time" }, { key: "kind", label: "Kind", unit: "text" }, { key: "detail", label: "What happened", unit: "text" }, { key: "source", label: "From", unit: "text" }], rows: entries.filter((e) => !kind || e.kind === kind), total: null };
}

const FP = "3F:9A:C4:1D:7E:52:B8:06:A1:EE:90:4B:D3:68:2C:F7:0B:5D:E1:93:4A:8C:27:BE:61:D0:F5:39:AC:12:84:6E";
/** A certificate that ends `days` whole days from now (and half a day over, so a test run never crosses the day), or has ended. */
export function fakeCert(days: number, over: Partial<CertInfo> = {}, lasts = 365): CertInfo {
  const end = Date.now() + days * 86_400_000 + (days < 0 ? -43_200_000 : 43_200_000);
  return { fingerprintSha256: FP, subject: "CN=Podium", notBefore: new Date(end - lasts * 86_400_000).toISOString(), notAfter: new Date(end).toISOString(), serial: "01AB", ...over };
}
/** What GET /certificates answers, healthy: a CA with ten years, a serving certificate with 307 days, six names, one earlier certificate. */
export function fakeCerts(over: Partial<CertsView> = {}): CertsView {
  return {
    ca: fakeCert(3650, { subject: "CN=Podium CA", serial: "CA01" }, 3650),
    serving: fakeCert(307),
    names: { dns: ["localhost", "podium.lan"], ip: ["127.0.0.1", "192.0.2.12"] },
    certificateNames: { dns: ["localhost", "podium.lan"], ip: ["127.0.0.1", "192.0.2.12"] },
    previous: [fakeCert(-60, { serial: "0001" })],
    settings: { lifetimeDays: 365, renewBeforeDays: 30, headerCountdown: true },
    reporter: { lifetimeDays: 90 },
    http: { allow: true, overHttp: 3, total: 6 },
    lastRenewed: null,
    lastFailure: null,
    ...over,
  };
}

/** The reporter config file the server makes for a person (#587), with a short stand-in for the PEM. */
const fakeConfig = (name: string) => ({ filename: `reporter-config-${name.toLowerCase()}-1760000000.pem`, content: "# podium-reporter-config v1\n", expires: "2027-01-19T00:00:00.000Z", fingerprint: "AA:BB" });

/** A small in-memory stand-in for /api/admin. */
export function fakeServer(opts: { people?: number; enabled?: boolean; unlocked?: boolean; respondAdmin?: boolean; build?: string | null } = {}) {
  const state = {
    enabled: opts.enabled ?? true,
    unlocked: opts.unlocked ?? false,
    respondAdmin: opts.respondAdmin ?? false,
    build: opts.build ?? null,
    unlockBodies: [] as unknown[],
    people: Array.from({ length: opts.people ?? 0 }, (_, i): P => ({ id: i + 1, name: `person-${String(i).padStart(3, "0")}`, groupId: null, revokedAt: null })),
    groups: [] as { id: number; name: string; builtIn?: boolean }[],
    calls: [] as string[],
    expire: false,
    notices: { "background-sessions": true } as Record<string, boolean>,
    features: { "activity-feed": true } as Record<string, boolean>,
    bodies: [] as unknown[],
    showBackground: false,
    cardTitleMachine: false,
    prices: {
      "sonnet-5-5": { std: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 } } as { std: PriceSet; long?: PriceSet },
      "haiku-5-5": { std: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2 }, long: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWrite1h: 1 } } as { std: PriceSet; long?: PriceSet },
    } as Record<string, { std: PriceSet; long?: PriceSet }>,
    builtin: { "sonnet-5-5": 2, "haiku-5-5": 0.1 } as Record<string, number>,
    priceError: "" as string,
    removeBodies: [] as unknown[],
    deleteBodies: [] as { ids: number[] }[],
    deleteError: "",
    /** While set, a person's rotate, revoke or reissue is refused with this message and a 400 (such as the last administrator). */
    personError: "",
    pageLimit: 50,
    rules: [] as { id: number; kind: string; pattern: string; createdAt: number }[],
    forget: { enabled: false, days: 30 },
    /** Certificates (#586): null while TLS is off, which answers 404 "TLS is off". A test replaces it with `fakeCerts()`. */
    certs: null as CertsView | null,
    /** People's certificates (#587): whether TLS is on for the People list, and the reporter config a new person or a reissue gets. */
    tls: false,
    certBodies: [] as Record<string, unknown>[],
    /** While set, saving a certificate setting is refused with this message and a 400; a renewal fails with it and a 500. */
    certError: "",
    renewals: 0,
    /** Orchestrator messaging (#416): off unless a test sets it. */
    peers: null as FakePeers | null,
    peerLimits: null as Record<string, number> | null,
    peerLimitError: "",
    proposeError: "",
    proposeBodies: [] as unknown[],
    /** While true, a read of a reporter's messaging waits in `held` until a test calls it: a read slower than the interval. */
    holdPeers: false,
    held: [] as (() => void)[],
    /** Reporting (#484): a test replaces a report's reply by name, or makes the next reads fail with this status. */
    reports: {} as Record<string, unknown>,
    reportStatus: 0,
    /** `GET reports/spend/today/:owner` replies by owner (#482), and the projection (#483). */
    breakdowns: {} as Record<string, unknown>,
    projection: {
      columns: [{ key: "key", label: "Person", unit: "text" }],
      rows: [
        { key: "Maya Okafor", runRatePerDay: 14.8, spentThisMonth: 290.1, projected: 452.9 },
        { key: "Cai Lindqvist", runRatePerDay: null, spentThisMonth: 11.75, projected: null, reason: "history" },
      ],
      total: { runRatePerDay: 38.4, spentThisMonth: 712.4, projected: 1134.8 },
      window: { from: "2026-10-06", to: "2026-10-19", days: 14 },
      horizon: "month",
      unpricedSessions: 3,
      historyDays: 40,
    } as unknown,
    retention: {
      tables: [{ name: "Usage", rows: 2418, oldestDay: "2026-03-02", keptDays: 395 }],
      detail: [{ name: "Per-second samples", keptDays: 1 }, { name: "Admin log", keptDays: 90 }],
    } as unknown,
    /** Activity history (#432): the Data page's state, the preview a save gets, and the stored sessions the second page lists. */
    activity: { settings: { policy: "default", n: 30, unit: "days", capGb: null }, totals: { entries: 0, bytes: 0, sessions: 0, fileBytes: 0 }, lastPurge: null, authOn: true } as ActivityHistoryState,
    activityError: "",
    /** While set, reading the settings fails with this message. */
    settingsError: "",
    previewBodies: [] as unknown[],
    preview: { entries: 0, bytes: 0, sessions: 0, stopsCapturing: false } as ActivityHistoryPreview,
    previewError: "",
    stored: [] as StoredSessionRow[],
    storedDeleteBodies: [] as unknown[],
    storedDeleteResult: null as StoredDeleteResult | null,
    storedError: "",
    /** While set, a delete is refused with this message and a 400. */
    storedBadRequest: "",
    /** Session recording (#353): off unless a test sets it. `recordings` are the Admin table's rows, `storedRecordings` what Source = Recordings lists. */
    recording: null as { settings: RecordingSettings; totals: { recordings: number; bytes: number; running: number }; authOn: boolean } | null,
    recordings: [] as RecordingAdminRow[],
    storedRecordings: [] as StoredSessionRow[],
    recordingError: "",
    reporters: [
      { key: "9f3a1c7d2e40", state: "reporting", name: "studio-m2", named: true, who: "Dana", credential: "pdm_3f9a1c07b2e4", adminSecret: false, version: "0.13.0", compat: "ok", firstSeenAt: 1_000, lastSeenAt: 40_000, sessions: 142, live: 3 },
      { key: "addr:10.4.0.52", state: "silent", name: "10.4.0.52", named: false, who: "Admin", credential: "admin secret", adminSecret: true, version: "0.9.2", compat: "outdated", firstSeenAt: 1_000, lastSeenAt: 1_000, sessions: 9, live: 0 }, // NOSONAR S1313: a made-up private address in a fake server, never connected to
    ] as { key: string; state: string; name: string; named: boolean; who: string; credential: string | null; adminSecret: boolean; version: string; compat: string; firstSeenAt: number; lastSeenAt: number; sessions: number; live: number }[],
  };
  const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  const row = (p: P) => ({ id: p.id, name: p.name, credential: "pdm_0123456789ab", groupId: p.groupId, groupName: state.groups.find((g) => g.id === p.groupId)?.name ?? null, createdAt: 1, rotatedAt: null, revokedAt: p.revokedAt, lastReportAt: null, machines: [], certificate: state.tls ? (p.certificate ?? null) : null });
  /** The sessions of one page of a reporter's details: session-1 is the newest. */
  const recentPage = (total: number, url: URL) => {
    const size = Number(url.searchParams.get("pageSize") ?? 50);
    const from = (Number(url.searchParams.get("page") ?? 1) - 1) * size;
    return Array.from({ length: Math.max(0, Math.min(size, total - from)) }, (_, i) => ({ id: `s${from + i + 1}`, name: `session-${from + i + 1}`, status: "ended", lastSeenAt: 99_000 - from - i, costUsd: 1.84 }));
  };
  const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://x");
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^.*\/api\/admin/, "");
    state.calls.push(`${method} ${path}${url.search}`);
    if (path === "/session") return json(200, { enabled: state.enabled, unlocked: state.unlocked, version: "1.1.0", build: state.build });
    if (path === "/unlock/from-respond") {
      if (!state.respondAdmin) return json(401, { ok: false, error: "not signed in as an Administrator" });
      state.unlocked = true;
      return json(200, { ok: true });
    }
    if (path === "/unlock") {
      const body = JSON.parse(String(init?.body)) as { name?: string; token?: string };
      state.unlockBodies.push(body);
      if (body.name === "Priya" && body.token === "right") {
        state.unlocked = true;
        return json(200, { ok: true });
      }
      return json(401, { ok: false, error: "wrong name or token" });
    }
    if (state.expire || !state.unlocked) return json(401, { ok: false, error: "locked" });
    if (path === "/lock") {
      state.unlocked = false;
      return json(200, { ok: true });
    }
    if (path === "/people" && method === "GET") {
      const page = Number(url.searchParams.get("page") ?? 1);
      const size = Number(url.searchParams.get("pageSize") ?? 50);
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const all = state.people.filter((p) => p.name.toLowerCase().includes(q));
      return json(200, { total: all.length, page, pageSize: size, rows: all.slice((page - 1) * size, page * size).map(row), groups: state.groups, tls: state.tls });
    }
    const grp = /^\/people\/(\d+)\/group$/.exec(path);
    if (grp && method === "PUT") {
      const who = state.people.find((x) => x.id === Number(grp[1]))!;
      who.groupId = (JSON.parse(String(init?.body)) as { groupId: number | null }).groupId;
      return json(200, { ok: true });
    }
    if (path === "/people/delete" && method === "POST") {
      const b = JSON.parse(String(init?.body)) as { ids: number[] };
      state.deleteBodies.push(b);
      if (state.deleteError) return json(400, { ok: false, error: state.deleteError });
      const before = state.people.length;
      state.people = state.people.filter((p) => !b.ids.includes(p.id));
      return json(200, { ok: true, removed: before - state.people.length });
    }
    if (path === "/people" && method === "POST") {
      const name = JSON.parse(String(init?.body)).name as string;
      const p = { id: state.people.length + 1, name, groupId: null, revokedAt: null };
      state.people.push(p);
      return json(201, { ok: true, person: row(p), token: "pdm_aaaaaaaaaaaa_" + "b".repeat(48), ...(state.tls ? { config: fakeConfig(name) } : {}) });
    }
    const act = /^\/people\/(\d+)\/(rotate|revoke|revoke-all|certificate\/revoke|certificate\/reissue)$/.exec(path);
    if (act && method === "POST") {
      const who = state.people.find((x) => x.id === Number(act[1]))!;
      if (state.personError) return json(400, { ok: false, error: state.personError });
      if (act[2] === "rotate") {
        who.revokedAt = null;
        return json(200, { ok: true, person: row(who), token: "pdm_cccccccccccc_" + "d".repeat(48) });
      }
      if (act[2] === "certificate/reissue") {
        who.certificate = { notAfter: "2027-01-19T00:00:00.000Z", revoked: false };
        return json(200, { ok: true, config: fakeConfig(who.name) });
      }
      if (act[2] !== "certificate/revoke") who.revokedAt = 5;
      if (act[2] !== "revoke") who.certificate = { notAfter: who.certificate?.notAfter ?? "2027-01-19T00:00:00.000Z", revoked: true };
      return json(200, { ok: true });
    }
    if (path === "/reporters" && method === "GET") {
      const st = url.searchParams.get("state") ?? "";
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const adminOnly = url.searchParams.get("admin") === "1";
      const rows = state.reporters.filter((r) => (!st || r.state === st) && (!q || r.name.toLowerCase().includes(q)) && (!adminOnly || r.adminSecret));
      const counts = { all: state.reporters.length, reporting: 0, idle: 0, silent: 0, restart: 0 } as Record<string, number>;
      for (const r of state.reporters) counts[r.state]! += 1;
      return json(200, { total: rows.length, page: 1, pageSize: state.pageLimit, rows: rows.slice(0, state.pageLimit), counts, adminSecret: state.reporters.filter((r) => r.adminSecret).length, serverTime: 100_000, serverStartedAt: 50_000 });
    }
    if (path === "/reporters/remove" && method === "POST") {
      const b = JSON.parse(String(init?.body)) as { keys?: string[]; state?: string; match?: { state?: string; q?: string } };
      state.removeBodies.push(b);
      const before = state.reporters.length;
      state.reporters = state.reporters.filter((r) => !(b.keys?.includes(r.key) || (b.state && r.state === b.state) || (b.match && (!b.match.state || r.state === b.match.state) && (!b.match.q || r.name.toLowerCase().includes(b.match.q)))));
      return json(200, { ok: true, removed: before - state.reporters.length });
    }
    if (path === "/reporters/ignores" && method === "GET") return json(200, { rules: state.rules });
    if (path === "/reporters/ignores" && method === "POST") {
      const b = JSON.parse(String(init?.body)) as { kind: string; pattern: string };
      const rule = { id: state.rules.length + 1, kind: b.kind, pattern: b.pattern, createdAt: 90_000 };
      state.rules.push(rule);
      const field = b.kind === "key" ? "key" : b.kind === "version" ? "version" : "name";
      const re = new RegExp("^" + b.pattern.split("*").map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
      const before = state.reporters.length;
      state.reporters = state.reporters.filter((r) => !re.test(r[field]));
      return json(200, { ok: true, rule, removed: before - state.reporters.length });
    }
    if (path.startsWith("/reporters/ignores/") && method === "DELETE") {
      const id = Number(path.slice("/reporters/ignores/".length));
      if (!state.rules.some((r) => r.id === id)) return json(404, { ok: false, error: "unknown rule" });
      state.rules = state.rules.filter((r) => r.id !== id);
      return json(200, { ok: true });
    }
    const pm = /^\/reporters\/([^/]+)\/peers(\/propose|\/pause)?$/.exec(path);
    if (pm) {
      const key = decodeURIComponent(pm[1]!);
      const P = state.peers;
      if (!P?.reporters.some((r) => r.key === key)) return json(404, { ok: false, error: "unknown reporter" });
      if (pm[2] === "/propose") {
        const b = JSON.parse(String(init?.body)) as { from: string; to: string; level: string };
        state.proposeBodies.push(b);
        if (state.proposeError) return json(403, { ok: false, error: state.proposeError });
        const machine = (k: string) => P.reporters.find((r) => r.key === k)?.machine ?? k;
        const open = P.requests.find((r) => r.kind === "proposal" && r.fromKey === b.from && r.toKey === b.to);
        if (open) open.level = b.level;
        else P.requests.push({ id: `prq_${P.requests.length + 1}`, kind: "proposal", at: 90_000, from: { machine: machine(b.from), name: null }, to: { machine: machine(b.to), name: null }, level: b.level, by: "Admin", reason: null, text: null, fromKey: b.from, toKey: b.to, messageId: null });
        return json(202, { ok: true, requestId: open?.id ?? P.requests[P.requests.length - 1]!.id });
      }
      if (pm[2] === "/pause") {
        if (state.proposeError) return json(403, { ok: false, error: state.proposeError });
        pauseAll(P, key, (JSON.parse(String(init?.body)) as { paused: boolean }).paused);
        return json(200, { ok: true, links: 1 });
      }
      if (state.holdPeers) return new Promise<void>((go) => state.held.push(go)).then(() => json(200, peersRead(P, key)));
      return json(200, peersRead(P, key));
    }
    if (path.startsWith("/reporters/")) {
      const key = decodeURIComponent(path.slice("/reporters/".length));
      const r = state.reporters.find((x) => x.key === key);
      if (!r) return json(404, { ok: false, error: "unknown reporter" });
      if (method === "DELETE") {
        state.reporters = state.reporters.filter((x) => x.key !== key);
        return json(200, { ok: true });
      }
      return json(200, { ...r, kind: "mod", machineId: key.includes(":") ? null : key, source: "192.168.1.24", credential: "pdm_3f9a1c07b2e4", engineVersion: "2.1.299", recent: recentPage(r.sessions, url), recentTotal: r.sessions, recentPage: Number(url.searchParams.get("page") ?? 1), recentPageSize: Number(url.searchParams.get("pageSize") ?? 50), rejected: [{ t: 50_000, reason: "wrong token" }], serverTime: 100_000, serverStartedAt: 50_000 }); // NOSONAR S1313: a made-up private address in a fake server, never connected to
    }
    if (path.startsWith("/reports/")) {
      if (state.reportStatus) return json(state.reportStatus, { ok: false, error: "nope" });
      const name = path.slice("/reports/".length);
      if (name === "retention") return json(200, state.retention);
      if (name === "spend/projection") return json(200, state.projection);
      const today = /^spend\/today\/(.+)$/.exec(name);
      if (today) {
        const b = state.breakdowns[decodeURIComponent(today[1]!)];
        return b ? json(200, b) : json(404, { ok: false, error: "unknown owner" });
      }
      if (url.searchParams.get("format") === "csv") return Promise.resolve(new Response(`period,sessions\n2026-10-19,69\n`, { status: 200, headers: { "Content-Type": "text/csv" } }));
      return json(200, state.reports[name] ?? fakeReport(name, url));
    }
    if (path.startsWith("/certificates")) {
      const c = state.certs;
      if (!c) return json(404, { ok: false, error: "TLS is off" });
      if (path === "/certificates/renew" && method === "POST") {
        state.renewals += 1;
        if (state.certError) return json(500, { ok: false, error: state.certError });
        return json(200, { ok: true, ...c });
      }
      if (path === "/certificates/rotate-ca" && method === "POST") {
        const b = JSON.parse(String(init?.body)) as { endOverlap: boolean };
        state.certBodies.push(b);
        if (state.certError) return json(409, { ok: false, error: state.certError });
        c.rotation = b.endOverlap ? null : { previousCa: c.ca!, cross: fakeCert(120, { serial: "CR01" }, 120), startedAt: Date.now(), reporters: { onOldCa: 2, total: 6 } };
        return json(200, { ok: true, ...c });
      }
      if (path === "/certificates/retire-ca" && method === "POST") {
        state.certBodies.push({ retire: true });
        if (!c.rotation) return json(409, { ok: false, error: "there is no old CA to retire" });
        const refused = c.rotation.reporters.onOldCa;
        c.rotation = null;
        return json(200, { ok: true, refused, connectionsClosed: 1, ...c });
      }
      if (path === "/certificates" && method === "PUT") {
        const b = JSON.parse(String(init?.body)) as Record<string, number | boolean>;
        state.certBodies.push(b);
        if (state.certError) return json(400, { ok: false, error: state.certError });
        for (const [k, v] of Object.entries(b)) {
          if (k === "tls.header.countdown") c.settings.headerCountdown = v as boolean;
          else if (k === "tls.allowReportersOverHttp") c.http.allow = v as boolean;
          else if (k === "tls.serving.lifetimeDays") c.settings.lifetimeDays = v as number;
          else if (k === "tls.serving.renewBeforeDays") c.settings.renewBeforeDays = v as number;
          else if (k === "tls.reporter.lifetimeDays") c.reporter.lifetimeDays = v as number;
        }
        return json(200, { ok: true, ...c });
      }
      return json(200, { ok: true, ...c });
    }
    if (path === "/groups") return json(200, { total: 0, page: 1, pageSize: 50, rows: [] });
    if (path === "/log") return json(200, { retainMs: 90 * 86_400_000, total: 1, page: 1, pageSize: 50, rows: [{ id: 1, t: 1, kind: "unlock_failed", detail: "Wrong secret (1)", source: "10.0.0.1" }] }); // NOSONAR S1313: a made-up private address in a fake server, never connected to
    if (path === "/settings" && method === "PUT") {
      const b = JSON.parse(String(init?.body));
      state.bodies.push(b);
      if (b.features) for (const [id, on] of Object.entries(b.features)) state.features[id] = on as boolean;
      if (b.notices) for (const [id, on] of Object.entries(b.notices)) state.notices[id] = on as boolean;
      if ("showBackgroundSessions" in b) state.showBackground = b.showBackgroundSessions;
      if ("cardTitleMachine" in b) state.cardTitleMachine = b.cardTitleMachine;
      if (b.forgetReporters) state.forget = { ...state.forget, ...b.forgetReporters };
      if (b.peerMessaging) {
        if (state.peerLimitError) return json(400, { ok: false, error: state.peerLimitError });
        state.peerLimits = { ...state.peerLimits, ...b.peerMessaging };
      }
      if (b.activityHistory) {
        if (state.activityError) return json(400, { ok: false, error: state.activityError });
        state.activity = { ...state.activity, settings: b.activityHistory };
      }
      if (b.recording) {
        if (state.recordingError) return json(400, { ok: false, error: state.recordingError });
        if (state.recording) state.recording = { ...state.recording, settings: { ...state.recording.settings, ...b.recording } };
      }
      if (b.modelPrice) {
        if (state.priceError) return json(400, { ok: false, error: state.priceError });
        state.prices[b.modelPrice.key] = { std: b.modelPrice.std, ...(b.modelPrice.long ? { long: b.modelPrice.long } : {}) };
      }
      if (b.resetModelPrice) {
        if (state.builtin[b.resetModelPrice] === 2) state.prices["sonnet-5-5"] = { std: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 } };
        else delete state.prices[b.resetModelPrice];
      }
      return json(200, { ok: true });
    }
    if (path === "/activity-history/preview" && method === "POST") {
      state.previewBodies.push(JSON.parse(String(init?.body)));
      return state.previewError ? json(400, { ok: false, error: state.previewError }) : json(200, state.preview);
    }
    if (path === "/recordings" && method === "GET") {
      if (state.storedError) return json(500, { ok: false, error: state.storedError });
      const size = Number(url.searchParams.get("pageSize") ?? 25);
      const page = Number(url.searchParams.get("page") ?? 1);
      return json(200, { total: state.recordings.length, page, pageSize: size, rows: state.recordings.slice((page - 1) * size, page * size), totals: state.recording?.totals });
    }
    const recStop = path.match(/^\/recordings\/([^/]+)\/stop$/);
    if (recStop && method === "POST") {
      if (state.recordingError) return json(500, { ok: false, error: state.recordingError });
      const r = state.recordings.find((x) => x.sessionId === decodeURIComponent(recStop[1]!));
      if (!r) return json(404, { ok: false, error: "this session has no recording" });
      r.state = "stopped";
      return json(200, { ok: true });
    }
    const recOne = path.match(/^\/recordings\/([^/]+)$/);
    if (recOne && method === "DELETE") {
      if (state.recordingError) return json(500, { ok: false, error: state.recordingError });
      state.recordings = state.recordings.filter((x) => x.sessionId !== decodeURIComponent(recOne[1]!));
      return json(200, { ok: true, entries: 1, bytes: 1 });
    }
    if (path === "/stored-activity" && method === "GET") {
      if (state.storedError) return json(500, { ok: false, error: state.storedError });
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const project = url.searchParams.get("project");
      const owner = url.searchParams.get("owner");
      const source = url.searchParams.get("source") === "recordings" ? state.storedRecordings : state.stored;
      const hit = source.filter((r) => (!q || r.name.toLowerCase().includes(q)) && (!project || r.project === project) && (!owner || r.owner === owner));
      const sum = (rows: StoredSessionRow[]) => ({ entries: rows.reduce((n, r) => n + r.entries, 0), bytes: rows.reduce((n, r) => n + r.bytes, 0), sessions: rows.length });
      const size = Number(url.searchParams.get("pageSize") ?? 25);
      const page = Number(url.searchParams.get("page") ?? 1);
      return json(200, { total: hit.length, page, pageSize: size, rows: hit.slice((page - 1) * size, page * size), totals: { ...sum(source), fileBytes: sum(source).bytes + 1_048_576 }, match: sum(hit), projects: [...new Set(source.map((r) => r.project).filter(Boolean))], owners: [...new Set(source.map((r) => r.owner).filter(Boolean))] });
    }
    if (path === "/stored-activity/delete" && method === "POST") {
      const b = JSON.parse(String(init?.body)) as { ids?: string[]; all?: true; source?: string; match?: { q?: string; project?: string; owner?: string; source?: string } };
      state.storedDeleteBodies.push(b);
      if (state.storedError) return json(500, { ok: false, error: state.storedError });
      if (state.storedBadRequest) return json(400, { ok: false, error: state.storedBadRequest });
      const m = b.match;
      const recs = (b.source ?? m?.source) === "recordings";
      const pool = recs ? state.storedRecordings : state.stored;
      const gone = pool.filter((r) => b.all || b.ids?.includes(r.sessionId) || (m && (!m.q || r.name.toLowerCase().includes(m.q.toLowerCase())) && (!m.project || r.project === m.project) && (!m.owner || r.owner === m.owner)));
      if (recs) state.storedRecordings = pool.filter((r) => !gone.includes(r));
      else state.stored = pool.filter((r) => !gone.includes(r));
      const result = state.storedDeleteResult ?? { entries: gone.reduce((n, r) => n + r.entries, 0), sessions: gone.length, bytes: gone.reduce((n, r) => n + r.bytes, 0), freed: 1_048_576 };
      return json(200, result);
    }
    if (path === "/settings" && state.settingsError) return json(500, { ok: false, error: state.settingsError });
    if (path === "/settings") {
      const notices = Object.entries(state.notices).map(([id, on]) => ({ id, name: "Background sessions", description: "Says how many are set aside.", on }));
      const models = Object.entries(state.prices).map(([key, p]) => {
        const builtin = key in state.builtin;
        const base = key === "sonnet-5-5" ? { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 } : undefined;
        return {
          key,
          label: key === "sonnet-5-5" ? "Sonnet 5.5" : key === "haiku-5-5" ? "Haiku 5.5" : key,
          builtin,
          overridden: !!base && p.std.input !== base.input,
          std: p.std,
          ...(p.long ? { long: p.long } : {}),
          ...(base ? { builtinStd: base } : {}),
        };
      });
      const features = Object.entries(state.features).map(([id, on]) =>
        id === "peer-messaging"
          ? { id, name: "Orchestrator messaging", description: "Lets a person's orchestrators find and message each other, on the machines they choose, through this server.", on }
          : id === "activity-output"
            ? { id, name: "Bash output in the activity feed", description: "Lets a person open a Bash row in the Activity feed to see what the command printed and how it exited.", on }
            : id === "session-recording"
            ? { id, name: "Session recording", description: "Lets a session's owner, or an Admin, record everything an orchestrator and its agents do, so a run can be replayed to see what happened and why.", on }
            : { id, name: "Agent activity feed", description: "Shows an agent's recent tool calls and text in its panel while someone watches.", on },
      );
      return json(200, { allowAdminSecretReporting: true, features, notices, showBackgroundSessions: state.showBackground, cardTitleMachine: state.cardTitleMachine, forgetReporters: state.forget, modelPrices: { asOf: "2026-10-13", models }, activityHistory: state.activity, ...(state.peerLimits ? { peerMessaging: state.peerLimits } : {}), ...(state.recording ? { recording: state.recording } : {}) });
    }
    return json(404, { ok: false, error: "nope" });
  });
  vi.stubGlobal("fetch", fetchFn);
  return state;
}
