// The person certificates on PostgreSQL (#822). Not ported yet: every method rejects until this file is filled in.
import type { PersonCertsApi } from '../types.js';
import type { PgDb } from './conn.js';
import { notPorted } from './notPorted.js';

export const pgPersonCerts = (_db: PgDb): PersonCertsApi => notPorted<PersonCertsApi>('person certificates');
