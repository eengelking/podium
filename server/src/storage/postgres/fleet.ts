// The fleet store on PostgreSQL (#822): sessions, agents, events, samples, spend and the report queries. Not ported yet: every method
// rejects until this file is filled in.
import type { FleetStore } from '../types.js';
import type { PgDb } from './conn.js';
import { notPorted } from './notPorted.js';

export const pgFleet = (_db: PgDb): FleetStore => notPorted<FleetStore>('fleet store');
