import { afterEach, describe, expect, test, vi } from "vitest";
import { BACKGROUND_LIMIT, BUSY_PAUSE_MS, DiffPreloader, PRIORITY_LIMIT } from "./diffPreload";
import { RespondError } from "./respondApi";
import type { ChangedFile, FileDiffReply } from "./types";

const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({ path, status: "modified", added: 1, removed: 1, from: null, rev: "r1", ...over });
const reply = (text: string): FileDiffReply => ({ status: "ok", text, truncated: false, totalLines: 1, shownLines: 1, redactions: 0, base: "abc" }) as FileDiffReply;

/** A fetch whose answers the test settles by hand, in the order it likes. */
function harness() {
  const calls: { path: string; ok: (r: FileDiffReply) => void; fail: (e: unknown) => void }[] = [];
  const fetchDiff = vi.fn((path: string, _ahead: boolean) => new Promise<FileDiffReply>((ok, fail) => calls.push({ path, ok, fail })));
  const loader = new DiffPreloader(fetchDiff);
  const asked = () => calls.map((c) => c.path);
  const settle = async (path: string, text = path) => {
    calls.find((c) => c.path === path)!.ok(reply(text));
    await Promise.resolve();
    await Promise.resolve();
  };
  return { loader, fetchDiff, calls, asked, settle };
}

afterEach(() => vi.useRealTimers());

describe("DiffPreloader (#631)", () => {
  test("loads the files in list order, two at a time", async () => {
    const h = harness();
    h.loader.sync([file("a"), file("b"), file("c"), file("d")]);
    expect(h.asked()).toEqual(["a", "b"]);
    expect(h.loader.inFlight).toBe(BACKGROUND_LIMIT);
    await h.settle("a");
    expect(h.asked()).toEqual(["a", "b", "c"]);
    expect(h.loader.get("a")).toMatchObject({ state: "done" });
    expect(h.loader.get("d")).toMatchObject({ state: "queued" });
  });

  test("a file opened while queued moves to the front and may take one more place", async () => {
    const h = harness();
    h.loader.sync([file("a"), file("b"), file("c"), file("d")]);
    h.loader.want("d");
    expect(h.asked()).toEqual(["a", "b", "d"]);
    expect(h.loader.inFlight).toBe(PRIORITY_LIMIT);
    await h.settle("d");
    expect(h.loader.get("d")).toMatchObject({ state: "done" });
  });

  test("a load nobody asked for is marked ahead, and one the person is waiting on is not", async () => {
    const h = harness();
    h.loader.sync([file("a"), file("b"), file("c")]);
    h.loader.want("c");
    expect(h.fetchDiff.mock.calls.map((c) => [c[0], c[1]])).toEqual([["a", true], ["b", true], ["c", false]]);
    await h.settle("a");
    await h.settle("c");
    expect(h.loader.get("a")).toMatchObject({ ahead: true });
    expect(h.loader.get("c")).toMatchObject({ ahead: false });
  });

  test("a loaded file is there at once and opening it asks for nothing", async () => {
    const h = harness();
    h.loader.sync([file("a")]);
    await h.settle("a", "text of a");
    h.loader.want("a");
    expect(h.fetchDiff).toHaveBeenCalledTimes(1);
    expect(h.loader.get("a")?.reply?.text).toBe("text of a");
  });

  test("a new file in the report is loaded when it appears", async () => {
    const h = harness();
    h.loader.sync([file("a")]);
    await h.settle("a");
    h.loader.sync([file("a"), file("b")]);
    expect(h.asked()).toEqual(["a", "b"]);
  });

  test("an edited file reloads in place: the old text stays until the new one swaps in", async () => {
    const h = harness();
    h.loader.sync([file("a")]);
    await h.settle("a", "old");
    h.loader.sync([file("a", { rev: "r2" })]);
    expect(h.loader.get("a")).toMatchObject({ state: "loading", reply: { text: "old" } });
    h.calls[1]!.ok(reply("new"));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.loader.get("a")).toMatchObject({ state: "done", reply: { text: "new" } });
  });

  test("an edit that leaves the counts alone is seen through the content marker", async () => {
    const h = harness();
    h.loader.sync([file("a", { added: 3, removed: 3, rev: "x" })]);
    await h.settle("a");
    h.loader.sync([file("a", { added: 3, removed: 3, rev: "x" })]);
    expect(h.fetchDiff).toHaveBeenCalledTimes(1);
    h.loader.sync([file("a", { added: 3, removed: 3, rev: "y" })]);
    expect(h.fetchDiff).toHaveBeenCalledTimes(2);
  });

  test("an answer for content that has since changed again is dropped", async () => {
    const h = harness();
    h.loader.sync([file("a")]);
    h.loader.sync([file("a", { rev: "r2" })]);
    expect(h.asked()).toEqual(["a", "a"]);
    h.calls[0]!.ok(reply("stale"));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.loader.get("a")?.state).toBe("loading");
    h.calls[1]!.ok(reply("fresh"));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.loader.get("a")?.reply?.text).toBe("fresh");
  });

  test("a file that leaves the report drops its diff and its queue place", async () => {
    const h = harness();
    h.loader.sync([file("a"), file("b"), file("c")]);
    h.loader.sync([file("a"), file("b")]);
    expect(h.loader.get("c")).toBeUndefined();
    await h.settle("a");
    expect(h.asked()).toEqual(["a", "b"]);
  });

  test("a failed diff does not stop the others, is not retried by itself, and is retried when opened", async () => {
    const h = harness();
    h.loader.sync([file("a"), file("b")]);
    h.calls[0]!.fail(new RespondError(504, {}));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.loader.get("a")).toMatchObject({ state: "failed" });
    await h.settle("b");
    expect(h.loader.get("b")).toMatchObject({ state: "done" });
    h.loader.sync([file("a"), file("b")]);
    expect(h.fetchDiff).toHaveBeenCalledTimes(2);
    h.loader.want("a");
    expect(h.fetchDiff).toHaveBeenCalledTimes(3);
    expect(h.loader.get("a")).toMatchObject({ state: "loading" });
  });

  test("a 429 puts the file back and holds the queue still for a moment instead of failing it", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.loader.sync([file("a")]);
    h.calls[0]!.fail(new RespondError(429, {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.loader.get("a")).toMatchObject({ state: "queued" });
    expect(h.fetchDiff).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BUSY_PAUSE_MS);
    expect(h.fetchDiff).toHaveBeenCalledTimes(2);
  });

  test("a file the person opens starts during the busy pause", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.loader.sync([file("a"), file("b")]);
    h.calls[0]!.fail(new RespondError(429, {}));
    await vi.advanceTimersByTimeAsync(0);
    const before = h.fetchDiff.mock.calls.length;
    h.loader.want("b");
    expect(h.fetchDiff.mock.calls.length).toBe(before);
    h.loader.want("a");
    expect(h.fetchDiff.mock.calls.length).toBe(before + 1);
    expect(h.fetchDiff.mock.calls[h.fetchDiff.mock.calls.length - 1]![0]).toBe("a");
  });

  test("nothing new starts while the tab is hidden, and the queue resumes when it is shown", async () => {
    const h = harness();
    h.loader.setPaused(true);
    h.loader.sync([file("a"), file("b")]);
    expect(h.fetchDiff).not.toHaveBeenCalled();
    h.loader.setPaused(false);
    expect(h.asked()).toEqual(["a", "b"]);
  });

  test("disposing discards what is held, cancels the queue and ignores late answers", async () => {
    const h = harness();
    h.loader.sync([file("a"), file("b"), file("c")]);
    h.loader.dispose();
    expect(h.loader.get("a")).toBeUndefined();
    await h.settle("a");
    h.loader.sync([file("a")]);
    expect(h.asked()).toEqual(["a", "b"]);
    expect(h.loader.get("a")).toBeUndefined();
  });

  test("it notifies subscribers when a slot changes", async () => {
    const h = harness();
    const cb = vi.fn();
    h.loader.subscribe(cb);
    h.loader.sync([file("a")]);
    const before = cb.mock.calls.length;
    await h.settle("a");
    expect(cb.mock.calls.length).toBeGreaterThan(before);
  });
});
