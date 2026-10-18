// A small in-memory stand-in for /api/admin, shared by the Admin tests and the standards pages' Admin screens (#354).
import { vi } from "vitest";

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

/** A small in-memory stand-in for /api/admin. */
export function fakeServer(opts: { people?: number; enabled?: boolean; unlocked?: boolean; respondAdmin?: boolean } = {}) {
  const state = {
    enabled: opts.enabled ?? true,
    unlocked: opts.unlocked ?? false,
    respondAdmin: opts.respondAdmin ?? false,
    unlockBodies: [] as unknown[],
    people: Array.from({ length: opts.people ?? 0 }, (_, i): P => ({ id: i + 1, name: `person-${String(i).padStart(3, "0")}`, groupId: null, revokedAt: null })),
    groups: [] as { id: number; name: string; builtIn?: boolean }[],
    calls: [] as string[],
    expire: false,
    notices: { "background-sessions": true } as Record<string, boolean>,
    features: { "activity-feed": true } as Record<string, boolean>,
    bodies: [] as unknown[],
    showBackground: false,
    prices: {
      "sonnet-5-5": { std: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 } } as { std: PriceSet; long?: PriceSet },
      "haiku-5-5": { std: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2 }, long: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWrite1h: 1 } } as { std: PriceSet; long?: PriceSet },
    } as Record<string, { std: PriceSet; long?: PriceSet }>,
    builtin: { "sonnet-5-5": 2, "haiku-5-5": 0.1 } as Record<string, number>,
    priceError: "" as string,
    removeBodies: [] as unknown[],
    pageLimit: 50,
    rules: [] as { id: number; kind: string; pattern: string; createdAt: number }[],
    forget: { enabled: false, days: 30 },
    reporters: [
      { key: "9f3a1c7d2e40", state: "reporting", name: "studio-m2", named: true, who: "Dana", credential: "pdm_3f9a1c07b2e4", adminSecret: false, version: "0.13.0", compat: "ok", firstSeenAt: 1_000, lastSeenAt: 40_000, sessions: 142, live: 3 },
      { key: "addr:10.4.0.52", state: "silent", name: "10.4.0.52", named: false, who: "Admin", credential: "admin secret", adminSecret: true, version: "0.9.2", compat: "outdated", firstSeenAt: 1_000, lastSeenAt: 1_000, sessions: 9, live: 0 },
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
    const url = new URL(String(input), "http://x");
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/api/admin", "");
    state.calls.push(`${method} ${path}${url.search}`);
    if (path === "/session") return json(200, { enabled: state.enabled, unlocked: state.unlocked });
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
      const re = new RegExp("^" + b.pattern.split("*").join(".*") + "$", "i");
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
    if (path.startsWith("/reporters/")) {
      const key = decodeURIComponent(path.slice("/reporters/".length));
      const r = state.reporters.find((x) => x.key === key);
      if (!r) return json(404, { ok: false, error: "unknown reporter" });
      if (method === "DELETE") {
        state.reporters = state.reporters.filter((x) => x.key !== key);
        return json(200, { ok: true });
      }
      return json(200, { ...r, kind: "mod", machineId: key.includes(":") ? null : key, source: "192.168.1.24", credential: "pdm_3f9a1c07b2e4", engineVersion: "2.1.299", recent: recentPage(r.sessions, url), recentTotal: r.sessions, recentPage: Number(url.searchParams.get("page") ?? 1), recentPageSize: Number(url.searchParams.get("pageSize") ?? 50), rejected: [{ t: 50_000, reason: "wrong token" }], serverTime: 100_000, serverStartedAt: 50_000 });
    }
    if (path === "/groups") return json(200, { total: 0, page: 1, pageSize: 50, rows: [] });
    if (path === "/log") return json(200, { retainMs: 90 * 86_400_000, total: 1, page: 1, pageSize: 50, rows: [{ id: 1, t: 1, kind: "unlock_failed", detail: "Wrong secret (1)", source: "10.0.0.1" }] });
    if (path === "/settings" && method === "PUT") {
      const b = JSON.parse(String(init?.body));
      state.bodies.push(b);
      if (b.features) for (const [id, on] of Object.entries(b.features)) state.features[id] = on as boolean;
      if (b.notices) for (const [id, on] of Object.entries(b.notices)) state.notices[id] = on as boolean;
      if ("showBackgroundSessions" in b) state.showBackground = b.showBackgroundSessions;
      if (b.forgetReporters) state.forget = { ...state.forget, ...b.forgetReporters };
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
      const features = Object.entries(state.features).map(([id, on]) => ({
        id,
        name: "Agent activity feed",
        description: "Shows an agent's recent tool calls and text in its panel while someone watches.",
        on,
      }));
      return json(200, { allowAdminSecretReporting: true, features, notices, showBackgroundSessions: state.showBackground, forgetReporters: state.forget, modelPrices: { asOf: "2026-10-13", models } });
    }
    return json(404, { ok: false, error: "nope" });
  });
  vi.stubGlobal("fetch", fetchFn);
  return state;
}
