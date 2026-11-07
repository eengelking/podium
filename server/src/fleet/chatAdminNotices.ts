// What an Admin's reading or stopping of a person's conversation tells that person's own reporter sessions (#1034, PROJECT.md "An Admin Never Reads in Silence").
// A notice is one content-free sentence: who, what they did and which conversation, never any message text. It is held in memory, handed to a session in
// the reply to its reports for a few minutes (the reporter shows each id once), and goes to the person only: a reporter never submits it to the model.
// Only an Admin's stops are held here. A reading is not: it is derived from the reading's record (chat_admin_reads) each time a session reports, so a
// restart, a session that started late, or a run of stops can never lose it (#1051).
export interface AdminNotice {
  id: string;
  at: number;
  text: string;
}

/** A notice is handed over in every reply for this long, so one lost reply does not lose it. */
export const NOTICE_TTL_MS = 5 * 60_000;
/** A session keeps at most this many notices at once; the oldest go first. */
const MAX_PER_SESSION = 8;
const TEXT_MAX = 300;

export class AdminNotices {
  private readonly bySession = new Map<string, AdminNotice[]>();
  private seq = 0;

  constructor(private readonly now: () => number) {}

  /** Holds a notice for a session. The same words said again replace the earlier notice, so a run of one Admin's repeats cannot push other notices out. */
  push(sessionId: string, text: string): void {
    const at = this.now();
    this.prune(at);
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
    const list = (this.bySession.get(sessionId) ?? []).filter((n) => n.text !== clean);
    list.push({ id: `${at.toString(36)}-${(this.seq++).toString(36)}`, at, text: clean });
    this.bySession.set(sessionId, list.slice(-MAX_PER_SESSION));
  }

  /** The notices a session's next reply carries, oldest first. */
  for(sessionId: string): AdminNotice[] {
    this.prune(this.now());
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  private prune(at: number): void {
    for (const [id, list] of this.bySession) {
      const keep = list.filter((n) => at - n.at < NOTICE_TTL_MS);
      if (keep.length) this.bySession.set(id, keep);
      else this.bySession.delete(id);
    }
  }
}
