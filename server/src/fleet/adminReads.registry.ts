// Every call a route makes that returns a person's content, and what happens when an Admin makes it (#1080, PROJECT.md "An Admin Never Reads in Silence").
// `adminReads.test.ts` scans the route files against this list: a route that calls one of these from a file with no entry fails `npm test`, a store method
// that returns text fails until it has an entry or is named in NOT_A_READ, and each entry must still be true. Rows R1 to R7 are the audit in #1043.
// This file holds no logic and imports nothing.

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

export const ADMIN_READS: AdminReadEntry[] = [
  {
    call: 'getAgentTexts',
    files: ['fleet/routes.ts'],
    notice: 'told',
    what: "an agent's whole prompt and answer (R5, #1082)",
    via: 'agentRead',
    case: { file: 'fleet/agentReadNotice.test.ts', title: 'serves an Admin, records one read and one Admin log line however many fetches, and tells the owner without any text' },
  },
  {
    call: 'activity.watch',
    files: ['fleet/routes.ts'],
    notice: 'told',
    what: "an agent's live activity feed (R6, #1082)",
    via: 'agentRead',
    case: { file: 'fleet/agentReadNotice.test.ts', title: 'serves an Admin, records one read and one Admin log line however many fetches, and tells the owner without any text' },
  },
  {
    call: 'respond.detail',
    files: ['fleet/respondRoutes.ts'],
    notice: 'told',
    what: 'a waiting ask in full: the question, the plan or the tool input (R2, #1073)',
    via: 'noteSession',
    case: { file: 'fleet/respond.test.ts', title: 'records the read before sending the ask, logs it without the text, and tells the owner in the reporter reply and on the console' },
  },
  {
    call: 'activityHistory.page',
    files: ['fleet/respondRoutes.ts'],
    notice: 'told',
    what: "a page of a session's stored Activity (R3, #1074)",
    via: 'noteSession',
    case: { file: 'fleet/activityHistoryReadNotice.test.ts', title: 'is one record and one Admin log line however many pages the Admin reads of a loop' },
  },
  {
    call: 'recordings.page',
    files: ['fleet/recordingRoutes.ts'],
    notice: 'told',
    what: "a page of a session's recording, the replay (R4, #1075)",
    via: 'noteReplay',
    case: { file: 'fleet/recordingRoutes.test.ts', title: "records the Admin's replay and gives the owner a content-free callout in the session, once however far the Admin pages back" },
  },
  {
    call: 'messages.conversation',
    files: ['fleet/peerRoutes.ts', 'admin/adminRouter.ts'],
    notice: 'told',
    what: "the messages between two of a person's orchestrators (R1, #1072); a person's Chat is refused here and read in Chat",
    via: 'noteConversationRead',
    case: { file: 'fleet/peerRoutes.test.ts', title: 'tells the owner when an Admin reads the conversation here, and not when the owner does (#1072)' },
  },
  {
    call: 'channels.page',
    files: ['fleet/chatChannelRoutes.ts'],
    notice: 'told',
    what: "a page of a person's group in Chat (#1034)",
    via: 'readRecord',
    case: { file: 'fleet/chatRoutes.test.ts', title: "tells every reporter session of the person when an Admin starts reading their group, once, and no one else's" },
  },
  {
    call: 'direct.thread',
    files: ['fleet/chatDmRoutes.ts'],
    notice: 'told',
    what: 'a page of a Direct Message in Chat (#1034, #1051)',
    via: 'reads.note',
    viaFile: 'fleet/chatDirect.ts',
    case: { file: 'fleet/chatRoutes.test.ts', title: "records an Admin reading a conversation between a person's two agents, for that person" },
  },
  {
    call: 'diffs.ask',
    files: ['fleet/respondRoutes.ts'],
    notice: 'owner-only',
    what: "a file's diff, which is source code (DECISIONS 36)",
    case: { file: 'fleet/fileDiffRoutes.test.ts', title: 'lets only the owner: not another person, not an Administrator, not the admin secret' },
  },
  {
    call: 'channels.agentRead',
    files: ['fleet/chatAgentRoutes.ts'],
    notice: 'owner-only',
    what: "the last hour of a channel, read by the person's own agent with its reporter token; the admin secret and any other person are refused",
    case: { file: 'fleet/chatRoutes.test.ts', title: "refuses an ended agent, another person's agent and the admin secret" },
  },
  {
    call: 'fleet.view',
    files: ['fleet/routes.ts'],
    notice: 'open',
    what: "a session's card: names, states, counts and the event lines the wall shows (R7)",
    decision: 62,
  },
  {
    call: 'fleet.events',
    files: ['fleet/routes.ts'],
    notice: 'open',
    what: 'the event lines the wall shows (R7)',
    decision: 62,
    covers: ['listEvents'],
  },
  {
    call: 'fleet.historyPage',
    files: ['fleet/routes.ts'],
    notice: 'open',
    what: "a day's sessions as the history lists them (R7)",
    decision: 62,
  },
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
  adminNoticesFor: 'the notice told to the person: it names the Admin and holds none of the person\'s text',
  noticesFor: 'the notice told to the person: it names the Admin and holds none of the person\'s text',
  for: 'the notice told to the person: it names the Admin and holds none of the person\'s text',
  message: 'one stored message by id; its one route (answering a request, `peerRoutes.ts`) compares the ids and returns no text, and needs the owner\'s reporter token',
};
