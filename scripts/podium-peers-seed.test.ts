// scripts/podium-peers-seed.mjs: the Admin flags its options turn on (#976). It runs the seed against a small stand-in server that
// answers every call with success, and reads what the seed sent to PUT /api/admin/settings.
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const SEED = path.join(__dirname, "podium-peers-seed.mjs");
const servers: http.Server[] = [];
let runs = 0;
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** Runs the seed with these options and returns the features of the first settings write, and the seed's output. */
async function seed(...options: string[]): Promise<{ features: Record<string, boolean>; out: string; code: number | null }> {
  const writes: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "PUT" && req.url === "/api/admin/settings") writes.push(JSON.parse(body));
      res.setHeader("content-type", "application/json");
      // The sign-in must set a cookie, and creating a person must answer with a token and the stored name.
      if (req.url?.endsWith("/sign-in")) res.setHeader("set-cookie", "podium_respond=abc; Path=/");
      res.end(JSON.stringify({ ok: true, token: "tok", person: { name: "Ed" }, peerDeliveries: [] }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // In this process, not a child, so the coverage run sees the seed's lines. The seed runs when it is imported.
  const argv = process.argv;
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  const exit = vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
    throw new Error(`exit ${c}`);
  }) as never);
  let code: number | null = 0;
  try {
    process.argv = ["node", SEED, "--url", url, "--secret", "s", ...options];
    vi.resetModules();
    await import(`${SEED}?run=${++runs}`);
  } catch (e) {
    code = /^exit (\d+)/.exec(String((e as Error).message))?.[1] ? Number(/^exit (\d+)/.exec(String((e as Error).message))![1]) : 1;
    lines.push(String((e as Error).message));
  } finally {
    process.argv = argv;
    log.mockRestore();
    exit.mockRestore();
  }
  const out = lines.join("\n");
  return { features: writes[0]?.features ?? {}, out, code };
}

describe("podium-peers-seed.mjs", () => {
  it("turns on the messaging flags only, by default", async () => {
    const r = await seed();
    expect(r.code, r.out).toBe(0);
    expect(r.features).toEqual({ "peer-messaging": true, respond: true, "activity-feed": true });
    expect(r.out).toContain("name=Ed");
  });

  it("turns on the Admin flag of each of --activity-output, --session-recording and --file-diff", async () => {
    const r = await seed("--activity-output", "--session-recording", "--file-diff");
    expect(r.code, r.out).toBe(0);
    expect(r.features).toEqual({ "peer-messaging": true, respond: true, "activity-feed": true, "activity-output": true, "session-recording": true, "file-diff": true });
    expect((await seed("--file-diff")).features).toEqual({ "peer-messaging": true, respond: true, "activity-feed": true, "file-diff": true });
  });

  it("lists the three options in its help", async () => {
    const r = await seed("--help");
    for (const f of ["--activity-output", "--session-recording", "--file-diff"]) expect(r.out).toContain(f);
  });
});
