// The peer store on PostgreSQL (#822). Not ported yet: every method rejects until this file is filled in.
import type { PeerStoreApi, PeerStoreOptions } from '../types.js';
import type { PgDb } from './conn.js';
import { notPorted } from './notPorted.js';

export const pgPeers = (_db: PgDb, _opts: PeerStoreOptions): PeerStoreApi => notPorted<PeerStoreApi>('peers');
