// What the report routes read from a running Fleet (#484): its database, clock, current prices and retention periods.
import type { Fleet } from './fleet.js';
import type { ReportDeps } from './reports.js';

export function reportDepsOf(fleet: Fleet): ReportDeps {
  return { db: fleet.db, tx: fleet.storage.tx, now: fleet.now, pricing: () => fleet.prices.pricing(), retention: fleet.cfg.retention };
}
