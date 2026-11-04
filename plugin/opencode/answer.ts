// What an answer from Podium turns into for OpenCode (#858). Pure: no OpenCode API, no network. The asks Podium is shown (redacted
// and cut), the reply OpenCode takes for a permission, the answer object for a question form, and the text of a message.
import { clip, redact } from '../core/failures.ts';
import { RESPOND_LIMITS, type Ask as PodiumAsk, type AskQuestion, type Delivery, type QuestionAnswer } from '../core/protocol.ts';
import type { Ask, FormField, Root } from './state.ts';

/** The reply OpenCode takes for a permission. Podium never sends `always`: allowing once is the most a person at a console can grant. */
export type PermissionReply = 'once' | 'reject';

export const permissionReply = (kind: Delivery['kind']): PermissionReply | null => (kind === 'allow-once' ? 'once' : kind === 'deny' || kind === 'reply' ? 'reject' : null);

/** What the reporter says when Podium denies a tool without a reason. The same words as the Claude Code reporter. */
export const DENIED_FROM_PODIUM = 'Denied from Podium.';

/** The message that goes with a rejection: the reason or reply typed in Podium, or `DENIED_FROM_PODIUM` when there is none. Never sent with `once`. */
export const rejectMessage = (d: Pick<Delivery, 'text'>): string => (d.text ?? '').trim().slice(0, RESPOND_LIMITS.answer) || DENIED_FROM_PODIUM;

/** The loop an ask belongs to: null for the root session, the child session's id for a subagent. */
const agentOf = (a: Ask, root: Root): string | null => (a.sessionId === root.id ? null : a.sessionId);

/** A permission ask: the action as the tool name and the resources it names as its input. `cut` when anything did not fit, and then Podium cannot allow it. */
function permissionAsk(a: Ask, root: Root): PodiumAsk {
  const resources = (a.resources ?? []).map((r) => redact(r));
  const shown = resources.slice(0, 20).map((r) => (r.length > 1000 ? r.slice(0, 1000) : r));
  const cut = shown.length < resources.length || shown.some((r, i) => r !== resources[i]);
  return { id: a.id, kind: 'permission', agentId: agentOf(a, root), openedAt: a.openedAt, tool: { name: clip(a.action ?? 'permission', 120), input: { resources: shown }, cut } };
}

/** A question ask: one question per form field. Null when the form has no field, or more than a report can carry (it is then left to the terminal). */
function questionAsk(a: Ask, root: Root): PodiumAsk | null {
  const fields = a.fields ?? [];
  if (!fields.length || fields.length > RESPOND_LIMITS.questions) return null;
  const questions: AskQuestion[] = fields.map((f) => ({
    question: clip(f.description || f.title || f.key, RESPOND_LIMITS.question),
    header: clip(f.title || f.key, RESPOND_LIMITS.header),
    multiSelect: f.type === 'array',
    options: f.options.slice(0, RESPOND_LIMITS.options).map((o) => ({ label: clip(o.label, RESPOND_LIMITS.label), description: clip(o.description, RESPOND_LIMITS.description), preview: null })),
  }));
  return { id: a.id, kind: 'question', agentId: agentOf(a, root), openedAt: a.openedAt, questions };
}

/** The ask as Podium is told of it; null when Podium cannot answer it. */
export const podiumAsk = (a: Ask, root: Root): PodiumAsk | null => (a.kind === 'permission' ? permissionAsk(a, root) : questionAsk(a, root));

/**
 * The answer object OpenCode's form reply takes, keyed by field, from a delivery's answers by position. A skipped question is
 * left out. Null when an answer does not fit the form (an option that is not there, a typed answer a field does not allow, or
 * nothing at all), which is refused rather than guessed at.
 */
export function formAnswer(fields: readonly FormField[], answers: readonly QuestionAnswer[]): Record<string, string | string[]> | null {
  const out: Record<string, string | string[]> = {};
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    const a = answers[i];
    if (!a) continue;
    if ('text' in a) {
      if (!f.custom && f.options.length) return null;
      out[f.key] = clip(a.text, RESPOND_LIMITS.answer);
      continue;
    }
    // A position past the options Podium was shown is no option at all, even if the form has more.
    const values = a.options.map((n) => (n < RESPOND_LIMITS.options ? f.options[n]?.value : undefined));
    if (!values.length || values.some((v) => typeof v !== 'string')) return null;
    if (f.type !== 'array' && values.length > 1) return null;
    out[f.key] = f.type === 'array' ? (values as string[]) : (values[0] as string);
  }
  return Object.keys(out).length ? out : null;
}

/** A short summary of an answer for the recording and the transcript: the values joined with "; ". */
export const answerSummary = (answer: Record<string, string | string[]>): string => clip(Object.values(answer).map((v) => (Array.isArray(v) ? v.join(', ') : v)).join('; '), RESPOND_LIMITS.answer);

/**
 * The text a message reaches the model as. OpenCode hands a prompt over as an ordinary user message with no marker, so the
 * label is in the text: the model is told who wrote it and that it came through Podium, not from the person at the terminal.
 */
export function framedMessage(d: Pick<Delivery, 'by' | 'text'>): string {
  return `[Message from ${clip(d.by, 80)} via Podium, not typed at this terminal]\n\n${(d.text ?? '').slice(0, RESPOND_LIMITS.message)}`;
}

/**
 * What a recording keeps of an answer or approval from Podium (#353): which kind of ask it settled, what was chosen, and who sent it.
 * `failed` when it refused. The text is redacted by the recorder.
 */
export function decisionRecord(d: Delivery, ask: Ask): { name: 'permission' | 'question'; text: string; failed?: true; by: string } {
  if (ask.kind === 'permission') {
    if (d.kind === 'allow-once') return { name: 'permission', text: 'Allowed once', by: d.by };
    return { name: 'permission', text: `Denied: ${rejectMessage(d)}`, failed: true, by: d.by };
  }
  const answer = formAnswer(ask.fields ?? [], d.answers ?? []) ?? {};
  const titles = new Map((ask.fields ?? []).map((f) => [f.key, f.title || f.key]));
  const text = Object.entries(answer).map(([key, v]) => `${titles.get(key) ?? key}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n');
  return { name: 'question', text, by: d.by };
}
