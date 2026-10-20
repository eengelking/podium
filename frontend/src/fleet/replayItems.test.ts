// The replay's rows (#353): results go under their calls, marks get their words, long output is cut for the failure box.
import { describe, expect, it } from "vitest";
import { buildItems, firstLine, markWords, nextFailure, tailLines } from "./replayItems";
import type { RecordingRow } from "./types";

let n = 0;
const row = (over: Partial<RecordingRow>): RecordingRow => ({ n: ++n, loop: "@orchestrator", at: 1_000 * n, kind: "text", text: "", ...over });

describe("buildItems", () => {
  it("puts a result under the call it answers", () => {
    const items = buildItems([row({ kind: "tool", name: "Read", text: "a.ts" }), row({ kind: "result", name: "Read", text: "contents" })]);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("tool");
    expect(items[0]!.result!.text).toBe("contents");
    expect(items[0]!.failed).toBe(false);
  });

  it("gives calls made together their results in order", () => {
    const items = buildItems([
      row({ kind: "tool", name: "Read", text: "one" }),
      row({ kind: "tool", name: "Read", text: "two" }),
      row({ kind: "result", name: "Read", text: "result one" }),
      row({ kind: "result", name: "Read", text: "result two" }),
    ]);
    expect(items.map((i) => i.result!.text)).toEqual(["result one", "result two"]);
  });

  it("keeps a loop's results apart from another's", () => {
    const items = buildItems([row({ kind: "tool", name: "Bash", loop: "a" }), row({ kind: "result", name: "Bash", loop: "b", text: "other" })]);
    expect(items.map((i) => i.kind)).toEqual(["tool", "result"]);
    expect(items[0]!.result).toBeUndefined();
  });

  it("marks a call whose result failed", () => {
    const items = buildItems([row({ kind: "tool", name: "Bash" }), row({ kind: "result", name: "Bash", failed: true })]);
    expect(items[0]!.failed).toBe(true);
  });

  it("stands a result whose call is on an older page as a row of its own", () => {
    const items = buildItems([row({ kind: "result", name: "Bash", failed: true, text: "boom" })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "result", failed: true });
  });

  it("keeps prompts, text and thinking in the server's order", () => {
    const items = buildItems([row({ kind: "prompt" }), row({ kind: "thinking" }), row({ kind: "text" })]);
    expect(items.map((i) => i.kind)).toEqual(["prompt", "thinking", "text"]);
  });

  it("turns the rest into marks, those from the server in Podium's voice", () => {
    const items = buildItems([row({ kind: "clear" }), row({ kind: "compact" }), row({ kind: "gap", lost: 3 }), row({ kind: "stopped", by: "Ed" }), row({ kind: "limit", text: "The recording stopped: the disk budget was reached." })]);
    expect(items.map((i) => i.kind)).toEqual(["mark", "mark", "mark", "mark", "mark"]);
    expect(items.map((i) => i.podium)).toEqual([false, false, false, true, true]);
    expect(items[3]!.mark).toBe("Recording stopped by Ed. Everything up to here was kept.");
  });
});

describe("rows sent from Podium", () => {
  it("makes a decision a row of its own, in order, worded by what it answers and whether it failed", () => {
    const cases: [string, boolean, string][] = [
      ["question", false, "Answered a question"],
      ["plan", false, "Approved a plan"],
      ["plan", true, "Sent a plan back"],
      ["permission", false, "Allowed a tool once"],
      ["permission", true, "Denied a tool"],
      ["other", false, "Answered from Podium"],
    ];
    for (const [name, failed, label] of cases) {
      const items = buildItems([row({ kind: "tool", name: "Bash" }), row({ kind: "decision", name, failed, by: "Ed", text: "git push" })]);
      expect(items.map((i) => i.kind)).toEqual(["tool", "decision"]);
      expect(items[1]).toMatchObject({ label, by: "Ed", failed });
    }
  });

  it("says who sent a decision, a prompt, a /clear and a /compact, and leaves it out of the others", () => {
    const items = buildItems([row({ kind: "decision", name: "question" }), row({ kind: "prompt", by: "Ed" }), row({ kind: "prompt" }), row({ kind: "clear", by: "Ed" }), row({ kind: "compact" }), row({ kind: "stopped", by: "Ed" })]);
    expect(items.map((i) => i.by)).toEqual(["", "Ed", undefined, "Ed", undefined, undefined]);
  });

  it("turns a kind it does not know into a marked row with its text", () => {
    const items = buildItems([row({ kind: "novel" as never, text: "Something new." }), row({ kind: "novel" as never })]);
    expect(items.map((i) => [i.kind, i.mark])).toEqual([["mark", "Something new."], ["mark", "Something happened here."]]);
  });
});

describe("markWords", () => {
  it("says what each mark means", () => {
    expect(markWords(row({ kind: "clear" }))).toMatch(/cleared/);
    expect(markWords(row({ kind: "compact" }))).toMatch(/compacted/);
    expect(markWords(row({ kind: "gap", lost: 1 }))).toBe("1 entry was lost: the machine could not reach the server for a while.");
    expect(markWords(row({ kind: "gap", lost: 4 }))).toMatch(/^4 entries were lost/);
    expect(markWords(row({ kind: "gap" }))).toMatch(/^0 entries were lost/);
    expect(markWords(row({ kind: "stopped" }))).toBe("Recording stopped. Everything up to here was kept.");
    expect(markWords(row({ kind: "limit" }))).toMatch(/stopped at its limit/);
    expect(markWords(row({ kind: "limit", text: "Over." }))).toBe("Over. Nothing after this point was kept.");
  });
});

describe("text helpers", () => {
  it("takes the first line, cut, and says whether anything is left", () => {
    expect(firstLine("one")).toEqual({ line: "one", more: false });
    expect(firstLine("one\ntwo")).toEqual({ line: "one", more: true });
    expect(firstLine("x".repeat(300))).toEqual({ line: "x".repeat(200), more: true });
    expect(firstLine("abcdef", 3)).toEqual({ line: "abc", more: true });
  });

  it("keeps the last lines of an output", () => {
    expect(tailLines("a\nb\nc", 2)).toBe("b\nc");
    expect(tailLines("a\nb")).toBe("a\nb");
  });

  it("finds the next failure after a place, wrapping round, or none", () => {
    const items = buildItems([row({ kind: "tool", name: "A" }), row({ kind: "result", name: "A", failed: true }), row({ kind: "text" }), row({ kind: "tool", name: "B" }), row({ kind: "result", name: "B", failed: true })]);
    expect(items).toHaveLength(3);
    expect(nextFailure(items, 0)).toBe(2);
    expect(nextFailure(items, 2)).toBe(0);
    expect(nextFailure(buildItems([row({ kind: "text" })]), 0)).toBe(-1);
  });
});
