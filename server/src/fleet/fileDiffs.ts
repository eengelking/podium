// A file's diff on demand (#319, SPEC 6.4), held in memory only. Nothing here is written to the database, the state,
// the stream or a log. The owner's browser asks; the server lists the request in the next reply to the session's mod
// (`diffs`); the mod answers with PUT …/diffs/:requestId; the server hands that answer to the one waiting request and
// forgets it. A request the mod has not answered in FILE_DIFF_LIMITS.holdSeconds is dropped.
import { randomBytes } from 'node:crypto';
import { FILE_DIFF_LIMITS, type DiffRequest, type FileDiffReply } from './protocol.js';

interface Pending extends DiffRequest {
  sessionId: string;
  settle: (r: FileDiffReply | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DiffBroker {
  private readonly pending = new Map<string, Pending>();
  /** Session id -> whether its reporter has the fileDiff option on, from the last report that said. */
  private readonly option = new Map<string, boolean>();

  /** How many requests are waiting. */
  get size(): number {
    return this.pending.size;
  }

  /** Asks for one file's diff. Resolves with the mod's answer, null when none came in time, or 'busy' past four waiting for a session. */
  ask(sessionId: string, path: string): Promise<FileDiffReply | null | 'busy'> {
    if (this.listFor(sessionId).length >= FILE_DIFF_LIMITS.pending) return Promise.resolve('busy');
    const id = randomBytes(12).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(id, null), FILE_DIFF_LIMITS.holdSeconds * 1000);
      timer.unref?.();
      this.pending.set(id, { id, path, sessionId, settle: resolve, timer });
    });
  }

  /** The requests the mod has not answered yet, oldest first, at most four: the reply's `diffs`. */
  listFor(sessionId: string): DiffRequest[] {
    const out: DiffRequest[] = [];
    for (const p of this.pending.values()) {
      if (p.sessionId === sessionId && out.length < FILE_DIFF_LIMITS.pending) out.push({ id: p.id, path: p.path });
    }
    return out;
  }

  /** Hands the mod's answer to the waiting request. False when the request is not held for that session (late, repeated or foreign). */
  answer(sessionId: string, requestId: string, reply: FileDiffReply): boolean {
    const p = this.pending.get(requestId);
    if (!p || p.sessionId !== sessionId) return false;
    this.settle(requestId, reply);
    return true;
  }

  private settle(id: string, reply: FileDiffReply | null): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.settle(reply);
  }

  noteOption(sessionId: string, on: boolean): void {
    this.option.set(sessionId, on);
  }

  /** The reporter's fileDiff option from its last report; null when it never said (older reporter, or since a restart). */
  optionOn(sessionId: string): boolean | null {
    return this.option.get(sessionId) ?? null;
  }

  /** The session left the live set or was deleted: its waiting requests end with nothing. */
  drop(sessionId: string): void {
    for (const p of [...this.pending.values()]) if (p.sessionId === sessionId) this.settle(p.id, null);
    this.option.delete(sessionId);
  }

  /** The Admin turned the feature off. */
  clear(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, null);
  }
}
