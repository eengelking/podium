---
title: "7.4 View types"
description: "The types the server sends to the UI, defined once in protocol.ts."
group: "Reference"
section: "7.4"
order: 4
---

# 7.4 View types

Server to UI. Defined once in `protocol.ts`, imported by the UI.

```ts
interface SessionView {
  id: string; name: string; project: string; repoName: string | null; resumeCommand: string; forkCommand: string;
  reporterVersion: string | null; reporterBuild: string | null; compat: 'ok' | 'outdated' | 'newer' | 'unknown';  // the mod's version and where it sits against the server's range (6.8)
  git: { branch: string | null; detached: boolean; isWorktree: boolean; worktreePath: string | null; ahead: number; behind: number; dirty: number } | null;
  model: string | null; modelFamily: 'opus'|'sonnet'|'haiku'|'fable'|'other'; effort: string | null;
  status: 'running' | 'waiting' | 'stale' | 'done'; waitNote: string | null; endReason: string | null;
  startedAt: number; lastSeenAt: number; secondsSinceSeen: number;
  dropAt: number | null; // epoch ms when a stale session leaves the wall by itself; null unless stale (7.5)
  context: { tokens: number | null; window: number | null; percent: number | null };
  costUsd: number | null; tokensTotal: number;
  harness: string;                      // 'claude-code' for a session stored before harnesses were recorded (#851)
  costSource: 'harness' | 'estimate';   // 'harness': costUsd is the harness's own figure, shown labeled as such (6.5)
  blowouts: { orchestrator: number; agents: number; total: number; level: 0 | 1 | 2; loopsHit: number; loopsTotal: number;
              log: { t: number; agentId: string | null; kind: string; tokensBefore: number | null; tokensAfter: number | null }[] };
  compactions: number;                  // times Claude Code compacted the session on its own, any loop: its stored `compact` events with data.trigger "auto" (#805). 0 from a reporter older than the one that sends them.
  plan: Plan | null;                    // each step also carries doneSeq?: number, added by the server (#454): 1 for the first step seen to finish, then 2, ...; absent when not done or done when first seen
  loop: LoopReport | null;              // the main loop's steps, tools and skills; null from a reporter older than 0.4.0 and for a settings-hooks session
  files: FilesReport | null;            // the files the session changed; null from a reporter older than 0.6.0 and for a settings-hooks session
  attached: boolean | null;             // whether any client is attached; null from a reporter older than 0.7.0 (counts as attached)
  background: { tasks: { type: string; description: string; status: string }[]; wakeAt: number | null } | null;  // what the session is idle on (#119); not a wait on the person, so it is left out of the waiting count
  hideAt: number | null;                // epoch ms when a session nobody is attached to is set aside from the wall; null while attached or unknown (7.5)
  owner: string | null;                 // who the server decided the session belongs to from the token (7.7): a person's name, 'Admin', or null
  ownerGroup: string | null;            // that person's group from Admin; null for Admin, no owner, or no group
  machine: { name: string; id: string } | null;  // Report.machine as last sent; null when none was
  activityFeed: boolean | null;         // the reporter's activityFeed option (6.4); null for a reporter older than 0.13.0, a settings-hooks session, or no report since the server started (held in memory)
  respond: { level: string; accepts: RespondKind[]; limits: string[] } | null;  // Report.session.respond (#206); null for a reporter older than 0.14.0, a settings-hooks session, or no report since the server started (held in memory)
  asks: {                               // the session's asks, open, or closed and not yet forgotten (7.2: at idle, or 10 minutes), without their content: that is served only to the owner or an Admin (7.1)
    id: string; kind: 'question' | 'plan' | 'permission'; agentId: string | null; openedAt: number;
    count: number;                      // questions in a question ask (the Respond button's number); 1 otherwise
    state: 'open' | 'pending' | 'not-taken' | 'closed';
  }[];
  clearedFrom: string | null;           // the session this one continues after a /clear (5.8)
  recording?: RecordingView | null;     // #353: { state: 'recording' | 'stopped' | 'limit', limit, startedBy, startedAt, stoppedBy, stoppedAt, keptUntil, bytes, loops: { loop, name, recorded }[], ownerAllows }; everything the wall and the page show about a recording and no text; null or absent when nothing is chosen or kept
  agents: AgentView[];                  // AgentReport + modelFamily + costUsdEst
  series: { tokensPerSec: number[]; peakContext: number[]; running: number[]; blowoutSecondsAgo: number[] };  // 60 points, oldest first; peakContext in 0..1; missing seconds zero-filled
}
```

`resumeCommand` is `cd <cwd> && claude --resume <resumeId ?? id>`. `forkCommand` is the same command with ` --fork-session` added: `cd <cwd> && claude --resume <resumeId ?? id> --fork-session` (#352). Both quote a `cwd` or id that holds anything but safe shell characters, and both are built in `derive.ts`, so the page copies a string and never builds a command. No new report field is needed. `project` is `projectRoot ?? cwd` with the home directory shortened to `~`.

<!-- nav:start -->
---

Previous: [7.3 Ingest rules and derivation](07-03-ingest-rules-and-derivation.md) · Up: [7. The server](README.md) · Next: [7.5 Lifecycle timers](07-05-lifecycle-timers.md)
<!-- nav:end -->
