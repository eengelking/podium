// The reporters on PostgreSQL (#822). Not ported yet: every method rejects until this file is filled in.
import type { ReporterStoreApi } from '../types.js';
import type { PgDb } from './conn.js';
import { notPorted } from './notPorted.js';

export const pgReporters = (_db: PgDb): ReporterStoreApi => notPorted<ReporterStoreApi>('reporters');
