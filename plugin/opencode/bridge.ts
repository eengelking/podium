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
  },
} as const;

/** An answer the server part hands the TUI part. */
export interface AnswerEvent {
  sessionID: string;
  formID: string;
  answer: Record<string, string | string[]>;
}
