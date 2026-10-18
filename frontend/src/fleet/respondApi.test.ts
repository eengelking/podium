import { afterEach, describe, expect, it, vi } from "vitest";
import { respondApi, RespondError } from "./respondApi";

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
