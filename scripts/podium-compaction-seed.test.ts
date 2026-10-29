import { describe, expect, it } from "vitest";
import { HELP, build, buildAll, loadSample, main } from "./podium-compaction-seed.mjs";

const NOW = 1_800_000_000_000;
const autoCompacts = (r: any) => r.events.filter((e: any) => e.kind === "compact" && e.data?.trigger === "auto");

describe("podium-compaction-seed: the sessions it builds (#805)", () => {
  it("makes three sessions: compacted only, compacted and blown out, and neither", () => {
    const [only, blown, never] = buildAll(loadSample(), NOW) as any[];
    expect(only.session.name).toBe("compacted-only");
    expect(autoCompacts(only).map((e: any) => e.data.percent)).toEqual([22, 25]);
    expect(only.events.some((e: any) => e.kind === "blow")).toBe(false);
    expect(only.session.blowouts).toBe(0);
    expect(only.agents.every((a: any) => a.blowouts === 0)).toBe(true);
    expect(autoCompacts(blown)).toHaveLength(1);
    expect(blown.events.some((e: any) => e.kind === "blow")).toBe(true);
    expect(autoCompacts(never)).toHaveLength(0);
    expect(new Set([only, blown, never].map((r) => r.session.id)).size).toBe(3);
  });

  it("gives every event an id of its own session and shifts the times to now", () => {
    const sample = loadSample();
    const r = build(sample, "x", { compactions: [30], blowouts: true }, NOW) as any;
    expect(r.sentAt).toBe(NOW);
    expect(r.events.every((e: any) => e.id.startsWith(`${r.session.id}:`))).toBe(true);
    expect(new Set(r.events.map((e: any) => e.id)).size).toBe(r.events.length);
    expect(r.events.every((e: any) => e.t > NOW - 3_600_000 && e.t <= NOW)).toBe(true);
  });
});

describe("podium-compaction-seed: running it", () => {
  const run = async (args: string[], over: Record<string, unknown> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const posts: { url: string; headers: Record<string, string>; body: any }[] = [];
    const code = await main(args, {
      log: (s: string) => out.push(s),
      error: (s: string) => err.push(s),
      now: () => NOW,
      fetchFn: async (u: URL, init: any) => {
        posts.push({ url: String(u), headers: init.headers, body: JSON.parse(init.body) });
        return { ok: true, status: 200, text: async () => "" };
      },
      every: () => 0,
      ...over,
    });
    return { code, out, err, posts };
  };

  it("prints its help, and refuses to run without --url", async () => {
    expect((await run(["--help"])).out).toEqual([HELP]);
    const none = await run([]);
    expect(none.code).toBe(2);
    expect(none.err[0]).toContain("--url is required");
    expect(none.posts).toHaveLength(0);
  });

  it("posts the three sessions to the report endpoint, with the token when given", async () => {
    const r = await run(["--url", "http://127.0.0.1:9", "--token", "t"]);
    expect(r.code).toBe(0);
    expect(r.posts.map((p) => p.url)).toEqual(Array(3).fill("http://127.0.0.1:9/api/fleet/report"));
    expect(r.posts.every((p) => p.headers["x-podium-token"] === "t")).toBe(true);
    expect(r.out).toEqual(["posted 3 sessions to http://127.0.0.1:9"]);
    const open = await run(["--url", "http://127.0.0.1:9"]);
    expect(open.posts.every((p) => !("x-podium-token" in p.headers))).toBe(true);
  });

  it("with --keep reports again on the timer, and says what a refusal was", async () => {
    let tick: (() => void) | null = null;
    const kept = await run(["--url", "http://127.0.0.1:9", "--keep"], { every: (fn: () => void) => (tick = fn) });
    expect(kept.out[1]).toContain("every 8 seconds");
    tick!();
    await new Promise((r) => setTimeout(r, 0));
    expect(kept.posts.length).toBeGreaterThan(3);

    const errors: string[] = [];
    let fail = false;
    let timer: (() => void) | null = null;
    await main(["--url", "http://127.0.0.1:9", "--keep"], {
      log: () => {},
      error: (s: string) => errors.push(s),
      now: () => NOW,
      fetchFn: async () => (fail ? { ok: false, status: 401, text: async () => "no" } : { ok: true, status: 200, text: async () => "" }),
      every: (fn: () => void) => (timer = fn),
    });
    fail = true;
    timer!();
    await new Promise((r) => setTimeout(r, 0));
    expect(errors[0]).toBe("compacted-only: 401 no");
  });
});
