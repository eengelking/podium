// scripts/chat-edit-delete-seed.mjs (#1269): signs in as a person and posts the My group messages the edit and delete menu has to tell apart. It runs the
// seed against a small stand-in server that records what the seed sent.
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const SEED = path.join(__dirname, "chat-edit-delete-seed.mjs");
const servers: http.Server[] = [];
let runs = 0;
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** Runs the seed in this process (so the coverage run sees its lines) against a stand-in server; returns what was posted, the cookie it sent and its output. */
async function seed(opts: { addresses?: { typed: string }[]; signIn?: number }, ...options: string[]): Promise<{ posts: string[]; cookie: string; out: string; code: number | null }> {
  const posts: string[] = [];
  let cookie = "";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/sign-in")) {
        // Sign-in clears an old cookie and then sets the new one under the same name: the seed keeps the last value.
        res.statusCode = opts.signIn ?? 200;
        res.setHeader("set-cookie", ["podium_respond=; Path=/; Max-Age=0", "podium_respond=abc; Path=/"]);
        res.end(JSON.stringify({ ok: true }));
      } else if (req.url?.includes("/chat/addresses")) {
        cookie = String(req.headers.cookie ?? "");
        res.end(JSON.stringify({ ok: true, addresses: opts.addresses ?? [{ typed: "Tester@ci-01" }] }));
      } else if (req.method === "POST" && req.url?.includes("/chat/channels/group/messages")) {
        posts.push(JSON.parse(body).text as string);
        res.statusCode = 201;
        res.end(JSON.stringify({ ok: true, message: { id: `grp_${posts.length}` } }));
      } else res.end("{}");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const argv = process.argv;
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  const exit = vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
    throw new Error(`exit ${c}`);
  }) as never);
  let code: number | null = 0;
  try {
    process.argv = ["node", SEED, ...options.map((o) => (o === "<url>" ? url : o))];
    vi.resetModules();
    await import(`${SEED}?run=${++runs}`);
  } catch (e) {
    const m = /^exit (\d+)/.exec(String((e as Error).message));
    code = m ? Number(m[1]) : 1;
    lines.push(String((e as Error).message));
  } finally {
    process.argv = argv;
    log.mockRestore();
    err.mockRestore();
    exit.mockRestore();
  }
  return { posts, cookie, out: lines.join("\n"), code };
}

const base = ["--url", "<url>", "--name", "Ed", "--token", "t"];

describe("chat-edit-delete-seed.mjs", () => {
  it("posts four messages to My group, one of them mentioning the agent, signed in with the last cookie it was given", async () => {
    const r = await seed({}, ...base);
    expect(r.code, r.out).toBe(0);
    expect(r.posts).toEqual([
      "Good. Start on the chat mockup tomorrow.",
      "@Tester@ci-01 yes, run it on every adapter and report the counts.",
      "Keep the container up until I say.",
      "Never mind, I will restart the container myself.",
    ]);
    expect(r.cookie).toBe("podium_respond=abc");
    expect(r.out).toContain("grp_2  mentions Tester@ci-01, so it is sent to the agent and locked");
  });

  it("mentions the agent named by --agent", async () => {
    const r = await seed({ addresses: [{ typed: "Tester@ci-01" }, { typed: "infra-notes@box" }] }, ...base, "--agent", "infra");
    expect(r.posts[1]).toBe("@infra-notes@box yes, run it on every adapter and report the counts.");
  });

  it("stops when no address starts with the agent's name", async () => {
    const r = await seed({ addresses: [] }, ...base);
    expect(r.code).toBe(1);
    expect(r.out).toContain('no address starts with "tester"');
    expect(r.posts).toEqual([]);
  });

  it("stops when the sign-in is refused", async () => {
    const r = await seed({ signIn: 401 }, ...base);
    expect(r.code).toBe(1);
    expect(r.out).toContain("sign-in answered 401");
  });

  it("prints its help, and asks for the three options it needs", async () => {
    expect((await seed({}, "--help")).out).toContain("--url");
    const r = await seed({}, "--url", "<url>");
    expect(r.code).toBe(2);
    expect(r.out).toContain("--token");
  });
});
