// What app code reads from the SQLite adapter's own files without opening a database: row shapes, errors, constants and
// pure helpers (#313). App code imports these from here (or `types.ts`), never from `./sqlite/`, so the adapter stays the only
// place that names the database.
export { PeopleError, ADMIN_OWNER, ADMIN_SECRET_ACTOR, nameKey, sourceAddress } from './sqlite/people.js';
export type { PersonRow } from './sqlite/people.js';
export { NOTICES, isNoticeId } from './sqlite/wallSettings.js';
import { ReporterStore } from './sqlite/reporters.js';
export { REPORTER_STATES, REPORTING_MS } from './sqlite/reporters.js';
export type { ForgetSetting, IgnoreKind, IgnoreRule, IgnoreTarget, ReporterSeen, ReporterState } from './sqlite/reporters.js';
export { ACTIVITY_FEED, ACTIVITY_OUTPUT, FEATURES, FILE_DIFF, PEER_MESSAGING, RESPOND, SESSION_RECORDING, UPDATE_CHECK, featureDefault, isFeatureId } from './sqlite/featureFlags.js';
export { ROLLUP_KEEP_MS, SAME_USAGE } from './sqlite/db.js';
export type { AgentRow, BlowoutRow, CostOf, EventRow, RetentionPolicy, SampleRow, SessionRow } from './sqlite/db.js';
export { activityHistoryFieldError } from './sqlite/activityHistorySettings.js';
export { LEVEL_WORDS } from './sqlite/peerService.js';
export type { PeerReply } from './sqlite/peerService.js';
export type { PeerLimits } from './sqlite/peerSettings.js';
export type { SessionMeta } from './sqlite/activityHistory.js';
export type { RecordingTrail } from './sqlite/recordings.js';
export const keyOf = ReporterStore.keyOf;
