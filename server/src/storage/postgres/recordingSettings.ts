// The recording settings on PostgreSQL (#822). Not ported yet: every method rejects until this file is filled in.
import type { RecordingSettingsApi } from '../types.js';
import type { PgDb } from './conn.js';
import { notPorted } from './notPorted.js';

export const pgRecordingSettings = (_db: PgDb): RecordingSettingsApi => notPorted<RecordingSettingsApi>('recording settings');
