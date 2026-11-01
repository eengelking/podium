// The feature flags on PostgreSQL (#822). Not ported yet: every method rejects until this file is filled in.
import type { FeatureFlagsApi } from '../types.js';
import type { PgDb } from './conn.js';
import { notPorted } from './notPorted.js';

export const pgFeatureFlags = (_db: PgDb): FeatureFlagsApi => notPorted<FeatureFlagsApi>('feature flags');
