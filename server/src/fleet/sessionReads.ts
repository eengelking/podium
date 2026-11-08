// An Admin reading the content of a person's session is recorded and the person is told (PROJECT.md "An Admin Never Reads in Silence", #1043 rows R2 and R3).
// This is the shared vocabulary of those reads: which kinds there are, the thread each is recorded under in `chat_admin_reads`, and the words of the callout
// the person's reporter sessions show. A read kind is one entry in KINDS; a new one (a replay, #1075) is one more line there. Words only, never any text.
import { nameKey } from '../storage/rows.js';

/**
 * What an Admin reads of a person's session: a waiting question, plan or tool input (`ask`), the stored Activity of one loop (`activity`), an agent's whole
 * prompt and answer (`text`, #1082) or the live Activity of one loop (`live`, #1082).
 */
export type SessionReadKind = 'ask' | 'activity' | 'text' | 'live';

interface KindDef {
  /** What the callout says the Admin is doing, to be read after the Admin's name, naming the session so a person with several open knows which. */
  phrase: (sessionName: string) => string;
  /** Whether the thread carries a loop after the session id (`activity:<session>:<loop>`). */
  loop: boolean;
}

const KINDS: Record<SessionReadKind, KindDef> = {
  ask: { phrase: (name) => `is reading your waiting plan, question or tool request on ${name}`, loop: false },
  activity: { phrase: (name) => `is paging through the stored Activity of ${name}`, loop: true },
  text: { phrase: (name) => `is reading the whole prompt and answer of an agent in ${name}`, loop: true },
  live: { phrase: (name) => `is watching the live activity of an agent in ${name}`, loop: true },
};

export const SESSION_READ_KINDS = Object.keys(KINDS) as SessionReadKind[];

export const isSessionReadKind = (v: unknown): v is SessionReadKind => typeof v === 'string' && Object.hasOwn(KINDS, v);

/** A loop is an agent's id (up to the protocol's 200 characters, of any kind) or the orchestrator's; the thread is split on its last colon, so it holds none. */
export const LOOP_ID = /^[^:\s]{1,200}$/;

/** Whether a read of this kind is recorded per loop, so it must name one. */
export const readNeedsLoop = (kind: SessionReadKind): boolean => KINDS[kind].loop;

/** The thread an Admin's read is recorded under: `ask:<session>` `activity:<session>:<loop>`, `text:<session>:<agent>` or `live:<session>:<loop>`. */
export function sessionThread(kind: SessionReadKind, sessionId: string, loop?: string): string {
  return KINDS[kind].loop ? `${kind}:${sessionId}:${loop ?? ''}` : `${kind}:${sessionId}`;
}

/** The prefix every thread of one session and kind starts with (all its loops), for listing the records of a session. */
export const sessionThreadPrefix = (kind: SessionReadKind, sessionId: string): string => (KINDS[kind].loop ? `${kind}:${sessionId}:` : `${kind}:${sessionId}`);

export interface ParsedSessionThread {
  kind: SessionReadKind;
  sessionId: string;
  loop: string | null;
}

/** The kind, session and loop of a session-read thread; null for any other thread (a group, a list, a direct message). */
export function parseSessionThread(thread: string): ParsedSessionThread | null {
  const colon = thread.indexOf(':');
  if (colon < 1) return null;
  const kind = thread.slice(0, colon);
  if (!isSessionReadKind(kind)) return null;
  const rest = thread.slice(colon + 1);
  if (!KINDS[kind].loop) return rest ? { kind, sessionId: rest, loop: null } : null;
  const cut = rest.lastIndexOf(':');
  if (cut < 1 || cut === rest.length - 1) return null;
  return { kind, sessionId: rest.slice(0, cut), loop: rest.slice(cut + 1) };
}

export const sessionPhrase = (kind: SessionReadKind, sessionName: string): string => KINDS[kind].phrase(sessionName);

/** A session read's subject: the person told (folded), the thread and the callout's words. */
export interface SessionReadSubject {
  kind: SessionReadKind;
  sessionId: string;
  thread: string;
  owner: string;
  phrase: string;
}

export function sessionSubject(kind: SessionReadKind, session: { id: string; name: string; owner: string }, loop?: string): SessionReadSubject {
  return { kind, sessionId: session.id, thread: sessionThread(kind, session.id, loop), owner: nameKey(session.owner), phrase: sessionPhrase(kind, session.name) };
}
