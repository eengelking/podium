// An Admin stopping or deleting something of a person's (a recording, stored activity, a session, their token, a reporter) tells that person (#1078,
// PROJECT.md "An Admin Never Reads in Silence"). Two places, both content-free: a record on the person's `act:` thread, shown on their Chat overview
// until they have seen it, and a callout in each of their live reporter sessions (the report reply carries it, to the person only, never to the model).
// The act is recorded first, so a failure to record stops the act and none goes unrecorded.
import type { AdminReadKind } from '../storage/types.js';
import { nameKey } from '../storage/rows.js';

/** The kinds of an Admin's act on a person's things. */
export type AdminActKind = Extract<AdminReadKind, 'recording_stopped' | 'recording_deleted' | 'activity_deleted' | 'session_deleted' | 'access_revoked' | 'person_deleted' | 'reporter_removed'>;

/** Every thread of these records starts with this. */
export const ACT_PREFIX = 'act:';
/** The thread a person's records of these acts are kept under. */
export const actThread = (owner: string): string => `${ACT_PREFIX}${nameKey(owner)}`;

export interface ActDeps {
  mark(thread: string, admin: string, kind: AdminActKind, people: string[]): Promise<unknown>;
  tell(sessionId: string, text: string): void;
  sessionsOf(owner: string): string[];
  sessionOf(sessionId: string): Promise<{ name: string; owner: string | null } | null>;
}

/** What the callout says after the Admin's name. `what` is the session's name, or for a reporter the words that name it (`your reporter ed-mbp`, `3 of your reporters`). */
const WORDS: Record<AdminActKind, (what: string) => string> = {
  recording_stopped: (n) => `stopped the recording of your session ${n}`,
  recording_deleted: (n) => `deleted the recording of your session ${n}`,
  activity_deleted: (n) => `deleted the stored activity of your session ${n}`,
  session_deleted: (n) => `deleted your session ${n}`,
  access_revoked: () => 'revoked your Podium access',
  person_deleted: () => 'deleted your Podium account',
  reporter_removed: (what) => `removed ${what || 'your reporter'} from the Reporters list`,
};

export class AdminActs {
  constructor(private readonly deps: ActDeps) {}

  /** `admin` did `kind` to a session. Tells the session's owner; nothing for a session with no owner or one that is gone, or the Admin's own. */
  async onSession(admin: string, kind: AdminActKind, sessionId: string): Promise<void> {
    const s = await this.deps.sessionOf(sessionId);
    if (!s?.owner) return;
    await this.told(admin, kind, s.owner, s.name);
  }

  /** `admin` did `kind` to something of `owner`'s that is not a session: their access, their account, a reporter (`what`). */
  onPerson(admin: string, kind: AdminActKind, owner: string, what = ''): Promise<void> {
    return this.told(admin, kind, owner, what);
  }

  private async told(admin: string, kind: AdminActKind, owner: string, what: string): Promise<void> {
    if (nameKey(admin) === nameKey(owner)) return;
    // A deleted person has nothing to show a record on, so only their live sessions are told.
    if (kind !== 'person_deleted') await this.deps.mark(actThread(owner), admin, kind, [nameKey(owner)]);
    const text = `${admin} (an Admin) ${WORDS[kind](what)}.`;
    for (const id of this.deps.sessionsOf(owner)) this.deps.tell(id, text);
  }
}
