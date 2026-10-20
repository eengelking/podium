import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { USAGE, findChrome, launchChrome, parseArgs, pickPageSocket } from "./page-shot.mjs";

/** A stand-in for the Chrome process: records the signals it gets and exits on the first one. */
function fakeChild(opts: { exitOnSignal?: boolean } = {}) {
  const child: any = new EventEmitter();
  child.exitCode = null;
  child.signals = [] as string[];
  child.kill = (sig: string) => {
    child.signals.push(sig);
    if (opts.exitOnSignal !== false || sig === "SIGKILL") {
      child.exitCode = 0;
      child.emit("exit", 0);
    }
    return true;
  };
  return child;
}

const profiles = () => readdirSync(tmpdir()).filter((n) => n.startsWith("page-shot-"));

describe("page-shot parseArgs", () => {
  it("requires a url and never defaults to a server", () => {
    expect(parseArgs([])).toEqual({ error: "--url is required (there is no default server)" });
  });

  it("fills the defaults: 400 wide, 900 high, one second of waiting, a png in the temp folder", () => {
    const r: any = parseArgs(["--url", "http://127.0.0.1:4391/#/me/reporters"]);
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ url: "http://127.0.0.1:4391/#/me/reporters", width: 400, height: 900, wait: 1000, evalJs: "", chrome: "" });
    expect(r.out).toBe(join(tmpdir(), "page-shot-400.png"));
  });

  it("takes every option, with the png named for the width when --out is absent", () => {
    const r: any = parseArgs(["--url", "https://x.test/", "--width", "1440", "--height", "800", "--wait", "250", "--eval", "1+1", "--out", "/a/b.png", "--chrome", "/c/chrome"]);
    expect(r).toEqual({ url: "https://x.test/", width: 1440, height: 800, wait: 250, evalJs: "1+1", out: "/a/b.png", chrome: "/c/chrome" });
    expect((parseArgs(["--url", "https://x.test/", "--width", "1440"]) as any).out).toBe(join(tmpdir(), "page-shot-1440.png"));
  });

  it("answers --help and -h", () => {
    expect(parseArgs(["--help"])).toEqual({ help: true });
    expect(parseArgs(["--url", "http://a.test", "-h"])).toEqual({ help: true });
    expect(USAGE).toContain("Usage: node scripts/page-shot.mjs");
  });

  it("refuses what it cannot use, naming the option", () => {
    expect(parseArgs(["--url", "not a url"])).toEqual({ error: "--url must be an http or https address" });
    expect(parseArgs(["--url", "file:///etc/passwd"])).toEqual({ error: "--url must be an http or https address" });
    expect(parseArgs(["--url", "http://a.test", "--width", "0"])).toEqual({ error: "--width must be a whole number above 0" });
    expect(parseArgs(["--url", "http://a.test", "--height", "tall"])).toEqual({ error: "--height must be a whole number above 0" });
    expect(parseArgs(["--url", "http://a.test", "--wait", "-5"])).toEqual({ error: "--wait must be a whole number of milliseconds, 0 or more" });
    expect(parseArgs(["--url", "http://a.test", "--out"])).toEqual({ error: "--out needs a value" });
    expect(parseArgs(["--url", "http://a.test", "--nope"])).toEqual({ error: "unknown option --nope" });
  });
});

describe("page-shot findChrome", () => {
  const only = (...hits: string[]) => (p: string) => hits.includes(p);

  it("uses the --chrome path as given, and fails if it is not there", () => {
    expect(findChrome("darwin", only("/mine/chrome"), "/mine/chrome")).toBe("/mine/chrome");
    expect(findChrome("darwin", only(), "/mine/chrome")).toBe("");
  });

  it("finds Google Chrome, then Chromium, on macOS", () => {
    const g = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const c = "/Applications/Chromium.app/Contents/MacOS/Chromium";
    expect(findChrome("darwin", only(g, c), "")).toBe(g);
    expect(findChrome("darwin", only(c), "")).toBe(c);
  });

  it("looks through the usual Linux locations in order", () => {
    expect(findChrome("linux", only("/usr/bin/chromium", "/usr/bin/google-chrome"), "")).toBe("/usr/bin/google-chrome");
    expect(findChrome("linux", only("/usr/bin/chromium"), "")).toBe("/usr/bin/chromium");
  });

  it("returns an empty string when nothing is installed or the system is not supported", () => {
    expect(findChrome("linux", only(), "")).toBe("");
    expect(findChrome("win32", only("anything"), "")).toBe("");
  });
});

describe("page-shot pickPageSocket", () => {
  it("takes the new tab's debugger address", () => {
    expect(pickPageSocket({ webSocketDebuggerUrl: "ws://127.0.0.1:9/devtools/page/A" })).toBe("ws://127.0.0.1:9/devtools/page/A");
    expect(() => pickPageSocket({})).toThrow(/debugger address/);
  });
});

describe("page-shot launchChrome cleanup", () => {
  it("stops Chrome and removes the profile folder when Chrome never opens its debugging port", async () => {
    const before = profiles();
    const child = fakeChild();
    await expect(launchChrome("/fake/chrome", { spawn: () => child, startTimeoutMs: 80 })).rejects.toThrow(/did not open its debugging port/);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(profiles()).toEqual(before);
  });

  it("fails at once, and still cleans up, when Chrome exits on its own", async () => {
    const before = profiles();
    const child = fakeChild();
    const p = launchChrome("/fake/chrome", { spawn: () => { setTimeout(() => { child.exitCode = 1; child.emit("exit", 1); }, 10); return child; }, startTimeoutMs: 5000 });
    await expect(p).rejects.toThrow(/exited before/);
    expect(profiles()).toEqual(before);
  });

  it("reads the port from DevToolsActivePort, and stop() ends the process and deletes the profile", async () => {
    const before = profiles();
    const child = fakeChild();
    const { writeFileSync } = await import("node:fs");
    const chrome = await launchChrome("/fake/chrome", {
      spawn: (_bin: string, args: string[]) => {
        const dir = args.find((a) => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
        setTimeout(() => writeFileSync(join(dir, "DevToolsActivePort"), "43211\n/devtools/browser/x\n"), 20);
        return child;
      },
      startTimeoutMs: 5000,
    });
    expect(chrome.port).toBe(43211);
    expect(profiles()).toHaveLength(before.length + 1);
    await chrome.stop();
    await chrome.stop(); // a second stop is harmless
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(profiles()).toEqual(before);
  });

  it("kills a Chrome that ignores SIGTERM", async () => {
    const child = fakeChild({ exitOnSignal: false });
    await expect(launchChrome("/fake/chrome", { spawn: () => child, startTimeoutMs: 40, termGraceMs: 30 })).rejects.toThrow();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("passes headless, a private profile and an OS-chosen debugging port to Chrome", async () => {
    let seen: string[] = [];
    const child = fakeChild();
    await expect(launchChrome("/fake/chrome", { spawn: (_b: string, a: string[]) => ((seen = a), child), startTimeoutMs: 30 })).rejects.toThrow();
    expect(seen).toEqual(expect.arrayContaining(["--headless=new", "--remote-debugging-port=0", "--no-first-run"]));
    expect(seen.some((a) => a.startsWith("--user-data-dir=") && a.includes("page-shot-"))).toBe(true);
    expect(existsSync(seen.find((a) => a.startsWith("--user-data-dir="))!.slice(16))).toBe(false);
  });
});
