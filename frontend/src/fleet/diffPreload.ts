import { RespondError } from "./respondApi";
import type { ChangedFile, FileDiffReply } from "./types";

// Loads the diffs of an orchestrator's changed files ahead of the person opening them (#631, SPEC 6.4). It lives in the
// page's memory only: a disposed loader holds nothing and starts nothing, and nothing here is written to the browser's storage.
// Background loads run at most BACKGROUND_LIMIT at a time; a file the person opens jumps the queue and may take one more, so
// the server's four waiting requests per session are never reached by this loader alone.

export const BACKGROUND_LIMIT = 2;
export const PRIORITY_LIMIT = 3;
/** How long the queue holds still after the server says too many diffs are waiting. */
export const BUSY_PAUSE_MS = 3000;

export type DiffSlot =
  | { state: "queued" | "loading"; reply: FileDiffReply | null }
  | { state: "done"; reply: FileDiffReply; ahead: boolean }
  | { state: "failed"; reply: null; error: unknown };

interface Entry {
  /** What the file looked like in the Files report when its diff was asked for; a different one means it was edited again. */
  mark: string;
  slot: DiffSlot;
  /** Bumped when a new load starts, so an answer to an older one is dropped. */
  run: number;
}

/** The part of a Files row that changes when the file does. `rev` is the content hash, which moves when the counts do not. */
export const markOf = (f: ChangedFile): string => [f.status, f.added, f.removed, f.from, f.rev].join("\u0000");

export class DiffPreloader {
  private readonly entries = new Map<string, Entry>();
  private queue: string[] = [];
  private readonly priority = new Set<string>();
  private readonly flying = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private paused = false;
  private disposed = false;
  private hold: ReturnType<typeof setTimeout> | null = null;
  private version = 0;

  /** `ahead` is true for a load nobody asked for yet, which the server logs as a load and not as an open. */
  constructor(private readonly fetchDiff: (path: string, ahead: boolean) => Promise<FileDiffReply>) {}

  /** Brings the held diffs in line with the report: a new file is queued, an edited one reloaded in place, a file that left is dropped. */
  sync(files: readonly ChangedFile[]): void {
    if (this.disposed) return;
    const keep = new Set(files.map((f) => f.path));
    for (const path of [...this.entries.keys()]) {
      if (keep.has(path)) continue;
      this.entries.delete(path);
      this.flying.delete(path);
      this.priority.delete(path);
      this.queue = this.queue.filter((p) => p !== path);
    }
    for (const f of files) {
      const mark = markOf(f);
      const e = this.entries.get(f.path);
      if (!e) {
        this.entries.set(f.path, { mark, slot: { state: "queued", reply: null }, run: 0 });
        this.queue.push(f.path);
      } else if (e.mark !== mark) {
        e.mark = mark;
        // The old text stays on screen until the new one arrives.
        e.slot = { state: "queued", reply: e.slot.reply };
        if (!this.queue.includes(f.path) && !this.flying.has(f.path)) this.queue.push(f.path);
        else if (this.flying.has(f.path)) this.restart(f.path);
      }
    }
    this.changed();
    this.pump();
  }

  /** What is held for a file, or undefined when the file is not in the report. */
  get(path: string): DiffSlot | undefined {
    return this.entries.get(path)?.slot;
  }

  /** The person opened this file: move it to the front, and retry it if it had failed. */
  want(path: string): void {
    const e = this.entries.get(path);
    if (!e || this.disposed) return;
    this.priority.add(path);
    if (e.slot.state === "failed") e.slot = { state: "queued", reply: null };
    if (e.slot.state === "queued") {
      this.queue = [path, ...this.queue.filter((p) => p !== path)];
      this.changed();
    }
    this.pump();
  }

  /** The person left the file; it goes back to its place in the background. */
  release(path: string): void {
    this.priority.delete(path);
  }

  /** While the tab is hidden nothing new starts. */
  setPaused(on: boolean): void {
    if (this.disposed || this.paused === on) return;
    this.paused = on;
    this.pump();
  }

  /** Leaving the page: drop everything held and cancel what is queued. */
  dispose(): void {
    this.disposed = true;
    if (this.hold) clearTimeout(this.hold);
    this.hold = null;
    this.entries.clear();
    this.queue = [];
    this.flying.clear();
    this.priority.clear();
    this.listeners.clear();
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Changes on every update, for useSyncExternalStore. */
  snapshot = (): number => this.version;

  /** How many requests are in flight, for the tests. */
  get inFlight(): number {
    return this.flying.size;
  }

  private changed(): void {
    this.version++;
    for (const cb of [...this.listeners]) cb();
  }

  private restart(path: string): void {
    // The answer to the load already in flight is for the old content; it is dropped and the file asked for again.
    const e = this.entries.get(path);
    if (!e) return;
    e.run++;
    this.flying.delete(path);
    this.queue.unshift(path);
  }

  private pump(): void {
    if (this.disposed || this.paused) return;
    for (;;) {
      const next = this.queue[0];
      if (next === undefined) return;
      // The busy pause holds the background queue still, never a file the person has open.
      if (this.hold && !this.priority.has(next)) return;
      const limit = this.priority.has(next) ? PRIORITY_LIMIT : BACKGROUND_LIMIT;
      if (this.flying.size >= limit) return;
      this.queue.shift();
      this.start(next);
    }
  }

  private start(path: string): void {
    const e = this.entries.get(path);
    if (!e) return;
    const run = ++e.run;
    this.flying.add(path);
    e.slot = { state: "loading", reply: e.slot.reply };
    this.changed();
    const ahead = !this.priority.has(path);
    this.fetchDiff(path, ahead).then(
      (reply) => this.finish(path, run, { state: "done", reply, ahead }),
      (error: unknown) => this.finish(path, run, { state: "failed", reply: null, error }),
    );
  }

  private finish(path: string, run: number, slot: DiffSlot): void {
    const e = this.entries.get(path);
    if (!e || e.run !== run || this.disposed) return;
    this.flying.delete(path);
    const busy = slot.state === "failed" && slot.error instanceof RespondError && slot.error.status === 429;
    if (busy && !this.priority.has(path)) {
      // Too many waiting for this session: put it back at the front and hold still a moment. It is not a failure.
      e.slot = { state: "queued", reply: e.slot.reply };
      this.queue.unshift(path);
      this.hold = setTimeout(() => {
        this.hold = null;
        this.pump();
      }, BUSY_PAUSE_MS);
    } else {
      // A failed reload keeps nothing: the old text is for a file that has since changed.
      e.slot = slot;
    }
    this.changed();
    this.pump();
  }
}
