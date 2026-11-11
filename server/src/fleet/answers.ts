// How often sessions are answered from Podium, and how long they had waited (#725). Each answer taken from the console adds one to a daily count by harness, kind and wait
// class (see `answers_daily`). Only the kind, the day, the harness and the wait are kept: never what was said, who said it, or which session. An answer given in the
// terminal never reaches Podium, so it is not counted: this is how much the console is used to answer, not how many asks there were.
import type { SessionRow } from '../storage/rows.js';
import type { FleetStore } from '../storage/types.js';
import type { Logger } from '../logging/logger.js';
import { timeBucket } from './protocol.js';
import { localDay, type AnswerDay } from './rollups.js';

export type AnswerKind = AnswerDay['kind'];

/** The wait class of an answer that has no wait: a message goes to a session that is not waiting. */
export const NO_WAIT = -1;

/**
 * Counts one answer sent from Podium. `waitedMs` is how long the ask had been open (null for a message). A write that fails is logged and never fails the answer:
 * the person's answer has already been taken, and a figure on a report is not worth refusing it for.
 */
export async function noteAnswer(db: FleetStore, logger: Logger, row: SessionRow, kind: AnswerKind, waitedMs: number | null, at: number): Promise<void> {
  try {
    await db.addAnswer(localDay(at), row.harness || 'claude-code', kind, waitedMs === null ? NO_WAIT : timeBucket(waitedMs));
  } catch (err) {
    logger.warn('respond.count_failed', 'podium: could not count an answer sent from Podium', { session_id: row.id, error: String(err) });
  }
}
