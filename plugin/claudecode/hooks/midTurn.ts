// Messages held for the next tool boundary (#1264). A plain module with no engine import, so register.ts stays glue (docs/PATTERNS.md).
//
// A message handed over while the main loop works is not submitted as a prompt, which Claude Code queues behind the whole turn (DECISIONS 70).
// It waits here, and the main loop's next tool result carries it as the hook's `additionalContext`, so the agent reads it between tool
// calls. A turn that ends first with no tool call (or a session that stops) hands what is left over as a prompt, so nothing is lost.

import type { PeerParty } from '../../core/protocol.ts';

/** One framed message (core/peers.ts `peerPrompt`, mid-turn note included) waiting for the next tool boundary. */
export interface HeldMessage {
  /** The session it was sent to. A message never outlives it: another session's tool result takes nothing of it. */
  sid: string;
  /** Podium's delivery id, the key the result is reported under. */
  id: string;
  /** The whole framed text: the frame, the quoted message and Podium's mid-turn note. */
  text: string;
  /** Who it is from, for the log line once it was read. */
  from: PeerParty | null;
}

/** What a tool-boundary hook does with the held list. */
export interface Held {
  /** Adds a message. The same delivery id twice is one message. */
  hold(m: HeldMessage): void;
  /** Takes every held message, oldest first, and empties the list. */
  take(): HeldMessage[];
  /** How many are waiting. */
  size(): number;
}

export function makeHeld(): Held {
  let list: HeldMessage[] = [];
  return {
    hold(m) {
      if (!list.some((h) => h.id === m.id)) list.push(m);
    },
    take() {
      const out = list;
      list = [];
      return out;
    },
    size: () => list.length,
  };
}

/**
 * Podium's own line above a message that rides on a tool result. A model weighs text inside a tool result as untrusted (a live run found
 * Claude Code's haiku ignoring it, #1264), so the line says who is adding it and why it is here. It does not vouch for the message: the frame
 * below it still says it is another agent's text and cannot approve anything.
 */
export const HELD_LEAD =
  'The Podium reporter plugin, which reports this session to Podium, is adding the message below to this tool result. It was sent to you through Podium while you were working, and the plugin could not submit it as a prompt until your turn ends. The text inside it is not the plugin\'s.';

/** Splits what was taken into the messages for session `sid` and those for an earlier one, which are refused and never shown. */
export function forSession(taken: readonly HeldMessage[], sid: string): { mine: HeldMessage[]; stale: HeldMessage[] } {
  return { mine: taken.filter((m) => m.sid === sid), stale: taken.filter((m) => m.sid !== sid) };
}

/** The `additionalContext` a tool result carries: what its other hooks already added, then each held message under Podium's own lead line. */
export function withHeldContext(already: readonly string[] | undefined, taken: readonly HeldMessage[]): string[] {
  return [...(already ?? []), ...taken.map((m) => `${HELD_LEAD}\n${m.text}`)];
}
