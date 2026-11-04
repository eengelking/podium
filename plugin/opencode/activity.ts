// What an activity-feed entry holds for an OpenCode tool call (#118, #431, #969). Pure. The wording is the Claude Code reporter's
// (`core/failures.ts` `activityCall`), so the console reads the same for both: OpenCode's tool names and argument names are put
// into the ones that function knows. The limits, the redaction and the clean-up of a command and its output are `core/feed.ts`.
import { activityCall, parseExitCode } from '../core/failures.ts';
import { commandDetail, outputDetail } from '../core/feed.ts';
import type { ActivityEntry } from '../core/protocol.ts';

/** OpenCode's tool name, as the Claude Code reporter names the same kind of tool. Anything else keeps its own name. */
const NAMES: Record<string, string> = { bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', glob: 'Glob', grep: 'Grep', task: 'Agent', skill: 'Skill', patch: 'Edit' };

/** The tool and its arguments under the names `activityCall` reads. */
function canonical(tool: string, input: Record<string, unknown>): { tool: string; input: Record<string, unknown> } {
  const name = NAMES[tool] ?? tool;
  const out: Record<string, unknown> = { ...input };
  if (typeof input.filePath === 'string' && out.file_path === undefined) out.file_path = input.filePath;
  if (name === 'Skill' && typeof input.name === 'string' && out.skill === undefined) out.skill = input.name;
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
