#!/usr/bin/env node
// Loads a page at a set width in headless Chrome and saves a screenshot, for checking a UI change at 400 px in the real
// app (#475). It starts its own Chrome with a throwaway profile, drives it over the DevTools protocol with Node's
// built-in WebSocket, and always stops Chrome and deletes the profile, also when the page fails to load. It does not wait
// for the network to go idle, so a page that keeps an event stream open (Podium's /api/fleet/stream) is fine, which
// `chrome --headless --screenshot` is not. No dependencies.
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const USAGE = `Usage: node scripts/page-shot.mjs --url <address> [--width 400] [--height 900] [--wait 1000]
                               [--eval <javascript>] [--out <file.png>] [--chrome <path>]

Loads <address> at --width by --height in headless Chrome, waits --wait ms after the page loads, optionally runs
--eval in the page and prints its result as JSON, and saves a full-page PNG (default: page-shot-<width>.png in the
temp folder; the path is printed). Chrome runs with a throwaway profile and is always stopped afterwards.

  --url     the page to load, such as 'http://127.0.0.1:4391/#/me/reporters' (required; there is no default, so it
            never lands on a server you use by accident)
  --width   viewport width in px (default 400)
  --height  viewport height in px (default 900)
  --wait    ms to wait after the load event, for the page to draw (default 1000)
  --eval    JavaScript to run once the page has settled, a promise is awaited; the value must be JSON-able.
            Use it to open panels, sign in with test values, or report where elements sit
  --out     where to save the PNG
  --chrome  Chrome's path (default: Google Chrome or Chromium on macOS, google-chrome or chromium on Linux)
  -h        show this help

Needs Node 22 or later (built-in WebSocket). Run it against a throwaway server, not your own.`;

const MAC = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
const LINUX = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];

const FLAGS = { "--url": "url", "--width": "width", "--height": "height", "--wait": "wait", "--eval": "evalJs", "--out": "out", "--chrome": "chrome" };

/** The options, `{ help: true }`, or `{ error }` naming what to fix. */
export function parseArgs(argv) {
  if (argv.includes("-h") || argv.includes("--help")) return { help: true };
  const o = { url: "", width: 400, height: 900, wait: 1000, evalJs: "", out: "", chrome: "" };
  for (let i = 0; i < argv.length; i++) {
    const key = FLAGS[argv[i]];
    if (!key) return { error: `unknown option ${argv[i]}` };
    const value = argv[++i];
    if (value === undefined) return { error: `${argv[i - 1]} needs a value` };
    o[key] = value;
  }
  if (!o.url) return { error: "--url is required (there is no default server)" };
  try {
    if (!/^https?:$/.test(new URL(o.url).protocol)) throw new Error("scheme");
  } catch {
    return { error: "--url must be an http or https address" };
  }
  for (const k of ["width", "height"]) {
    o[k] = typeof o[k] === "string" ? (/^\d+$/.test(o[k]) ? Number(o[k]) : 0) : o[k];
    if (o[k] < 1) return { error: `--${k} must be a whole number above 0` };
  }
  if (typeof o.wait === "string") o.wait = /^\d+$/.test(o.wait) ? Number(o.wait) : -1;
  if (o.wait < 0) return { error: "--wait must be a whole number of milliseconds, 0 or more" };
  o.out ||= join(tmpdir(), `page-shot-${o.width}.png`);
  return o;
}

/** Chrome's path: the override if it exists, else the first usual install for the platform; "" if there is none. */
export function findChrome(platform, exists, override) {
  if (override) return exists(override) ? override : "";
  const candidates = platform === "darwin" ? MAC : platform === "linux" ? LINUX : [];
  return candidates.find((p) => exists(p)) ?? "";
}

/** The DevTools address of a tab from `/json/new`. */
export function pickPageSocket(target) {
  if (!target?.webSocketDebuggerUrl) throw new Error("Chrome gave no debugger address for the new tab");
  return target.webSocketDebuggerUrl;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts headless Chrome on a debugging port the OS picks, with a profile folder made for this run. Resolves with the
 * port and a `stop()` that ends the process (SIGTERM, then SIGKILL after `termGraceMs`) and deletes the profile. When
 * Chrome does not come up it does the same before rejecting, so nothing is left behind either way.
 * @param {string} chromePath
 * @param {{ spawn?: (bin: string, args: string[], opts: object) => any, startTimeoutMs?: number, termGraceMs?: number }} [deps]
 */
export async function launchChrome(chromePath, { spawn = nodeSpawn, startTimeoutMs = 15000, termGraceMs = 3000 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "page-shot-"));
  const child = spawn(
    chromePath,
    [`--user-data-dir=${profile}`, "--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "about:blank"],
    { stdio: "ignore" },
  );
  let exited = false;
  child.on("exit", () => (exited = true));
  child.on("error", () => (exited = true));

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (!exited) {
      const gone = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await Promise.race([gone, sleep(termGraceMs)]);
      if (!exited) child.kill("SIGKILL");
    }
    rmSync(profile, { recursive: true, force: true });
  };

  try {
    const file = join(profile, "DevToolsActivePort");
    const deadline = Date.now() + startTimeoutMs;
    for (;;) {
      if (exited) throw new Error("Chrome exited before it opened its debugging port");
      if (existsSync(file)) {
        const port = Number(readFileSync(file, "utf8").split("\n")[0]);
        if (port > 0) return { port, stop };
      }
      if (Date.now() > deadline) throw new Error("Chrome did not open its debugging port in time");
      await sleep(25);
    }
  } catch (err) {
    await stop();
    throw err;
  }
}

/** A small DevTools protocol client over one tab's WebSocket. */
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) {
        const { ok, fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new Error(`${msg.error.message}`));
        else ok(msg.result);
      } else if (msg.method) listeners.get(msg.method)?.forEach((fn) => fn(msg.params));
    });
    ws.addEventListener("error", () => reject(new Error("could not connect to Chrome's DevTools")));
    // Chrome closing the tab or crashing mid-run must fail the waiting calls, not leave them pending forever (an unsettled
    // top-level await ends the process without running `finally`, which would leak the profile folder).
    ws.addEventListener("close", () => {
      for (const { fail } of pending.values()) fail(new Error("Chrome closed the DevTools connection"));
      pending.clear();
    });
    ws.addEventListener("open", () =>
      resolve({
        send: (method, params = {}) => new Promise((ok, fail) => (pending.set(++id, { ok, fail }), ws.send(JSON.stringify({ id, method, params })))),
        once: (method) => new Promise((r) => listeners.set(method, [...(listeners.get(method) ?? []), r])),
        close: () => ws.close(),
      }),
    );
  });
}

/** Loads the page in a new tab, runs `evalJs` if given, and returns `{ png, value }`. */
async function shoot(port, o) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const cdp = await connect(pickPageSocket(target));
  try {
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: o.width, height: o.height, deviceScaleFactor: 1, mobile: false });
    const loaded = cdp.once("Page.loadEventFired");
    const nav = await cdp.send("Page.navigate", { url: o.url });
    if (nav.errorText) throw new Error(`could not load ${o.url}: ${nav.errorText}`);
    let giveUp;
    const timedOut = new Promise((_ok, fail) => (giveUp = setTimeout(() => fail(new Error(`${o.url} did not finish loading in 30 s`)), 30000)));
    try {
      await Promise.race([loaded, timedOut]);
    } finally {
      clearTimeout(giveUp); // a timer left armed would hold the process open for the full 30 s
    }
    await sleep(o.wait);
    let value;
    if (o.evalJs) {
      const r = await cdp.send("Runtime.evaluate", { expression: o.evalJs, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`--eval threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      value = r.result.value;
      await sleep(Math.min(o.wait, 500)); // let what the snippet opened draw
    }
    const { cssContentSize } = await cdp.send("Page.getLayoutMetrics");
    const height = Math.max(o.height, Math.ceil(cssContentSize.height));
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: o.width, height, scale: 1 } });
    return { png: Buffer.from(shot.data, "base64"), value };
  } finally {
    cdp.close();
  }
}

/** The whole run: start Chrome, take the shot, write the file; Chrome and its profile are gone afterwards. */
export async function run(o, chromePath) {
  const chrome = await launchChrome(chromePath);
  // Ctrl-C or a kill must not leave Chrome running and its profile on disk.
  const onSignal = (sig) => chrome.stop().finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const { png, value } = await shoot(chrome.port, o);
    writeFileSync(o.out, png);
    return { out: o.out, value };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await chrome.stop();
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) return console.log(USAGE);
  if (o.error) {
    console.error(`${o.error}\n\n${USAGE}`);
    process.exit(2);
  }
  const chromePath = findChrome(process.platform, existsSync, o.chrome);
  if (!chromePath) {
    console.error(o.chrome ? `Chrome not found at ${o.chrome}` : "No Chrome or Chromium found; pass its path with --chrome");
    process.exit(1);
  }
  try {
    const { out, value } = await run(o, chromePath);
    if (o.evalJs) console.log(JSON.stringify(value ?? null, null, 2));
    console.log(`saved ${out} (${o.width} px wide)`);
  } catch (err) {
    console.error(`page-shot: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
