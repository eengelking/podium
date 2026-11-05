// The lock two sessions of one person take around a certificate renewal (#611, #616, #621, #948). The on-disk names (`<lock>.<n>`,
// `<lock>`, `<lock>.scheme`) and the scheme number are a protocol between processes, possibly of different versions: do not change them.
// Shared by every reporter that makes the mTLS connection (#927).
import { randomBytes, randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './atomic.mjs';

export const LOCK_STALE_MS = 60_000;
export const LOCK_WAIT_MS = 15_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when `file` exists and was last written more than `ms` ago. */
export function olderThan(file, ms) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs > ms;
  } catch {
    return false;
  }
}

/** The generations of a lock, `<lock>.<n>`, lowest first: `[{ gen, file }]`. */
export function generations(lockFile) {
  const dir = path.dirname(lockFile);
  const prefix = `${path.basename(lockFile)}.`;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // no folder, no lock
  }
  return names
    .filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)))
    .map((n) => ({ gen: Number(n.slice(prefix.length)), file: path.join(dir, n) }))
    .sort((x, y) => x.gen - y.gen);
}

/** The lock scheme this helper speaks. 1 was the plain `<lock>` file of the first renewal code; 2 adds the numbered files. */
export const LOCK_SCHEME = 2;

/**
 * Records the scheme in `<lock>.scheme` and refuses a lock that a newer helper has written a higher number to, because this
 * helper would not know how to exclude it. A missing, older or unreadable marker is raised to this helper's scheme.
 */
export function checkScheme(lockFile) {
  const marker = `${lockFile}.scheme`;
  let seen = Number.NaN;
  try {
    seen = Number.parseInt(fs.readFileSync(marker, 'utf8'), 10);
  } catch {
    // no marker yet
  }
  if (seen > LOCK_SCHEME) {
    throw Object.assign(new Error(`${marker} says lock scheme ${seen}, newer than the ${LOCK_SCHEME} this helper knows; update podium-reporter`), { code: 'LOCK_SCHEME' });
  }
  if (seen !== LOCK_SCHEME) writeAtomic(marker, `${LOCK_SCHEME}\n`);
}

/**
 * Runs `fn` while holding the lock `<lockFile>`. It is two locks, taken in this order.
 *
 * First a numbered file, `<lockFile>.<n>`, made with O_EXCL and naming its owner. The lock is held by the highest number and is
 * free when there is none or the highest is older than `staleMs` (its owner died, or it let go: letting go ages the file instead of
 * removing it). To take it, a waiter creates the next number. Of several waiters that want the same number exactly one creates
 * it and the rest see it exist, so taking a stale lock needs no removal that two waiters could race on, and a waiter never removes
 * a lock another has just made. A number is never used twice, so a waiter working from an old reading cannot be handed a number
 * that has since been held and released. Numbers below the one taken are leftovers and are removed.
 *
 * Then, while holding that, the plain file `<lockFile>` itself, with O_EXCL, which is what the first renewal code (lock scheme 1)
 * took. Taking it keeps a session on that older code out while this one works, and waits for one that holds it. Only the holder of
 * the numbered lock ever removes a stale plain lock, so this helper's sessions do not race on it; the one race left is with an
 * older helper clearing the same stale file, which only that older code can close.
 *
 * While `fn` runs both files' times are refreshed every third of `staleMs`, so a live holder is not taken over however long it
 * takes. Returns null when the lock could not be had in `waitMs`, and throws (code LOCK_SCHEME) for a scheme this helper does not know.
 */
export async function withLock(lockFile, fn, waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS) {
  checkScheme(lockFile);
  const until = Date.now() + waitMs;
  const owner = `${process.pid}:${randomBytes(8).toString('hex')}`;
  let mine = null;
  for (;;) {
    const all = generations(lockFile);
    const top = all.at(-1);
    if (!top || olderThan(top.file, staleMs)) {
      const file = `${lockFile}.${(top?.gen ?? 0) + 1}`;
      try {
        const fd = fs.openSync(file, 'wx', 0o600);
        fs.writeSync(fd, owner);
        fs.closeSync(fd);
        mine = file;
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        continue; // another waiter took this number: look again
      }
    }
    if (Date.now() > until) return null;
    await sleep(randomInt(50, 100));
  }
  for (const g of generations(lockFile)) {
    if (g.file === mine || g.gen > Number(mine.slice(mine.lastIndexOf('.') + 1))) continue;
    try {
      fs.rmSync(g.file, { force: true });
    } catch {
      // a leftover we cannot remove is stale; the next taker tries again
    }
  }
  const ours = (file) => {
    try {
      return fs.readFileSync(file, 'utf8') === owner;
    } catch {
      return false;
    }
  };
  const held = [mine];
  const beat = setInterval(() => {
    for (const f of held) {
      try {
        if (ours(f)) fs.utimesSync(f, new Date(), new Date());
      } catch {
        // gone: nothing of ours to keep fresh
      }
    }
  }, Math.max(10, staleMs / 3));
  const letGo = () => {
    clearInterval(beat);
    try {
      if (ours(mine)) fs.utimesSync(mine, new Date(0), new Date(0));
    } catch {
      // gone already
    }
    try {
      if (held.includes(lockFile) && ours(lockFile)) fs.rmSync(lockFile, { force: true });
    } catch {
      // gone already; a plain lock we cannot remove goes stale
    }
  };
  try {
    for (;;) {
      try {
        const fd = fs.openSync(lockFile, 'wx', 0o600);
        fs.writeSync(fd, owner);
        fs.closeSync(fd);
        held.push(lockFile);
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        // Ours alone to clear: no other session of this kind holds the numbered lock.
        if (olderThan(lockFile, staleMs)) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
        if (Date.now() > until) return null; // the finally lets go of the numbered lock
        await sleep(randomInt(50, 100));
      }
    }
    return { value: await fn() };
  } finally {
    letGo();
  }
}
