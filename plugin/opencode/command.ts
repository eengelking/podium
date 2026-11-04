// The words `/podium` takes in OpenCode (#987, #969): which one was typed, and the text that answers it. Pure; index.ts passes what each
// word needs and shows the answer where the host allows (a toast).
import { contextArgs, nameArg } from '../core/podiumCommand.ts';
import { parseAnswer } from '../core/peers.ts';

export interface CommandDeps {
  /** `allow`, `decline` or `deliver` a messaging request. */
  answer: (answer: 'allow' | 'decline' | 'deliver', id: string) => Promise<string>;
  /** Names the session. */
  name: (name: string) => Promise<string>;
  /** `/podium context ...`, with what follows the word. */
  context: (args: string) => Promise<string>;
  /** The connection's status, and the requests waiting. */
  status: () => string;
}

/** The text the prompt of the command holds, without the command word. */
export const argsOf = (text: unknown): string => String(text ?? '').replace(/^\/?podium\b/i, '');

/** Runs what was typed after `/podium`. A word it does not know gives the status. */
export async function runPodium(args: string, d: CommandDeps): Promise<string> {
  const asked = parseAnswer(args);
  if (asked) return d.answer(asked.answer, asked.id);
  const context = contextArgs(args);
  if (context !== null) return d.context(context);
  const name = nameArg(args);
  if (name !== null) return d.name(name);
  return d.status();
}
