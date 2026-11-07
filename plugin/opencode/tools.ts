// The tools the reporter adds to OpenCode's model through `ctx.tool.transform` (#969): `plan`, and the four messaging tools. Each takes plain
// JSON Schema for its input (a `ValueSchema` may be one) and answers with text. The descriptions are `core/peers.ts`'s, the same as Claude
// Code's. A tool never throws: whatever goes wrong is its answer.
import { CHAT_READ_BEFORE_DESCRIPTION, CHAT_READ_CHANNEL_DESCRIPTION, SEND_TO_DESCRIPTION, TOOL_DESCRIPTIONS } from '../core/peers.ts';
import type { Reporter } from './reporter.ts';

/** The names of the messaging tools: removed from the host when Podium stops saying the session takes part. */
export const MESSAGING_TOOLS = ['podium_peers', 'podium_send', 'podium_request_access', 'podium_chat_read'] as const;

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
  const peerTool = (name: (typeof MESSAGING_TOOLS)[number]) => async (input: unknown, c: { sessionID: string }) => text(await reporter.peerTool(name, c.sessionID, input).catch(() => 'Not done. The reporter could not finish this call; /podium shows the connection.'));
  tools.push(
    { name: 'podium_peers', description: TOOL_DESCRIPTIONS.peers, input: { type: 'object', properties: {} }, execute: peerTool('podium_peers') },
    {
      name: 'podium_send',
      description: TOOL_DESCRIPTIONS.send,
      input: {
        type: 'object',
        properties: { to: { type: 'string', description: SEND_TO_DESCRIPTION }, text: { type: 'string', description: 'The message' } },
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
    {
      name: 'podium_chat_read',
      description: TOOL_DESCRIPTIONS.chatRead,
      input: {
        type: 'object',
        properties: { channel: { type: 'string', enum: ['general', 'group'], description: CHAT_READ_CHANNEL_DESCRIPTION }, before: { type: 'string', description: CHAT_READ_BEFORE_DESCRIPTION } },
        required: ['channel'],
      },
      execute: peerTool('podium_chat_read'),
    },
  );
  return tools;
}
