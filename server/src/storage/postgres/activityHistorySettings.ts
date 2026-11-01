// The Activity history settings on PostgreSQL (#822). Not ported yet: every method rejects until this file is filled in.
import type { ActivityHistorySettingsApi } from '../types.js';
import type { PgDb } from './conn.js';
import { notPorted } from './notPorted.js';

export const pgActivityHistorySettings = (_db: PgDb, _authOn: boolean): ActivityHistorySettingsApi => notPorted<ActivityHistorySettingsApi>('activity history settings');
