---
title: "6.2 The Report"
description: "The shape of a Report: every field, its type and when it is null."
group: "Reference"
section: "6.2"
order: 2
---

# 6.2 The Report

All times are epoch milliseconds. All token counts are integers. Unknown fields are ignored by the server. Missing optional fields are `null`, never omitted, so the shape is stable. `docs/fixtures/report.sample.json` is one full valid example, with every optional field below filled in and a reporter version inside the range the server supports (6.8), and is the shared fixture for both test suites. When a field is added to the Report, add it to the fixture in the same change; `fixtureReport()` in `server/src/fleet/testing.ts` hands tests the fixture without the fields that start behavior of their own (asks, background work, an owner and machine, a live activity feed).

```ts
interface Report {
  v: 1;
  sentAt: number;
  reporter: { name: 'podium-reporter'; version: string; engineVersion: string | null; hostSurface: string | null; build?: string | null };  // build: the commit of a dev build of the mod (6.8); left out for a release
  session: {
    id: string;
    name: string;                       // display name (6.6)
    status: 'running' | 'waiting' | 'done';
    waitReason: 'permission' | 'input' | null;
    waitNote: string | null;            // e.g. "Bash(npm run e2e -- --retries=0)", ≤ 160 chars
    endReason: string | null;           // set with status 'done'
    resumeId: string | null;
    startedAt: number;
    cwd: string;
    projectRoot: string | null;
    repoName: string | null;            // "owner/name" or directory name
    git: { branch: string | null; detached: boolean; isWorktree: boolean; worktreePath: string | null;
           ahead: number; behind: number; dirty: number } | null;
    model: string | null;               // as the engine reports it (alias or id)
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
    context: { tokens: number | null; window: number | null; percent: number | null };
    costUsd: number | null;             // the engine ledger's session cost; the server prices usageByModel instead when it is present (6.5)
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };  // main loop only, cumulative
    usageByModel?: { model: string; tier: 'std' | 'long'; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number } }[];  // the whole session, agents included (#117); absent from a reporter older than 0.12.0
    rateLimits: { kind: string; percentUsed: number; resetsAt: string | null }[];
    blowouts: number;                   // main loop count, cumulative for this session id
    plan: Plan | null;
    loop: LoopReport | null;            // the main loop's own steps, tools and skills; null from a reporter older than 0.4.0
    files: FilesReport | null;          // the files the session changed (5.7); null from a reporter older than 0.6.0
    attached: boolean | null;           // whether any client is attached (5.3, 5.4); false for a background session after /exit, and never for a session started on or seen on the desktop surface before it ends (5.4); null from a reporter older than 0.7.0 or when the roster could not be read
    fileDiff?: boolean;                 // whether the reporter's fileDiff option is on (5.9); absent from a reporter older than the release that adds it
    activityFeed?: boolean;             // whether the reporter's activityFeed option is on (5.9); absent from a reporter older than 0.13.0
    activityOutput?: boolean;           // whether the reporter's activityOutput option is on (#431); absent from a reporter older than the release that adds it
    activity?: ActivityEntry[];         // the main loop's activity feed, sent only while the reply's `watch` lists `@orchestrator` (6.4)
    background?: {                      // what an idle session waits on (#119), with waitReason null; absent from a reporter older than 0.11.0 and when there is none
      tasks: { type: 'shell' | 'agent' | 'monitor' | 'workflow' | 'wakeup' | 'other'; description: string; status: string }[];  // at most 20; description ≤ 120 chars, never a whole shell command
      wakeAt: number | null;            // epoch ms of the next scheduled wake-up; null when there is none, or when any schedule's time could not be read
    };
    respond?: {                         // whether and how far this session can be answered from Podium (#206, 5.3, 5.9); absent from a reporter older than 0.14.0
      level: 'off' | 'questions' | 'questions-and-plans' | 'everything';   // the `respond` option as set
      accepts: RespondKind[];           // what the session takes now: the level's kinds, empty while `activityFeed` is off or the session is not interactive, less what `limits` removes
      limits: ('no-permission-hooks' | 'not-interactive')[];  // why a kind the level allows is missing: PermissionRequest hooks don't run here (drops plan-approve and permission), or a `claude -p` run (drops everything)
    };
    asks?: Ask[];                       // the asks open now, at most 8; sent only while the last reply said `respond: true`, else omitted
    clearedFrom?: string | null;        // the session id this one continues after a /clear (5.8); null or absent otherwise
    peers?: boolean;                    // whether the reporter's `peers` option is on (#347, 5.9); absent from an older reporter, whose sessions are never listed as peers and never get a message
    sessionRecording?: boolean;         // whether the reporter's `sessionRecording` option is on (#353, 5.9); absent from an older reporter, which is never recorded
  };
  agents: AgentReport[];                // every agent seen this session, running or finished
  events: ActivityEvent[];              // not yet acknowledged
  userName?: string;                    // the person this reporter is set up as (the `userName` option); omitted when empty. The server checks it against the token's owner (7.7)
  machine?: { name: string; id: string; os?: string | null };  // os (#347): the machine's OS and version as the mod read it, such as "macOS 27.0.1", free text ≤ 80, never parsed, absent or null when it could not be read. Sent only with userName (0.9.0 and later): the short host name (on macOS `scutil --get LocalHostName`, else `hostname`, up to the first dot, ≤ 64; the first one read is pinned in `podium-machine-name` beside the id file and reported by every later load, so a name that changes with the network does not show one machine under two names, #715; deleting the file takes the current name) and a random 12-hex id the mod keeps in one file, `podium-machine-id` in the Claude config directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`), made on first use and shared by every load of the mod on the machine (#267; an id already in a load's own store under `machineId` is adopted into the file, and the store is used alone where the file cannot be), so two machines with one host name stay apart
}

interface FilesReport {
  files: { path: string; status: 'added' | 'modified' | 'deleted' | 'renamed';
           added: number | null; removed: number | null;   // null for a binary file
           from: string | null }[];                         // the old path of a rename
  total: number; added: number; removed: number;            // over every changed file, not only the listed ones
  since: 'start' | 'upstream' | 'worktree';                 // what the diff is against: the starting commit, the upstream merge base, or HEAD
}

interface Plan {
  title: string | null;
  source: 'TaskCreate' | 'TodoWrite' | 'podium_plan';
  steps: { id: string; text: string; state: 'pending' | 'active' | 'done' | 'blocked';
           activeText: string | null; ownerAgentId: string | null; ownerLabel: string | null }[];
}

// What an agent entry carries about its own work, for the orchestrator's main loop. Same fields, same meaning,
// as the AgentReport fields of the same name; calls made by agents the orchestrator launched are not counted here.
interface LoopReport {
  skills: string[];
  lastTool: string | null;
  toolCalls: number;
  toolCounts: Record<string, number>;   // finished calls per tool name, summing to toolCalls (less when capped, see 7.7)
  steps: { done: number; total: null }; // model requests the main loop has made so far
}

interface AgentReport {
  id: string;                           // the engine's agentId
  parentId: string | null;              // the agentId of the agent that launched it (a subagent or a fork can launch agents, 5.3); null = launched by the orchestrator
  kind: 'subagent' | 'fork' | 'teammate';
  type: string;                         // 'general-purpose', 'Explore', 'fork', a plugin agent…
  name: string | null;
  description: string;
  model: string | null;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  effortSource: 'requested' | 'observed' | 'inherited' | 'unknown';
  status: 'queued' | 'running' | 'done' | 'failed' | 'aborted';
  startedAt: number;
  endedAt: number | null;
  context: { tokens: number | null; window: number | null; percent: number | null };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsdEst: number;
  usageByModel?: { model: string; tier: 'std' | 'long'; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number } }[];  // this agent's own loop (#117); absent from a reporter older than 0.12.0
  skills: string[];
  lastTool: string | null;
  toolCalls: number;
  toolCounts: Record<string, number> | null;   // finished calls per tool name, summing to toolCalls; null from a reporter older than 0.2.0
  blowouts: number;                     // this loop's cumulative blowouts
  steps: { done: number; total: number | null } | null;   // model steps taken so far; total only when known, else null
  promptExcerpt: string;                // first 400 chars of the task prompt
  answerExcerpt: string | null;         // first 400 chars of its final answer
  promptText?: string;                  // the whole task prompt, redacted, line breaks kept, ≤ 20,000 chars then "[cut off at 20,000 characters]". Only with the fullPrompts option (0.10.0 and later), and only in the first accepted report that has it
  answerText?: string;                  // the same for the final answer, sent once when the agent finishes (again if a later answer replaces it)
  activity?: ActivityEntry[];           // this agent's activity feed, sent only while the reply's `watch` lists its id (6.4)
  failure: Failure | null;
}

// One entry of a loop's activity feed (#118), oldest first, at most 20 per loop. A loop's key in `watch` and in the
// activity route is its agent id, or `@orchestrator` (MAIN_LOOP in protocol.ts) for the main loop.
interface ActivityEntry {
  at: number;                           // when the reporter saw it
  kind: 'tool' | 'text' | 'reasoning';  // `reasoning` is reserved; the reporter does not send thinking
  text: string;                         // a tool call: the tool's name, a space, a short summary of its arguments; text: what the model wrote in one step. Redacted, ≤ 300 chars
  // A Bash call's detail (#431). All optional, only on a `tool` entry; an entry from an older mod has none of them and shows as before.
  id?: string;                          // the tool_use_id, so output that arrives after the entry first went out is matched to it
  command?: string;                     // the whole command, redacted, line breaks kept, ≤ 20,000 chars then "[cut off at 20,000 characters]". Rides activityFeed; stored in the Activity history
  commandCut?: boolean;                 // the mod cut the command
  output?: string;                      // stdout then stderr, redacted and cut like the command. Only with the activityOutput option, only for a loop in the reply's `watchOutput`; never stored. "" is a call that printed nothing; absent while the call runs or when no output was captured
  outputCut?: boolean;                  // the mod cut the output
  done?: boolean;                       // the call has finished (#598): sent with activityFeed, with or without `output`; absent while it runs. Not output, so it needs no activityOutput option
  exitCode?: number;                    // the exit status, when the mod can read it. Sent with `done`
  failed?: boolean;                     // the call failed, sent with `done`, with or without `exitCode`
}

// What a session can be answered with from Podium (#206). Which levels allow which: `questions` gives question and
// message; `questions-and-plans` adds plan-approve and plan-feedback; `everything` adds permission and command.
type RespondKind = 'question' | 'plan-approve' | 'plan-feedback' | 'permission' | 'message' | 'command';

// One open ask (#206, 5.3). Everything in it is redacted by the rule in 6.4 before it leaves the machine, and cut to
// the limits below with a visible "[cut off at N characters]" marker. The server keeps it in memory only (7.2).
interface Ask {
  id: string;                           // the tool_use_id of the AskUserQuestion or ExitPlanMode call, or of the call a permission prompt is for
  kind: 'question' | 'plan' | 'permission';
  agentId: string | null;               // the loop that asked; set for a subagent's permission prompt, null for the main loop
  openedAt: number;
  questions?: {                         // kind 'question': 1 to 4, in the order Claude Code shows them
    question: string;                   // ≤ 1,000 chars
    header: string;                     // ≤ 40 chars
    multiSelect: boolean;
    options: { label: string; description: string; preview: string | null }[];  // 1 to 4; label ≤ 200, description ≤ 1,000, preview ≤ 4,000 chars
  }[];
  plan?: { text: string; filePath: string | null };   // kind 'plan': the plan's markdown, ≤ 40,000 chars, and where Claude Code keeps it
  tool?: { name: string; input: Record<string, unknown>; cut: boolean };  // kind 'permission': the tool and its arguments, ≤ 20,000 chars as JSON; `cut` when anything was cut off
}

// One answer or message sent from Podium, as the server hands it to the mod (#206, 7.1). An answer to an ask comes
// through the held request; a message or a command in the reply to a report.
interface Delivery {
  id: string;                           // 'dlv_' and 24 hex characters, made by the server
  askId: string | null;                 // the ask it answers; null for a message or a command
  by: string;                           // who sent it: a person's name, or 'Admin' for the admin secret
  at: number;                           // when the server took it (server time)
  kind: 'question' | 'reply' | 'plan-approve' | 'plan-feedback' | 'allow-once' | 'deny' | 'message' | 'command';
  answers?: ({ options: number[] } | { text: string } | null)[];  // kind 'question': one per question, by position: the chosen options' indexes (one for a single choice), a typed answer (≤ 2,000 chars), or null for skipped. The mod turns it into Claude Code's map from question text to answer, so a redacted question still gets its answer
  mode?: 'auto' | 'acceptEdits' | 'default';   // kind 'plan-approve'
  text?: string;                        // 'reply' (a message in place of an answer), 'plan-feedback', 'deny' (the reason, may be empty) and 'message': ≤ 20,000 chars, line breaks kept
  command?: 'clear' | 'compact';        // kind 'command'
}

// Orchestrator messaging (#347, 7.7). A message or a notice for this session's orchestrator, in the reply to a report.
// `message` is another orchestrator's text, which the mod frames (5.3); `notice` is Podium's own sentence, `from` null.
interface PeerDelivery {
  id: string;                           // 'dlv_' and 24 hex characters, made by the server
  kind: 'message' | 'notice';
  at: number;                           // when the server took it (server time)
  from: { name: string; machine: string; owner: string } | null;   // the sending orchestrator, its machine and its owner
  text: string;                         // ≤ 20,000 chars, line breaks kept; redacted on the sending machine
}

// A request the owner answers, as the owner's sessions on the machine it concerns are told of it.
interface PeerRequest {
  id: string;                           // 'prq_' and 24 hex characters
  kind: 'proposal' | 'access' | 'message';
  at: number;
  from: { machine: string; name: string | null };   // the reporter that would get the right (with the orchestrator's name for an access request), or a message's sender
  to: { machine: string; name: string | null };
  level: 'none' | 'see' | 'ask' | 'send' | null;    // the right proposed or asked for; null for a message. `ask` is "can send, with approval"
  by: string;                           // 'Admin' for a proposal; the orchestrator's name otherwise
  reason: string | null;                // an orchestrator's reason, ≤ 1,000 chars
  text: string | null;                  // a message waiting for approval: its text
}

interface Failure {
  class: 'Tool error' | 'Blocked by permission' | 'Model API error' | 'Refusal'
       | 'Context window exhausted' | 'Aborted' | 'Unknown';
  at: number;
  tool: string | null;                  // e.g. "Bash", "Edit", "model request"
  call: string | null;                  // the failing call, summarized, ≤ 300 chars
  exitCode: number | null;
  outputTail: string[];                 // last ≤ 12 lines of output, each ≤ 240 chars
  evidence: string[];                   // short facts the reporter observed, ≤ 5 lines (e.g. "exceeded the window 3 times", "same file read 4 times")
  explanation: string | null;           // only when explainFailures is on (Phase 5)
  retriedAs: string | null;             // agent id that took over the step, when known
}

interface ActivityEvent {
  id: string;                           // unique per event; idempotency key (sessionId:agentId|main:kind:t:n)
  t: number;
  kind: 'start' | 'end' | 'spawn' | 'skill' | 'done' | 'fail' | 'blow' | 'compact' | 'plan' | 'wait' | 'note';
  agentId: string | null;
  text: string;                         // ≤ 240 chars, plain
  data: Record<string, unknown> | null;
}
```

<!-- nav:start -->
---

Previous: [6.1 Endpoint](06-01-endpoint.md) · Up: [6. The reporter protocol](README.md) · Next: [6.3 Plan building rules](06-03-plan-building-rules.md)
<!-- nav:end -->
