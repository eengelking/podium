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
    // `id` names the TUI part, so the server part knows when the last one has left (#1029). A TUI part with no id counts as one.
    attach: {
      input: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
      output: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
    },
    // The TUI part is closing (#1029): when it was the last one, the server part ends the sessions that are quiet at once, not after the attach time limit and the idle wait.
    detach: {
      input: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
      output: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
    },
    // The TUI part says it showed the Admin callout `id` (#1051): until it does, the server part offers the callout again, so a toast sent to a TUI part
    // that was gone, or not yet listening, is not counted as shown.
    shown: {
      input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
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
        properties: { title: { type: 'string' }, message: { type: 'string' }, variant: { type: 'string' }, duration: { type: 'number' }, id: { type: 'string' }, admin: { type: 'boolean' } },
        required: ['message'],
      },
    },
    // `/podium config` (#1001): the reporter's live settings, for the TUI part to show in its settings window (configWindow.ts). It opens the
    // window and changes nothing; there is deliberately no method that writes a setting, as any caller of OpenCode's API could call one.
    config: {
      schema: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          host: { type: 'string' },
          path: { type: ['string', 'null'] },
          rows: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, value: { type: 'string' }, lock: { type: ['string', 'null'] } }, required: ['id', 'value', 'lock'] } },
        },
        required: ['host', 'path', 'rows'],
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
  /** How long the toast stays, in milliseconds; the host's own default when absent. */
  duration?: number;
  /** For an Admin callout (#1051): its id, which the TUI part sends back through `shown` once it has shown it, and the mark that it must not be lost to another toast. */
  id?: string;
  admin?: boolean;
}

/** The connection's status line the TUI part shows in the prompt's footer. */
export interface StatusEvent {
  text: string;
}
