// The model prices on PostgreSQL (#822). Not ported yet: every method rejects until this file is filled in.
import type { ModelPricesApi } from '../types.js';
import type { PgDb } from './conn.js';
import { notPorted } from './notPorted.js';

export const pgModelPrices = (_db: PgDb): ModelPricesApi => notPorted<ModelPricesApi>('model prices');
