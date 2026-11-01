// The TLS settings on PostgreSQL (#822). Not ported yet: every method rejects until this file is filled in.
import type { TlsSettingsApi } from '../types.js';
import type { PgDb } from './conn.js';
import { notPorted } from './notPorted.js';

export const pgTlsSettings = (_db: PgDb): TlsSettingsApi => notPorted<TlsSettingsApi>('TLS settings');
