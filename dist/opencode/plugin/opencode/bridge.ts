// The RPC contract between the server part and the TUI part of the plugin (#858). The server part cannot answer a question form
// (OpenCode's server-side API has no form reply), and a TUI part can, so the server part hands it the answer as an event and the
// TUI part replies with `session.form.reply`. The TUI part also says it is there, so the console is not offered a question
// it could not get answered. Both parts import this file, so the two sides cannot disagree about the names.
export const BRIDGE_ID = 'podium-reporter';

/** How long a TUI part's `attach` counts as "attached". The TUI part says it again well within this. */
export const ATTACH_TTL_MS = 90_000;
export const ATTACH_EVERY_MS = 30_000;

export const BRIDGE = {
  id: BRIDGE_ID,
  methods: {
    attach: {
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
    },
  },
  events: {
    answer: {
      schema: {
        type: 'object',
        properties: { sessionID: { type: 'string' }, formID: { type: 'string' }, answer: { type: 'object' } },
        required: ['sessionID', 'formID', 'answer'],
      },
    },
    // A line for the person (#969): the connection's status, and the answer to `/podium`. The server part has no toast; the TUI part has.
    notice: {
      schema: {
        type: 'object',
        properties: { title: { type: 'string' }, message: { type: 'string' }, variant: { type: 'string' } },
        required: ['message'],
      },
    },
    // The connection's status line for the prompt's footer (#987), sent when its text changes (an empty text clears it) and when a TUI part attaches, so one that attaches late has it too (#999).
    status: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  },
} as const;

/** An answer the server part hands the TUI part. */
export interface AnswerEvent {
  sessionID: string;
  formID: string;
  answer: Record<string, string | string[]>;
}

/** A line the server part hands the TUI part to show as a toast. */
export interface NoticeEvent {
  title?: string;
  message: string;
  variant?: 'info' | 'success' | 'warning' | 'error';
}

/** The connection's status line the TUI part shows in the prompt's footer. */
export interface StatusEvent {
  text: string;
}
