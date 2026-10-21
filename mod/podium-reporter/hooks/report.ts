// SessionState -> Report (SPEC 6.2). Pure. Every free-text field passes through redaction and is cut
// to its limit here, so nothing leaves the machine unredacted.
import { DETAIL_CHARS_PER_REPORT } from './activityDetail.ts';
import { clip, excerpt, LIMITS } from './failures.ts';
import { lastSegment } from './git.ts';
import { family, windowOf } from './models.ts';
import { toPlan } from './plan.ts';
import type { ActivityEntry, ActivityEvent, AgentReport, Ask, Failure, LoopReport, MachineInfo, ModelUsage, Report, RespondInfo } from './protocol.ts';
import { utf8Bytes } from './recording.ts';
import { RECORDING_LIMITS } from './protocol.ts';
import { mergeUsage, resolveOwners, type AgentState, type LoopStats, type SessionState } from './state.ts';

export const REPORTER_NAME = 'podium-reporter';
export const MAX_EVENTS_PER_REPORT = 100;
export const MAX_AGENTS_PER_REPORT = 200;
/** Full prompt and answer characters in one report; the server accepts a 512 kB body. The rest goes in later reports. */
export const MAX_FULL_TEXT_PER_REPORT = 120_000;
/** Activity-feed characters in one report (#118), as the server takes them: the orchestrator's first, then the agents'. */
export const MAX_ACTIVITY_PER_REPORT = 60_000;

export interface ReportMeta {
  version: string;
  engineVersion: string | null;
  hostSurface: string | null;
  /** The commit of a dev build of the mod (#400); null or absent for a release. */
  build?: string | null;
  now: number;
  /** Set with `/podium name`, kept in $.store per session id. */
  storedName: string | null;
  /** The session's own name in Claude Code (`/rename`, or its title), from a hook's `session_title` (#322). */
  claudeName?: string | null;
  /** The `sessionName` option. */
  optionName: string | null;
  /** The `userName` option: the person this reporter is configured as. The server checks it against the token. */
  userName?: string | null;
  /** This machine; sent only together with a userName. */
  machine?: MachineInfo | null;
  /** The `fullPrompts` option: send each agent's whole prompt and answer, once. */
  fullText?: boolean;
  /** The `activityFeed` option: send the feed of each loop the server says is watched (#118). */
  activity?: boolean;
  /** The `activityOutput` option: a Bash call's output may go out with its entry, for a loop the reply lists in `watchOutput` (#431). */
  activityOutput?: boolean;
  /** The `fileDiff` option: answer requests for one file's diff (#319). */
  fileDiff?: boolean;
  /** The `sessionRecording` option: the owner's consent to be recorded (#353). */
  sessionRecording?: boolean;
  /** Whether and how far the session can be answered from Podium (#206); omitted by nothing that responds. */
  respond?: RespondInfo | null;
  /** The asks open now, sent only while the server takes answers (#206). */
  asks?: Ask[] | null;
  /** The session this one continues after a /clear. */
  clearedFrom?: string | null;
  /** The `peers` option, for an interactive session (#347, #414): whether this orchestrator may take part in messaging. */
  peers?: boolean;
}

/** Display name (SPEC 6.6): /podium name, Claude Code's session name, the option, a worktree's branch or folder, the repo folder, the id. */
export function displayName(s: Pick<SessionState, 'id' | 'git' | 'projectRoot' | 'cwd'>, storedName: string | null, claudeName: string | null | undefined, optionName: string | null): string {
  const pick = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
  const name =
    pick(storedName) ??
    pick(claudeName) ??
    pick(optionName) ??
    (s.git?.isWorktree ? pick(s.git.branch && !s.git.detached ? lastSegment(s.git.branch) : null) ?? pick(s.git.worktreePath ? lastSegment(s.git.worktreePath) : null) : null) ??
    pick(s.projectRoot ? lastSegment(s.projectRoot) : null) ??
    `session-${s.id.slice(0, 6)}`;
  return clip(name, 80);
}

/** `owner/name` from an origin URL (`git@github.com:o/n.git`, `https://host/o/n`). */
export function repoFromRemote(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function cleanFailure(f: Failure | null): Failure | null {
  if (!f) return null;
  return {
    ...f,
    tool: f.tool ? clip(f.tool, 120) : null,
    call: f.call ? clip(f.call, 300) : null,
    outputTail: f.outputTail.slice(-12).map((l) => clip(l, 240)),
    evidence: f.evidence.slice(0, 5).map((l) => clip(l, 240)),
    explanation: f.explanation ? clip(f.explanation, 400) : null,
  };
}

function pct(tokens: number | null, window: number | null): number | null {
  if (tokens === null || !window) return null;
  return Math.round(Math.min(100, (tokens / window) * 100) * 10) / 10;
}

/** The fields an agent entry and the main loop's block share: skills, last tool, call counts and steps. */
function loopFields(l: LoopStats): LoopReport {
  return {
    skills: l.skills.slice(0, 50).map((k) => clip(k, 120)),
    lastTool: l.lastTool,
    toolCalls: l.toolCalls,
    toolCounts: Object.fromEntries(Object.entries(l.toolCounts).map(([k, n]) => [clip(k, 120), n])),
    steps: { done: l.steps, total: null },
  };
}

/** The rows the server accepts: model ids clipped, and no more than it takes. */
function usageRows(rows: ModelUsage[]): ModelUsage[] {
  return rows.slice(0, 40).map((r) => ({ ...r, model: clip(r.model, 120) }));
}

/** The most a command or an output may hold as the server takes it: the 20,000-character cut plus the marker (`activityDetail`). */
const DETAIL_MAX = 20_100;

/** A loop's feed as it is sent: every summary redacted and cut again here, like every other free-text field. A command and an output were redacted and cut when captured; here they are only held to the server's limit. */
function feed(list: readonly ActivityEntry[], withOutput: boolean): ActivityEntry[] {
  return list.map((e) => {
    const out: ActivityEntry = { at: e.at, kind: e.kind, text: clip(e.text, LIMITS.activity) };
    if (e.kind !== 'tool') return out;
    if (e.id !== undefined) out.id = clip(e.id, 200);
    if (e.command !== undefined) {
      out.command = e.command.slice(0, DETAIL_MAX);
      if (e.commandCut) out.commandCut = true;
    }
    if (withOutput && e.output !== undefined) {
      out.output = e.output.slice(0, DETAIL_MAX);
      if (e.outputCut) out.outputCut = true;
      if (e.done) out.done = true;
      if (e.exitCode !== undefined) out.exitCode = e.exitCode;
      if (e.failed) out.failed = true;
    }
    return out;
  });
}

export function agentReport(a: AgentState, fullText = false, activity = false, activityOutput = false): AgentReport {
  const window = a.window ?? (a.model ? windowOf(a.model) : null);
  return {
    id: clip(a.id, 200),
    parentId: a.parentId,
    kind: a.kind,
    type: clip(a.type, 120),
    name: a.name ? clip(a.name, 80) : null,
    description: clip(a.description, 240),
    model: a.model,
    effort: a.effort,
    effortSource: a.effortSource,
    status: a.status,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    context: { tokens: a.ctxTokens, window, percent: pct(a.ctxTokens, window) },
    tokens: { ...a.tokens },
    costUsdEst: a.model && family(a.model) === 'other' ? null : Math.round(a.cost * 1e6) / 1e6,
    usageByModel: usageRows(mergeUsage(a.usage)),
    ...loopFields(a),
    blowouts: a.blowouts,
    promptExcerpt: excerpt(a.promptExcerpt),
    answerExcerpt: a.answerExcerpt ? excerpt(a.answerExcerpt) : null,
    ...(fullText && a.promptText && !a.promptSent ? { promptText: a.promptText } : {}),
    ...(fullText && a.answerText && !a.answerSent ? { answerText: a.answerText } : {}),
    ...(activity && a.activity.length ? { activity: feed(a.activity, activityOutput) } : {}),
    failure: cleanFailure(a.failure),
  };
}

/** Drops full texts past the per-report budget (oldest agents first kept); they are still unsent, so a later report carries them. */
function withinTextBudget(reports: AgentReport[]): AgentReport[] {
  let left = MAX_FULL_TEXT_PER_REPORT;
  return reports.map((r) => {
    const { promptText, answerText, ...rest } = r;
    const out: AgentReport = rest;
    for (const [k, v] of [['promptText', promptText], ['answerText', answerText]] as const) {
      if (v === undefined) continue;
      if (v.length <= left || left === MAX_FULL_TEXT_PER_REPORT) {
        out[k] = v;
        left -= v.length;
      }
    }
    return out;
  });
}

/** Leaves out the feeds past the per-report budget, the orchestrator's first, then the agents' in order, as the server would. */
function withinActivityBudget(r: Report): Report {
  let left = MAX_ACTIVITY_PER_REPORT;
  const fits = (list: ActivityEntry[]) => {
    const n = list.reduce((sum, e) => sum + e.text.length, 0);
    if (n > left) return false;
    left -= n;
    return true;
  };
  if (r.session.activity && !fits(r.session.activity)) delete r.session.activity;
  for (const a of r.agents) if (a.activity && !fits(a.activity)) delete a.activity;
  return r;
}

const OUTPUT_FIELDS = ['output', 'outputCut', 'done', 'exitCode', 'failed'] as const;
const COMMAND_FIELDS = ['command', 'commandCut'] as const;

/** The feeds of a report, the orchestrator's first, then each agent's in order, as the server reads them. */
function feeds(r: Report): ActivityEntry[][] {
  const lists: ActivityEntry[][] = [];
  if (r.session.activity) lists.push(r.session.activity);
  for (const a of r.agents) if (a.activity) lists.push(a.activity);
  return lists;
}

const detailChars = (e: ActivityEntry): number => (e.command?.length ?? 0) + (e.output?.length ?? 0);

/**
 * Keeps commands and output within the report's own 200,000 characters (#431), apart from the summaries' 60,000: in feed order and
 * newest entry first, as the server counts them. An entry that does not fit loses its output, and then its command, and keeps its summary.
 */
function withinDetailBudget(r: Report): Report {
  let room = DETAIL_CHARS_PER_REPORT;
  for (const list of feeds(r)) {
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]!;
      if (detailChars(e) <= room) {
        room -= detailChars(e);
        continue;
      }
      for (const k of OUTPUT_FIELDS) delete e[k];
      if (detailChars(e) <= room) room -= detailChars(e);
      else for (const k of COMMAND_FIELDS) delete e[k];
    }
  }
  return r;
}

/**
 * Keeps the serialized report under the server's 512 KB body, as a recording's request does (480,000 bytes): the character budget
 * does not see a multi-byte text. Output goes first, then commands, from the last loop's oldest entry back, until it fits.
 */
function withinSize(r: Report): Report {
  const lists = feeds(r);
  if (!lists.length || utf8Bytes(JSON.stringify(r)) <= RECORDING_LIMITS.bodyBytes) return r;
  const order = lists.slice().reverse().flatMap((list) => list);
  for (const fields of [OUTPUT_FIELDS, COMMAND_FIELDS]) {
    for (const e of order) {
      if (!fields.some((k) => k in e)) continue;
      for (const k of fields) delete e[k];
      if (utf8Bytes(JSON.stringify(r)) <= RECORDING_LIMITS.bodyBytes) return r;
    }
  }
  return r;
}

/** A full snapshot of the session plus the events given (at most 100). */
export function buildReport(s0: SessionState, events: readonly ActivityEvent[], meta: ReportMeta): Report {
  const s = resolveOwners(s0);
  const ctxWindow = s.context.window ?? s.main.window ?? (s.main.model ? windowOf(s.main.model) : null);
  const ctxTokens = s.context.tokens ?? s.main.ctxTokens;
  const ctxPercent = s.context.percent ?? pct(ctxTokens, ctxWindow);
  // Most recent agents win if a session ever has more than the server accepts.
  const agents = s.order.map((id) => s.agents[id]).filter((a): a is AgentState => !!a).slice(-MAX_AGENTS_PER_REPORT);
  const activity = meta.activity === true;
  return withinSize(withinDetailBudget(withinActivityBudget({
    v: 1,
    sentAt: meta.now,
    reporter: { name: REPORTER_NAME, version: meta.version, engineVersion: meta.engineVersion, hostSurface: meta.hostSurface, ...(meta.build ? { build: meta.build } : {}) },
    ...(meta.userName && meta.userName.trim() ? { userName: clip(meta.userName.trim(), 80), ...(meta.machine ? { machine: { ...meta.machine } } : {}) } : {}),
    session: {
      id: s.id,
      name: displayName(s, meta.storedName, meta.claudeName, meta.optionName),
      status: s.status,
      waitReason: s.status === 'waiting' ? s.waitReason : null,
      waitNote: s.status === 'waiting' && s.waitNote ? clip(s.waitNote, 160) : null,
      endReason: s.status === 'done' ? s.endReason : null,
      resumeId: s.resumeId,
      startedAt: s.startedAt,
      cwd: s.cwd,
      projectRoot: s.projectRoot,
      repoName: s.repoName,
      git: s.git,
      model: s.main.model,
      effort: s.main.effort,
      context: { tokens: ctxTokens, window: ctxWindow, percent: ctxPercent === null ? null : Math.max(0, Math.min(100, ctxPercent)) },
      costUsd: s.main.model && family(s.main.model) === 'other' ? null : s.costUsd,
      tokens: { ...s.main.tokens },
      usageByModel: usageRows(mergeUsage(s.main.usage, ...s.order.map((id) => s.agents[id]?.usage))),
      rateLimits: s.rateLimits.slice(0, 10),
      blowouts: s.main.blowouts,
      plan: toPlan(s.plan),
      loop: loopFields(s.main),
      attached: s.attached,
      ...(s.status === 'waiting' && s.background ? { background: s.background } : {}),
      files: { ...s.files, files: s.files.files.map((f) => ({ ...f, path: clip(f.path, 300), from: f.from === null ? null : clip(f.from, 300) })) },
      activityFeed: activity,
      activityOutput: meta.activityOutput === true,
      fileDiff: meta.fileDiff === true,
      sessionRecording: meta.sessionRecording === true,
      ...(activity && s.main.activity.length ? { activity: feed(s.main.activity, meta.activityOutput === true) } : {}),
      ...(meta.respond ? { respond: meta.respond } : {}),
      ...(meta.asks ? { asks: meta.asks.slice(0, 8) } : {}),
      ...(meta.clearedFrom ? { clearedFrom: meta.clearedFrom } : {}),
      peers: meta.peers === true,
    },
    agents: withinTextBudget(agents.map((a) => agentReport(a, meta.fullText === true, activity, meta.activityOutput === true))),
    events: events.slice(0, MAX_EVENTS_PER_REPORT).map((e) => ({ ...e, text: clip(e.text, 240) })),
  })));
}
