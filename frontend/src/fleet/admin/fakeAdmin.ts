// A small in-memory stand-in for /api/admin, shared by the Admin tests and the standards pages' Admin screens (#354).
import { vi } from "vitest";
import type { ActivityHistoryPreview, ActivityHistoryState, StoredDeleteResult, StoredSessionRow } from "./adminApi";

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
    pageLimit: 50,
    rules: [] as { id: number; kind: string; pattern: string; createdAt: number }[],
    forget: { enabled: false, days: 30 },
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
    reporters: [
      { key: "9f3a1c7d2e40", state: "reporting", name: "studio-m2", named: true, who: "Dana", credential: "pdm_3f9a1c07b2e4", adminSecret: false, version: "0.13.0", compat: "ok", firstSeenAt: 1_000, lastSeenAt: 40_000, sessions: 142, live: 3 },
      { key: "addr:10.4.0.52", state: "silent", name: "10.4.0.52", named: false, who: "Admin", credential: "admin secret", adminSecret: true, version: "0.9.2", compat: "outdated", firstSeenAt: 1_000, lastSeenAt: 1_000, sessions: 9, live: 0 }, // NOSONAR S1313: a made-up private address in a fake server, never connected to
    ] as { key: string; state: string; name: string; named: boolean; who: string; credential: string | null; adminSecret: boolean; version: string; compat: string; firstSeenAt: number; lastSeenAt: number; sessions: number; live: number }[],
  };
  const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  const row = (p: P) => ({ id: p.id, name: p.name, credential: "pdm_0123456789ab", groupId: p.groupId, groupName: state.groups.find((g) => g.id === p.groupId)?.name ?? null, createdAt: 1, rotatedAt: null, revokedAt: p.revokedAt, lastReportAt: null, machines: [] });
  /** The sessions of one page of a reporter's details: session-1 is the newest. */
  const recentPage = (total: number, url: URL) => {
    const size = Number(url.searchParams.get("pageSize") ?? 50);
    const from = (Number(url.searchParams.get("page") ?? 1) - 1) * size;
    return Array.from({ length: Math.max(0, Math.min(size, total - from)) }, (_, i) => ({ id: `s${from + i + 1}`, name: `session-${from + i + 1}`, status: "ended", lastSeenAt: 99_000 - from - i, costUsd: 1.84 }));
  };
  const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://x");
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/api/admin", "");
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
      return json(200, { total: all.length, page, pageSize: size, rows: all.slice((page - 1) * size, page * size).map(row), groups: state.groups });
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
      return json(201, { ok: true, person: row(p), token: "pdm_aaaaaaaaaaaa_" + "b".repeat(48) });
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
    if (path === "/stored-activity" && method === "GET") {
      if (state.storedError) return json(500, { ok: false, error: state.storedError });
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const project = url.searchParams.get("project");
      const owner = url.searchParams.get("owner");
      const hit = state.stored.filter((r) => (!q || r.name.toLowerCase().includes(q)) && (!project || r.project === project) && (!owner || r.owner === owner));
      const sum = (rows: StoredSessionRow[]) => ({ entries: rows.reduce((n, r) => n + r.entries, 0), bytes: rows.reduce((n, r) => n + r.bytes, 0), sessions: rows.length });
      const size = Number(url.searchParams.get("pageSize") ?? 25);
      const page = Number(url.searchParams.get("page") ?? 1);
      return json(200, { total: hit.length, page, pageSize: size, rows: hit.slice((page - 1) * size, page * size), totals: { ...sum(state.stored), fileBytes: sum(state.stored).bytes + 1_048_576 }, match: sum(hit), projects: [...new Set(state.stored.map((r) => r.project).filter(Boolean))], owners: [...new Set(state.stored.map((r) => r.owner).filter(Boolean))] });
    }
    if (path === "/stored-activity/delete" && method === "POST") {
      const b = JSON.parse(String(init?.body)) as { ids?: string[]; all?: true; match?: { q?: string; project?: string; owner?: string } };
      state.storedDeleteBodies.push(b);
      if (state.storedError) return json(500, { ok: false, error: state.storedError });
      if (state.storedBadRequest) return json(400, { ok: false, error: state.storedBadRequest });
      const m = b.match;
      const gone = state.stored.filter((r) => b.all || b.ids?.includes(r.sessionId) || (m && (!m.q || r.name.toLowerCase().includes(m.q.toLowerCase())) && (!m.project || r.project === m.project) && (!m.owner || r.owner === m.owner)));
      state.stored = state.stored.filter((r) => !gone.includes(r));
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
          : { id, name: "Agent activity feed", description: "Shows an agent's recent tool calls and text in its panel while someone watches.", on },
      );
      return json(200, { allowAdminSecretReporting: true, features, notices, showBackgroundSessions: state.showBackground, cardTitleMachine: state.cardTitleMachine, forgetReporters: state.forget, modelPrices: { asOf: "2026-10-13", models }, activityHistory: state.activity, ...(state.peerLimits ? { peerMessaging: state.peerLimits } : {}) });
    }
    return json(404, { ok: false, error: "nope" });
  });
  vi.stubGlobal("fetch", fetchFn);
  return state;
}
