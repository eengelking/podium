// The wall's settings on PostgreSQL (#822). Not ported yet: every method rejects until this file is filled in.
import type { WallSettingsApi } from '../types.js';
import type { PgDb } from './conn.js';
import { notPorted } from './notPorted.js';

export const pgWallSettings = (_db: PgDb): WallSettingsApi => notPorted<WallSettingsApi>('wall settings');
