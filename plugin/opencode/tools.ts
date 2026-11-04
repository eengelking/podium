// The tools the reporter adds to OpenCode's model through `ctx.tool.transform` (#969): `plan`, and the three messaging tools. Each takes plain
// JSON Schema for its input (a `ValueSchema` may be one) and answers with text. The descriptions are `core/peers.ts`'s, the same as Claude
// Code's. A tool never throws: whatever goes wrong is its answer.
import { TOOL_DESCRIPTIONS } from '../core/peers.ts';
import type { Reporter } from './reporter.ts';

export interface PodiumTool {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }>;
}

const text = (content: string): { content: string } => ({ content });

/** `plan` always; the messaging tools only when the person allowed them (`PODIUM_PEERS`) and the host can submit a prompt. */
export function podiumTools(reporter: Reporter): PodiumTool[] {
  const tools: PodiumTool[] = [
    {
      name: 'plan',
      description: 'Names the plan this session is working through, for the Podium fleet console. Call once with a short title when you start a multi-step plan.',
      input: { type: 'object', properties: { title: { type: 'string', description: 'Short plan title' }, phase: { type: 'string', description: 'Optional phase name' } }, required: ['title'] },
      execute: async (input, c) => text(reporter.namePlan(c.sessionID, input)),
    },
  ];
  if (!reporter.messaging) return tools;
  const peerTool = (name: 'podium_peers' | 'podium_send' | 'podium_request_access') => async (input: unknown, c: { sessionID: string }) => text(await reporter.peerTool(name, c.sessionID, input).catch(() => 'Not done. The reporter could not finish this call; /podium shows the connection.'));
  tools.push(
    { name: 'podium_peers', description: TOOL_DESCRIPTIONS.peers, input: { type: 'object', properties: {} }, execute: peerTool('podium_peers') },
    {
      name: 'podium_send',
      description: TOOL_DESCRIPTIONS.send,
      input: {
        type: 'object',
        properties: { to: { type: 'string', description: 'The orchestrator, as "name@machine", or "name@machine#id" when podium_peers shows an id' }, text: { type: 'string', description: 'The message' } },
        required: ['to', 'text'],
      },
      execute: peerTool('podium_send'),
    },
    {
      name: 'podium_request_access',
      description: TOOL_DESCRIPTIONS.access,
      input: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'A machine, or "name@machine"' },
          right: { type: 'string', enum: ['see', 'send'], description: 'The right to ask for' },
          reason: { type: 'string', description: 'Why, in a sentence' },
        },
        required: ['to', 'right', 'reason'],
      },
      execute: peerTool('podium_request_access'),
    },
  );
  return tools;
}
