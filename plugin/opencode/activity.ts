// What an activity-feed entry holds for an OpenCode tool call (#118, #431, #969). Pure. The wording is the Claude Code reporter's
// (`core/failures.ts` `activityCall`), so the console reads the same for both: OpenCode's tool names and argument names are put
// into the ones that function knows. The limits, the redaction and the clean-up of a command and its output are `core/feed.ts`.
import { activityCall, parseExitCode } from '../core/failures.ts';
import { commandDetail, outputDetail } from '../core/feed.ts';
import type { ActivityEntry } from '../core/protocol.ts';

/**
 * OpenCode's tool name, as the Claude Code reporter names the same kind of tool. The names are the ones OpenCode 2.2.5 sends (seen in a
 * live run: `shell`, `read`, `write`, `edit`, `glob`, `grep`, `skill`, `subagent`, `webfetch`, `question`, and `todowrite` where the person
 * turned `experimental.todo` on); `bash`, `task` and `patch` are the older names. Anything else keeps its own name.
 */
const NAMES: Record<string, string> = {
  shell: 'Bash', bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', patch: 'Edit', apply_patch: 'Edit', glob: 'Glob', grep: 'Grep',
  subagent: 'Agent', task: 'Agent', skill: 'Skill', webfetch: 'WebFetch', websearch: 'WebSearch', question: 'AskUserQuestion', todowrite: 'TodoWrite',
};

/** The Claude Code reporter's name for an OpenCode tool. */
export const toolName = (tool: string): string => NAMES[tool] ?? tool;

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write']);

/** The tool and its arguments under the names `activityCall` and the recording read. A file tool's path is `file_path`; the skill tool's `id` is `skill`. */
export function canonical(tool: string, input: Record<string, unknown>): { tool: string; input: Record<string, unknown> } {
  const name = toolName(tool);
  const out: Record<string, unknown> = { ...input };
  if (FILE_TOOLS.has(name)) {
    for (const key of ['path', 'filePath']) {
      if (typeof input[key] !== 'string') continue;
      if (out.file_path === undefined) out.file_path = input[key];
      delete out[key];
    }
  }
  if (name === 'Skill' && out.skill === undefined) {
    const named = [input.id, input.name].find((v) => typeof v === 'string');
    if (named !== undefined) out.skill = named;
  }
  return { tool: name, input: out };
}

/**
 * The entry for a tool call that is about to run. A shell call also carries its `id` and its whole command, so the same entry can
 * be completed with how it ended, and with its output, once it finishes.
 */
export function entryFor(tool: string, input: Record<string, unknown>, id: string | undefined, at: number): ActivityEntry {
  const c = canonical(tool, input);
  const entry: ActivityEntry = { at, kind: 'tool', text: activityCall(c.tool, c.input) };
  if (c.tool !== 'Bash') return entry;
  if (id) entry.id = id;
  if (typeof input.command === 'string') {
    const cmd = commandDetail(input.command);
    entry.command = cmd.text;
    if (cmd.cut) entry.commandCut = true;
  }
  return entry;
}

/**
 * What a finished shell call adds to its entry (#598): `done`, and `failed` and `exitCode` (only when its text states one),
 * always. The output only when `withOutput`, and then only when the call produced text to read.
 */
export function finishedEntry(failed: boolean, text: string | null, withOutput: boolean): Partial<ActivityEntry> {
  const code = failed ? parseExitCode(text) : null;
  const status: Partial<ActivityEntry> = { done: true, ...(failed ? { failed: true } : {}), ...(code === null ? {} : { exitCode: code }) };
  if (!withOutput || text === null) return status;
  const o = outputDetail(text);
  return { output: o.text, ...(o.cut ? { outputCut: true } : {}), ...status };
}
