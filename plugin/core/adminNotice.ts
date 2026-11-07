// The callout an Admin's reading or stopping of the person's Podium conversation shows the person (#1034, PROJECT.md "An Admin Never Reads in Silence").
// It is one content-free sentence from Podium, shown to the person only (a toast and a transcript line, as each harness does them). It is never a prompt,
// a turn, a tool result or system text: the model does not need it and must not be handed it. No `$` here; the harnesses do the showing.
import type { AdminNotice } from './protocol.ts';
import { oneLine } from './peers.ts';

const TEXT_MAX = 300;
/** How many ids are remembered to show each notice once; the server hands one over for a few minutes, so a short memory is enough. */
const SEEN_KEPT = 100;

/** Remembers which notices were shown, so a notice the server keeps handing over is shown once. */
export class AdminNoticeSeen {
  private readonly ids = new Set<string>();

  constructor(private readonly kept = SEEN_KEPT) {}

  /** The notices of a reply not shown before, oldest first. */
  fresh(list: readonly AdminNotice[]): AdminNotice[] {
    const out: AdminNotice[] = [];
    for (const n of list) {
      if (this.ids.has(n.id)) continue;
      this.ids.add(n.id);
      out.push(n);
    }
    for (const id of this.ids) {
      if (this.ids.size <= this.kept) break;
      this.ids.delete(id);
    }
    return out;
  }
}

/** The sentence, on one line. */
export const adminNoticeLine = (n: AdminNotice): string => oneLine(n.text, TEXT_MAX);

/** The toast: it says whom it is from, since a toast stands alone. */
export const adminNoticeToast = (n: AdminNotice): string => `Podium: ${adminNoticeLine(n)}`;

/** The line that stays where a harness has no transcript (the console log), so a toast missed is still on record. */
export const adminNoticeKeptLine = (n: AdminNotice): string => `podium-reporter: ${adminNoticeLine(n)}`;

/** How long the toast stays up: long enough to be read away from the keyboard. */
export const ADMIN_NOTICE_TOAST_MS = 60_000;
