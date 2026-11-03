// lock.mjs: the renewal lock two sessions of one person take (#611, #616, #621, #948). Real temp folders and real child processes.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "claude-code/testing";
import { LOCK_SCHEME, LOCK_STALE_MS, LOCK_WAIT_MS, checkScheme, generations, olderThan, withLock } from "./lock.mjs";

const LOCK_MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), "lock.mjs");

const made: string[] = [];
process.on("exit", () => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "podium-lock-"));
  made.push(d);
  return d;
};
/** The tests that start many child processes, over several rounds. */
const LONG = { timeoutMs: 120_000, timeout: 120_000 } as { timeoutMs: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until `f` is true, polling; fails with `what` after `ms`. */
async function until(f: () => boolean, what: string, ms = 8000): Promise<void> {
  for (let t = 0; t < ms && !f(); t += 25) await sleep(25);
  expect(f(), what).toBe(true);
}

// Every child waits for `go`, then takes the lock and spends 80 ms inside it; a second one inside at the same time is a violation.
const CHILD = `
  import fs from 'node:fs';
  const [helper, lock, marker, go] = process.argv.slice(1);
  const { withLock } = await import(helper);
  fs.writeFileSync(go + '.ready-' + process.pid, '');
  while (!fs.existsSync(go)) await new Promise((r) => setTimeout(r, 1));
  const got = await withLock(lock, async () => {
    try { fs.closeSync(fs.openSync(marker, 'wx')); } catch { return 'violation'; }
    await new Promise((r) => setTimeout(r, 80));
    fs.rmSync(marker, { force: true });
    return 'ok';
  });
  process.stdout.write(got === null ? 'timeout' : got.value);
`;

const stale = (file: string, content = "dead-owner") => {
  fs.writeFileSync(file, content);
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(file, old, old);
};
const files = (dir: string) => fs.readdirSync(dir).filter((n) => !n.endsWith(".scheme")).sort();

// A helper of the T7 kind: the plain `<lock>` file with O_EXCL, a stale one removed by its age, nothing else.
const OLD_CHILD = `
  import fs from 'node:fs';
  const [lock, marker, go] = process.argv.slice(1);
  fs.writeFileSync(go + '.ready-' + process.pid, '');
  while (!fs.existsSync(go)) await new Promise((r) => setTimeout(r, 1));
  let out = 'timeout';
  for (let i = 0; i < 600; i++) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600); fs.writeSync(fd, 'old:' + process.pid); fs.closeSync(fd);
    } catch (e) { await new Promise((r) => setTimeout(r, 20)); continue; }
    try { fs.closeSync(fs.openSync(marker, 'wx')); } catch { out = 'violation'; fs.rmSync(lock, { force: true }); break; }
    await new Promise((r) => setTimeout(r, 80));
    fs.rmSync(marker, { force: true });
    fs.rmSync(lock, { force: true });
    out = 'ok';
    break;
  }
  process.stdout.write(out);
`;

async function contend(startWith: (lock: string) => void, kids: number, rounds: number, oldKids = 0): Promise<string[]> {
  const results: string[] = [];
  for (let round = 0; round < rounds; round++) {
    const dir = tmp();
    const lock = path.join(dir, "c.pem.lock");
    const go = path.join(dir, "go");
    startWith(lock);
    const procs = Array.from({ length: kids + oldKids }, (_, i) => {
      const args = i < kids ? [CHILD, pathToFileURL(LOCK_MODULE).href, lock, path.join(dir, "inside"), go] : [OLD_CHILD, lock, path.join(dir, "inside"), go];
      const proc = spawn(process.execPath, ["--input-type=module", "-e", ...args], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      proc.stdout.on("data", (c) => (out += c));
      return new Promise<string>((resolve) => proc.on("exit", () => resolve(out || "crashed")));
    });
    await until(() => fs.readdirSync(dir).filter((n) => n.startsWith("go.ready-")).length === kids + oldKids, "every child is ready", 15_000);
    fs.writeFileSync(go, "");
    results.push(...(await Promise.all(procs)));
    // the lock is let go by aging its file, so one file is left, and it is stale
    const left = files(dir).filter((n) => /\.lock\.\d+$/.test(n));
    expect(files(dir).filter((n) => n.endsWith(".lock"))).toEqual([]);
    expect(left.length).toBeLessThanOrEqual(1);
    if (!left.length) continue;
    expect(Date.now() - fs.statSync(path.join(dir, left[0]!)).mtimeMs).toBeGreaterThan(60_000);
  }
  return results;
}

/** Runs `body` with fs.statSync replaced by `wrap(real)`, and puts the real one back. */
async function withStatSync(wrap: (real: typeof fs.statSync) => typeof fs.statSync, body: () => Promise<void>): Promise<void> {
  const real = fs.statSync;
  fs.statSync = wrap(real);
  try {
    await body();
  } finally {
    fs.statSync = real;
  }
}

describe("lock.mjs: withLock (#611, #616)", () => {
  test("the numbers on disk and the constants are the protocol, and do not change", () => {
    expect(LOCK_SCHEME).toBe(2);
    expect(LOCK_STALE_MS).toBe(60_000);
    expect(LOCK_WAIT_MS).toBe(15_000);
  });

  test("lets one waiter in at a time when many find the same stale lock together", LONG, async () => {
    expect(await contend((lock) => stale(`${lock}.3`), 8, 6)).toEqual(Array(48).fill("ok"));
  });

  test("lets one waiter in at a time when many find no lock at all", LONG, async () => {
    expect(await contend(() => {}, 8, 6)).toEqual(Array(48).fill("ok"));
  });

  test("takes the next number over a stale lock and removes the dead owner's file", async () => {
    const dir = tmp();
    const lock = path.join(dir, "c.pem.lock");
    stale(`${lock}.2`);
    stale(`${lock}.5`);
    let during: string[] = [];
    const got = await withLock(lock, async () => {
      during = files(dir);
      return "in";
    });
    expect(got).toEqual({ value: "in" });
    expect(during).toEqual(["c.pem.lock", "c.pem.lock.6"]);
    expect(files(dir)).toEqual(["c.pem.lock.6"]);
  });

  test("never gives out a number twice: a waiter working from an old reading cannot be handed one that was held and released since", async () => {
    const dir = tmp();
    const lock = path.join(dir, "c.pem.lock");
    stale(`${lock}.1`);
    // This waiter reads generation 1 as stale. Before it acts, another holder takes generation 2, finishes and lets go (an aged file).
    let swapped = false;
    let during: string[] = [];
    let got: { value: string } | null = null;
    await withStatSync(
      (real) =>
        ((...a: Parameters<typeof fs.statSync>) => {
          const st = real(...a);
          if (!swapped && String(a[0]) === `${lock}.1`) {
            swapped = true;
            fs.rmSync(`${lock}.1`);
            stale(`${lock}.2`, "finished-owner");
          }
          return st;
        }) as typeof fs.statSync,
      async () => {
        got = await withLock(lock, async () => {
          during = files(dir);
          return "in";
        });
      },
    );
    expect(swapped).toBe(true);
    expect(got).toEqual({ value: "in" });
    expect(during).toEqual(["c.pem.lock", "c.pem.lock.3"]);
  });

  test("numbers climb with each taking, and only the newest file is kept", async () => {
    const dir = tmp();
    const lock = path.join(dir, "c.pem.lock");
    for (const n of [1, 2, 3]) {
      await withLock(lock, async () => "in");
      expect(files(dir)).toEqual([`c.pem.lock.${n}`]);
    }
  });

  test("leaves alone a lock another waiter made over the stale one, between this waiter reading it and acting", async () => {
    const dir = tmp();
    const lock = path.join(dir, "c.pem.lock");
    stale(`${lock}.1`);
    // This waiter reads generation 1 as stale; before it acts, another takes it over, so generation 2 exists and is fresh.
    let swapped = false;
    let ran = false;
    let got: { value: unknown } | null = { value: 0 };
    await withStatSync(
      (real) =>
        ((...a: Parameters<typeof fs.statSync>) => {
          const st = real(...a);
          if (!swapped && String(a[0]) === `${lock}.1`) {
            swapped = true;
            fs.writeFileSync(`${lock}.2`, "fresh-owner");
          }
          return st;
        }) as typeof fs.statSync,
      async () => {
        got = await withLock(lock, async () => void (ran = true), 400);
      },
    );
    expect(swapped).toBe(true);
    expect(ran).toBe(false);
    expect(got).toBeNull();
    expect(fs.readFileSync(`${lock}.2`, "utf8")).toBe("fresh-owner");
  });

  test("takes over a stale plain lock an older helper left, and never touches its .takeover marker", async () => {
    const dir = tmp();
    const lock = path.join(dir, "c.pem.lock");
    stale(lock, "old-plain-lock");
    stale(`${lock}.takeover`, "old-marker");
    let during = "";
    const got = await withLock(
      lock,
      async () => {
        during = fs.readFileSync(lock, "utf8");
        return "in";
      },
      2000,
    );
    expect(got).toEqual({ value: "in" });
    expect(during).not.toBe("old-plain-lock");
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.readFileSync(`${lock}.takeover`, "utf8")).toBe("old-marker");
  });

  describe("across lock schemes (#621)", () => {
    test("waits for a live plain lock held by an older helper, and does not run", async () => {
      const dir = tmp();
      const lock = path.join(dir, "c.pem.lock");
      fs.writeFileSync(lock, "old:1234");
      let ran = false;
      const got = await withLock(lock, async () => void (ran = true), 400);
      expect(got).toBeNull();
      expect(ran).toBe(false);
      expect(fs.readFileSync(lock, "utf8")).toBe("old:1234");
    });

    test("goes ahead when the older helper lets go of its plain lock", async () => {
      const lock = path.join(tmp(), "c.pem.lock");
      fs.writeFileSync(lock, "old:1234");
      setTimeout(() => fs.rmSync(lock), 200);
      const got = await withLock(lock, async () => "in", 3000);
      expect(got).toEqual({ value: "in" });
    });

    test("holds the plain lock while it works, so an older helper's O_EXCL fails, and lets go of it after", async () => {
      const lock = path.join(tmp(), "c.pem.lock");
      let oldTakes = "";
      await withLock(lock, async () => {
        try {
          fs.closeSync(fs.openSync(lock, "wx"));
          oldTakes = "took it";
        } catch (err) {
          oldTakes = (err as NodeJS.ErrnoException).code ?? "";
        }
        return "in";
      });
      expect(oldTakes).toBe("EEXIST");
      expect(fs.existsSync(lock)).toBe(false);
    });

    test("refreshes the plain lock too while it works, so an older helper does not take it for dead", async () => {
      const lock = path.join(tmp(), "c.pem.lock");
      let age = Number.POSITIVE_INFINITY;
      await withLock(
        lock,
        async () => {
          await sleep(700);
          age = Date.now() - fs.statSync(lock).mtimeMs;
          return "in";
        },
        3000,
        300,
      );
      expect(age).toBeLessThan(250);
    });

    test("lets one in at a time when helpers of both kinds start together on no lock", LONG, async () => {
      expect(await contend(() => {}, 4, 6, 4)).toEqual(Array(48).fill("ok"));
    });

    test("lets one in at a time when helpers of both kinds start together on a stale plain lock", LONG, async () => {
      // the older helpers cannot clear it (they only wait), so only the newer ones get in; they must not run together
      const results = await contend((lock) => stale(lock, "dead-old"), 6, 4, 0);
      expect(results).toEqual(Array(24).fill("ok"));
    });

    describe("the scheme marker", () => {
      test("is written as 2 when absent, and raised from 1", async () => {
        const dir = tmp();
        const lock = path.join(dir, "c.pem.lock");
        await withLock(lock, async () => "in");
        expect(fs.readFileSync(`${lock}.scheme`, "utf8").trim()).toBe("2");
        fs.writeFileSync(`${lock}.scheme`, "1\n");
        await withLock(lock, async () => "in");
        expect(fs.readFileSync(`${lock}.scheme`, "utf8").trim()).toBe("2");
        fs.writeFileSync(`${lock}.scheme`, "garbage");
        await withLock(lock, async () => "in");
        expect(fs.readFileSync(`${lock}.scheme`, "utf8").trim()).toBe("2");
      });

      test("makes a helper that does not know the scheme refuse, with a code, and take no lock", async () => {
        const dir = tmp();
        const lock = path.join(dir, "c.pem.lock");
        fs.writeFileSync(`${lock}.scheme`, "3\n");
        let ran = false;
        await expect(withLock(lock, async () => void (ran = true))).rejects.toMatchObject({ code: "LOCK_SCHEME", message: expect.stringMatching(/newer|scheme 3/) });
        expect(ran).toBe(false);
        expect(fs.readdirSync(dir)).toEqual(["c.pem.lock.scheme"]);
        expect(fs.readFileSync(`${lock}.scheme`, "utf8").trim()).toBe("3");
      });

      test("checkScheme alone writes the marker, and leaves a current one untouched", () => {
        const lock = path.join(tmp(), "c.pem.lock");
        checkScheme(lock);
        expect(fs.readFileSync(`${lock}.scheme`, "utf8")).toBe("2\n");
        const before = fs.statSync(`${lock}.scheme`).mtimeMs;
        checkScheme(lock);
        expect(fs.statSync(`${lock}.scheme`).mtimeMs).toBe(before);
      });
    });
  });

  test("never takes a lock from a holder that is still running, however long it takes", async () => {
    const lock = path.join(tmp(), "c.pem.lock");
    // the lock goes stale after 300 ms without a refresh; the holder works for 1.2 s
    const holder = withLock(
      lock,
      async () => {
        await sleep(1200);
        return "held";
      },
      5000,
      300,
    );
    await sleep(100);
    const waiter = await withLock(lock, async () => "stolen", 900, 300);
    expect(waiter).toBeNull();
    expect(await holder).toEqual({ value: "held" });
    expect(files(path.dirname(lock))).toEqual(["c.pem.lock.1"]);
  });

  test("a holder that was taken over, or whose file was swept, removes only its own file when it finishes", async () => {
    const dir = tmp();
    const lock = path.join(dir, "c.pem.lock");
    await withLock(lock, async () => {
      // its own file is swept and a successor already holds the next number
      fs.rmSync(`${lock}.1`);
      fs.writeFileSync(`${lock}.2`, "successor");
      return "done";
    });
    expect(files(dir)).toEqual(["c.pem.lock.2"]);
    expect(fs.readFileSync(`${lock}.2`, "utf8")).toBe("successor");
  });

  test("does not start without a folder to put the lock in", async () => {
    await expect(withLock(path.join(tmp(), "missing", "c.pem.lock"), async () => "in", 100)).rejects.toThrow(/ENOENT/);
  });
});

describe("lock.mjs: the small parts", () => {
  test("olderThan is false for a file that is not there, and compares the age with the limit", () => {
    const dir = tmp();
    expect(olderThan(path.join(dir, "gone"), 0)).toBe(false);
    const f = path.join(dir, "f");
    fs.writeFileSync(f, "");
    expect(olderThan(f, 60_000)).toBe(false);
    stale(f);
    expect(olderThan(f, 60_000)).toBe(true);
  });

  test("generations lists only <lock>.<number>, lowest first, and nothing for a missing folder", () => {
    const dir = tmp();
    const lock = path.join(dir, "c.pem.lock");
    for (const n of ["c.pem.lock.10", "c.pem.lock.2", "c.pem.lock.scheme", "c.pem.lock", "c.pem.lock.3x", "other.1"]) fs.writeFileSync(path.join(dir, n), "");
    expect(generations(lock)).toEqual([
      { gen: 2, file: path.join(dir, "c.pem.lock.2") },
      { gen: 10, file: path.join(dir, "c.pem.lock.10") },
    ]);
    expect(generations(path.join(dir, "missing", "c.pem.lock"))).toEqual([]);
  });
});
