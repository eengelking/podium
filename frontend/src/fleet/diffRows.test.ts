import { describe, expect, it } from "vitest";
import { parseDiff, sideBySide, splitRedacted, type DiffRow } from "./diffRows";

const text = (rows: DiffRow[]) => rows.map((r) => r.kind + (r.kind === "hunk" ? ":" + r.text : ""));

describe("parseDiff (#319)", () => {
  it("numbers context, removed and added lines from the hunk header", () => {
    const rows = parseDiff("@@ -41,3 +41,4 @@ function f() {\n  keep\n-gone\n+new1\n+new2\n  tail");
    expect(rows).toEqual([
      { kind: "hunk", text: "@@ -41,3 +41,4 @@ function f() {" },
      { kind: "ctx", old: 41, now: 41, text: " keep" },
      { kind: "del", old: 42, text: "gone" },
      { kind: "add", now: 42, text: "new1" },
      { kind: "add", now: 43, text: "new2" },
      { kind: "ctx", old: 43, now: 44, text: " tail" },
    ]);
  });
  it("handles a header with no counts, a new file and a deleted file", () => {
    expect(parseDiff("@@ -1 +1 @@\n-a\n+b")).toEqual([
      { kind: "hunk", text: "@@ -1 +1 @@" },
      { kind: "del", old: 1, text: "a" },
      { kind: "add", now: 1, text: "b" },
    ]);
    expect(parseDiff("@@ -0,0 +1,2 @@\n+x\n+y").map((r) => ("now" in r ? r.now : null))).toEqual([null, 1, 2]);
    expect(parseDiff("@@ -1,2 +0,0 @@\n-x\n-y").map((r) => ("old" in r ? r.old : null))).toEqual([null, 1, 2]);
  });
  it("keeps a line that starts with the marker twice, and the no-newline note", () => {
    const rows = parseDiff("@@ -1 +1 @@\n--- not a header\n+++ nor this\n\\ No newline at end of file");
    expect(rows.map((r) => r.kind)).toEqual(["hunk", "del", "add", "note"]);
    expect(rows[1]).toMatchObject({ text: "-- not a header" });
  });
  it("starts the numbers again at each hunk", () => {
    const rows = parseDiff("@@ -1 +1 @@\n-a\n+b\n@@ -10 +10 @@\n-c\n+d");
    expect(rows.filter((r) => r.kind === "del").map((r) => (r as { old: number }).old)).toEqual([1, 10]);
  });
  it("is empty for no text, and drops the file headers git leaves before the first hunk", () => {
    expect(parseDiff("")).toEqual([]);
    expect(text(parseDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b"))).toEqual(["hunk:@@ -1 +1 @@", "del", "add"]);
  });
  it("treats a line with no marker as context rather than losing it", () => {
    expect(parseDiff("@@ -1 +1 @@\nbare")[1]).toMatchObject({ kind: "ctx", text: "bare" });
  });
});

describe("splitRedacted (#319)", () => {
  it("splits a line around each [redacted], keeping the rest", () => {
    expect(splitRedacted("password: [redacted] and [redacted].")).toEqual([
      { text: "password: ", redacted: false },
      { text: "[redacted]", redacted: true },
      { text: " and ", redacted: false },
      { text: "[redacted]", redacted: true },
      { text: ".", redacted: false },
    ]);
    expect(splitRedacted("plain")).toEqual([{ text: "plain", redacted: false }]);
    expect(splitRedacted("")).toEqual([]);
  });
});

describe("sideBySide (#319)", () => {
  const sbs = (d: string) => sideBySide(parseDiff(d));
  it("puts a removed line left and an added line right, level, with a filler for the one that has no partner", () => {
    const { left, right } = sbs("@@ -1,3 +1,3 @@\n  keep\n-a\n-b\n+c\n  tail");
    expect(left.map((c) => c.kind)).toEqual(["hunk", "ctx", "del", "del", "ctx"]);
    expect(right.map((c) => c.kind)).toEqual(["hunk-fill", "ctx", "add", "fill", "ctx"]);
    expect(left[2]).toMatchObject({ no: 2, text: "a" });
    expect(right[2]).toMatchObject({ no: 2, text: "c" });
    expect(left.length).toBe(right.length);
  });
  it("leaves the left empty for a new file and the right empty for a deleted one", () => {
    const added = sbs("@@ -0,0 +1,2 @@\n+x\n+y");
    expect(added.left.map((c) => c.kind)).toEqual(["hunk", "fill", "fill"]);
    expect(added.right.map((c) => c.kind)).toEqual(["hunk-fill", "add", "add"]);
    const gone = sbs("@@ -1,2 +0,0 @@\n-x\n-y");
    expect(gone.right.map((c) => c.kind)).toEqual(["hunk-fill", "fill", "fill"]);
  });
  it("pairs each run of removed lines with the added lines that follow it, then moves on", () => {
    const { left, right } = sbs("@@ -1,2 +1,2 @@\n-a\n+b\n  mid\n-c\n+d");
    expect(left.map((c) => c.kind)).toEqual(["hunk", "del", "ctx", "del"]);
    expect(right.map((c) => c.kind)).toEqual(["hunk-fill", "add", "ctx", "add"]);
  });
  it("shows the no-newline note on both sides", () => {
    const { left, right } = sbs("@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file");
    expect(left[left.length - 1]).toMatchObject({ kind: "note" });
    expect(right[right.length - 1]).toMatchObject({ kind: "note" });
  });
});
