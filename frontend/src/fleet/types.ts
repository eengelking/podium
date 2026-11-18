// The wire types are defined once, in the server (SPEC 7.4). The UI imports them as types, and a few pure helpers
// that must agree with the server (`idleOnBackground`) as values.
export type {
  ActivityView,
  AgentView,
  BackgroundItem,
  BackgroundWait,
  BlowoutLogEntry,
  ChangedFile,
  Effort,
  Failure,
  FilesReport,
  GitInfo,
  HistoryRow,
  Kpis,
  LifecycleConfig,
  ModelFamily,
  OwnerSpend,
  Plan,
  PlanStep,
  PlanStepView,
  PlanView,
  RemovedReason,
  SessionView,
  StateBody,
  UpdateNotice,
  WallSettingsView,
  Ask,
  AskDetail,
  AskKind,
  AskSummary,
  Delivery,
  PlanMode,
  QuestionAnswer,
  RespondKind,
  RespondMe,
  FileDiffReply,
  PeerLevel,
  PeerRequest,
  ReporterCompat,
  RecordingAdminRow,
  RecordingGrant,
  RecordingLoopInfo,
  RecordingPage,
  RecordingRow,
  RecordingSettings,
  RecordingView,
} from "../../../server/src/fleet/protocol";
export type { ActivityEntryView, ActivityReply } from "../../../server/src/fleet/activity";
export type { ActivityHistoryNote, ActivityHistoryPage } from "../../../server/src/fleet/activityHistoryTypes";

/** The product name, kept in one place so it can change (SPEC 12.10). */
export const APP_NAME = "Podium";
export const COPYRIGHT = "© 2026 Ed Engelking";
const REPO = "https://github.com/eengelking/podium/blob/main";
export const LICENSE_URL = `${REPO}/LICENSE`;
export const GOTCHAS_URL = `${REPO}/docs/gotchas/session-shows-no-plan.md`;
export const NOTICES_URL = `${REPO}/docs/THIRD_PARTY_NOTICES.md`;
