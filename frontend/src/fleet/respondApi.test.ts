import { afterEach, describe, expect, it, vi } from "vitest";
import { peersApi, respondApi, RespondError } from "./respondApi";

afterEach(() => vi.unstubAllGlobals());

const reply = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });

describe("respondApi.fileDiff (#319)", () => {
  it("asks for one path of one session, with the cookie, and returns the diff as sent", async () => {
    const diff = { path: "src/a b.ts", status: "ok", text: "@@ -1 +1 @@\n-a\n+b", truncated: false, shownLines: 3, totalLines: 3, redactions: 0, base: "abc1234" };
    const fetchMock = vi.fn(async () => reply(200, diff));
    vi.stubGlobal("fetch", fetchMock);
    expect(await respondApi.fileDiff("sess/1", "src/a b.ts")).toEqual(diff);
    expect(fetchMock).toHaveBeenCalledWith("/api/fleet/respond/sessions/sess%2F1/files/diff?path=src%2Fa%20b.ts", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
  });
  it("throws a RespondError with the status and the body for a refusal, and survives a body that is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(403, { error: "not your session", owner: "Ed" })));
    await expect(respondApi.fileDiff("s", "a")).rejects.toMatchObject({ status: 403, body: { owner: "Ed" }, message: "not your session" });
    vi.stubGlobal("fetch", vi.fn(async () => reply(504, "<html>gateway</html>")));
    const err = await respondApi.fileDiff("s", "a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RespondError);
    expect(err).toMatchObject({ status: 504, message: "HTTP 504" });
  });
});

describe("the respond and peers calls (#467)", () => {
  it("sends each call to its path with the right method, the respond header, and a JSON body only when it has one", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => reply(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    const base = "/api/fleet/respond";
    const calls: [() => Promise<unknown>, string, string, unknown?][] = [
      [() => respondApi.me(), "GET", `${base}/me`],
      [() => respondApi.signIn("Ed", "tok"), "POST", `${base}/sign-in`, { name: "Ed", token: "tok" }],
      [() => respondApi.signOut(), "POST", `${base}/sign-out`],
      [() => respondApi.ask("s/1", "a b"), "GET", `${base}/sessions/s%2F1/asks/a%20b`],
      [() => respondApi.answer("s1", "a1", { choice: "yes" }), "POST", `${base}/sessions/s1/asks/a1/answer`, { choice: "yes" }],
      [() => respondApi.message("s1", { text: "hi" }), "POST", `${base}/sessions/s1/messages`, { text: "hi" }],
      [() => respondApi.discard("d/1"), "DELETE", `${base}/deliveries/d%2F1`],
      [() => peersApi.read(), "GET", `${base}/peers`],
      [() => peersApi.setRight("k1", "k2", "send"), "PUT", `${base}/peers/rights`, { from: "k1", to: "k2", level: "send" }],
      [() => peersApi.setDefaults({ trust: true }), "PUT", `${base}/peers/defaults`, { trust: true }],
      [() => peersApi.answer("r/1", "allow"), "POST", `${base}/peers/requests/r%2F1`, { answer: "allow" }],
    ];
    for (const [run, method, url, body] of calls) {
      fetchMock.mockClear();
      await run();
      const [gotUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
      expect(gotUrl).toBe(url);
      expect(init).toMatchObject({ method, credentials: "same-origin" });
      expect(init.headers["X-Podium-Respond"]).toBe("1");
      if (body === undefined) {
        expect(init.body).toBeUndefined();
        expect(init.headers["Content-Type"]).toBeUndefined();
      } else {
        expect(JSON.parse(init.body as string)).toEqual(body);
        expect(init.headers["Content-Type"]).toBe("application/json");
      }
    }
  });
});
