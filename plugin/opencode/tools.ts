// The tools the reporter adds to OpenCode's model through `ctx.tool.transform` (#969): `plan`, and the messaging tools. Each takes plain
// JSON Schema for its input (a `ValueSchema` may be one) and answers with text. What the messaging tools are is `core/peerTools.ts`, the
// same as Claude Code's. A tool never throws: whatever goes wrong is its answer.
import { PEER_TOOLS, peerToolDefinitions, type PeerToolName } from '../core/peerTools.ts';
import type { Reporter } from './reporter.ts';

/** The names of the messaging tools: removed from the host when Podium stops saying the session takes part. */
export const MESSAGING_TOOLS = Object.keys(PEER_TOOLS) as PeerToolName[];

export interface PodiumTool {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }>;
}

const text = (content: string): { content: string } => ({ content });

/** `plan` always; the messaging tools only when the person allowed them (`PODIUM_PEERS`), the host can submit a prompt and Podium says the session takes part (#987). */
export function podiumTools(reporter: Reporter): PodiumTool[] {
  const tools: PodiumTool[] = [
    {
      name: 'plan',
      description: 'Names the plan this session is working through, for the Podium fleet console. Call once with a short title when you start a multi-step plan.',
      input: { type: 'object', properties: { title: { type: 'string', description: 'Short plan title' }, phase: { type: 'string', description: 'Optional phase name' } }, required: ['title'] },
      execute: async (input, c) => text(reporter.namePlan(c.sessionID, input)),
    },
  ];
  if (!reporter.offersMessaging) return tools;
  for (const { name, description, inputSchema } of peerToolDefinitions()) {
    tools.push({
      name,
      description,
      input: inputSchema,
      execute: async (input, c) => text(await reporter.peerTool(name, c.sessionID, input).catch(() => 'Not done. The reporter could not finish this call; /podium shows the connection.')),
    });
  }
  return tools;
}
