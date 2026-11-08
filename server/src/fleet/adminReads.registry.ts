// Every call a route makes that returns a person's content, and what happens when an Admin makes it (#1080, PROJECT.md "An Admin Never Reads in Silence").
// `adminReads.test.ts` scans the route files against this list: a route that calls one of these from a file with no entry fails `npm test`, a store method
// that returns text fails until it has an entry or is named in NOT_A_READ, and each entry must still be true. Rows R1 to R7 are the audit in #1043.
// This file holds three one-line constructors and the list. It imports nothing.

/**
 * What an Admin who makes the call gets:
 * - `told`: the read is recorded before anything is sent and the person is told in the console and in `podium-reporter`. `via` is the call that records it,
 *   found in `viaFile` (the route file when that is omitted), and `case` names the test that signs in as an Admin, reads, and asserts the notice.
 * - `owner-only`: an Admin is refused, so there is nothing to tell. `case` names the test that shows the refusal.
 * - `open`: anyone who can load the console may read it, as how the wall looks. It needs the decision that says so (`decision`) or an open issue (`issue`).
 */
export type AdminReadNotice = 'told' | 'owner-only' | 'open';

export interface AdminReadEntry {
  /** The call, as the last segments of the callee with call parentheses dropped: `fleet.peers.messages.conversation` is `messages.conversation`. */
  call: string;
  /** Route files, relative to `server/src`, that make the call. A call in any other route file fails the scan. */
  files: string[];
  notice: AdminReadNotice;
  /** What the call returns, in a few words. */
  what: string;
  /** For `told`: the call that records the read, and the file it sits in when that is not the route file. */
  via?: string;
  viaFile?: string;
  /** For `told` and `owner-only`: a test file (relative to `server/src`) and the title of a case in it. The title is matched as text. */
  case?: { file: string; title: string };
  /** For `open`: the decision, by number, or the open issue that tracks it. */
  decision?: number;
  issue?: number;
  /** Store methods this call reaches, so the scan of the store interfaces knows they are covered. */
  covers?: string[];
}

type Where = { call: string; files: string[]; what: string };
type Case = [file: string, title: string];

/** An Admin's read is recorded and the person is told. `via` is the recording call, in `viaFile` when it is not in the route file. */
const told = (w: Where, via: string, c: Case, viaFile?: string): AdminReadEntry => ({ ...w, notice: 'told', via, ...(viaFile ? { viaFile } : {}), case: { file: c[0], title: c[1] } });
/** An Admin is refused, and the case shows it. */
const ownerOnly = (w: Where, c: Case): AdminReadEntry => ({ ...w, notice: 'owner-only', case: { file: c[0], title: c[1] } });
/** Anyone who can load the console may read it, by the decision that says so. */
const open = (w: Where, decision: number, covers?: string[]): AdminReadEntry => ({ ...w, notice: 'open', decision, ...(covers ? { covers } : {}) });

const AGENT_READ: Case = ['fleet/agentReadNotice.test.ts', 'serves an Admin, records one read and one Admin log line however many fetches, and tells the owner without any text'];

export const ADMIN_READS: AdminReadEntry[] = [
  told({ call: 'getAgentTexts', files: ['fleet/routes.ts'], what: "an agent's whole prompt and answer (R5, #1082)" }, 'agentRead', AGENT_READ),
  told({ call: 'activity.watch', files: ['fleet/routes.ts'], what: "an agent's live activity feed (R6, #1082)" }, 'agentRead', AGENT_READ),
  told({ call: 'respond.detail', files: ['fleet/respondRoutes.ts'], what: 'a waiting ask in full: the question, the plan or the tool input (R2, #1073)' }, 'noteSession', [
    'fleet/respond.test.ts',
    'records the read before sending the ask, logs it without the text, and tells the owner in the reporter reply and on the console',
  ]),
  told({ call: 'activityHistory.page', files: ['fleet/respondRoutes.ts'], what: "a page of a session's stored Activity (R3, #1074)" }, 'noteSession', [
    'fleet/activityHistoryReadNotice.test.ts',
    'is one record and one Admin log line however many pages the Admin reads of a loop',
  ]),
  told({ call: 'recordings.page', files: ['fleet/recordingRoutes.ts'], what: "a page of a session's recording, the replay (R4, #1075)" }, 'noteReplay', [
    'fleet/recordingRoutes.test.ts',
    "records the Admin's replay and gives the owner a content-free callout in the session, once however far the Admin pages back",
  ]),
  told({ call: 'messages.conversation', files: ['fleet/peerRoutes.ts', 'admin/adminRouter.ts'], what: "the messages between two of a person's orchestrators (R1, #1072); a person's Chat is refused here and read in Chat" }, 'noteConversationRead', [
    'fleet/peerRoutes.test.ts',
    'tells the owner when an Admin reads the conversation here, and not when the owner does (#1072)',
  ]),
  told({ call: 'channels.page', files: ['fleet/chatChannelRoutes.ts'], what: "a page of a person's group in Chat (#1034)" }, 'readRecord', [
    'fleet/chatRoutes.test.ts',
    "tells every reporter session of the person when an Admin starts reading their group, once, and no one else's",
  ]),
  told({ call: 'direct.thread', files: ['fleet/chatDmRoutes.ts'], what: 'a page of a Direct Message in Chat (#1034, #1051)' }, 'reads.note', [
    'fleet/chatRoutes.test.ts',
    "records an Admin reading a conversation between a person's two agents, for that person",
  ], 'fleet/chatDirect.ts'),
  ownerOnly({ call: 'diffs.ask', files: ['fleet/respondRoutes.ts'], what: "a file's diff, which is source code (DECISIONS 36)" }, [
    'fleet/fileDiffRoutes.test.ts',
    'lets only the owner: not another person, not an Administrator, not the admin secret',
  ]),
  ownerOnly({ call: 'channels.agentRead', files: ['fleet/chatAgentRoutes.ts'], what: "the last hour of a channel, read by the person's own agent with its reporter token; the admin secret and any other person are refused" }, [
    'fleet/chatRoutes.test.ts',
    "refuses an ended agent, another person's agent and the admin secret",
  ]),
  open({ call: 'fleet.view', files: ['fleet/routes.ts'], what: "a session's card: names, states, counts and the event lines the wall shows (R7)" }, 62),
  open({ call: 'fleet.events', files: ['fleet/routes.ts'], what: 'the event lines the wall shows (R7)' }, 62, ['listEvents']),
  open({ call: 'fleet.historyPage', files: ['fleet/routes.ts'], what: "a day's sessions as the history lists them (R7)" }, 62),
];

/**
 * Store methods that return a row with a text field and are not a read: each writes the row and answers with what was just written to the caller who wrote it.
 * A method added here says why. A method that reads belongs in `ADMIN_READS`.
 */
export const NOT_A_READ: Record<string, string> = {
  sendFromPerson: 'a write: answers the message the person just sent',
  sendAcross: 'a write: answers the message just sent',
  post: 'a write: answers the message the person just posted',
  setMention: 'a write: answers the message the person just changed',
  agentPost: 'a write: an agent posts into a channel and is answered the message it posted',
  adminNoticesFor: "the notice told to the person: it names the Admin and holds none of the person's text",
  noticesFor: "the notice told to the person: it names the Admin and holds none of the person's text",
  for: "the notice told to the person: it names the Admin and holds none of the person's text",
  message: "one stored message by id; its one route (answering a request, `peerRoutes.ts`) compares the ids and returns no text, and needs the owner's reporter token",
};
