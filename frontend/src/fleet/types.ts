// The wire types are defined once, in the server (SPEC 7.4). The UI imports them as types, and a few pure helpers
// that must agree with the server (`idleOnBackground`) as values.
export type {
  ActivityEntry,
  ActivityView,
  AgentView,
  BackgroundTask,
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
  MachineInfo,
  ModelFamily,
  OwnerSpend,
  Plan,
  PlanStep,
  PlanStepView,
  PlanView,
  RemovedReason,
  SessionStatusView,
  SessionView,
  StateBody,
  UpdateNotice,
  WallSettingsView,
  Ask,
  AskDetail,
  AskKind,
  AskQuestion,
  AskState,
  AskSummary,
  Delivery,
  DeliveryKind,
  DeliveryView,
  PlanMode,
  QuestionAnswer,
  RespondInfo,
  RespondKind,
  RespondMe,
  FileDiffReply,
  FileDiffStatus,
  PeerLevel,
  PeerRequest,
  ReporterCompat,
  RecordingAdminRow,
  RecordingGrant,
  RecordingKind,
  RecordingLoopInfo,
  RecordingPage,
  RecordingRow,
  RecordingSettings,
  RecordingState,
  RecordingView,
} from "../../../server/src/fleet/protocol";
export type { ActivityEntryView, ActivityReply } from "../../../server/src/fleet/activity";
export type { ActivityHistoryNote, ActivityHistoryPage, ActivityHistoryPolicy } from "../../../server/src/fleet/activityHistoryTypes";

/** The product name, kept in one place so it can change (SPEC 12.10). */
export const APP_NAME = "Podium";
export const COPYRIGHT = "© 2026 Ed Engelking";
const REPO = "https://github.com/eengelking/podium/blob/main";
export const LICENSE_URL = `${REPO}/LICENSE`;
export const GOTCHAS_URL = `${REPO}/docs/GOTCHAS.md#a-session-shows-no-plan`;
export const NOTICES_URL = `${REPO}/docs/THIRD_PARTY_NOTICES.md`;
