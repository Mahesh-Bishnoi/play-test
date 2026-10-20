import { z } from "zod";

import {
  CaseProfileInputSchema,
  CaseRunStatusSchema,
  DeviceNameSchema,
  HttpUrlSchema,
  LocaleSchema,
  RunModeSchema,
  SuiteRunStatusSchema,
  TimezoneSchema,
} from "./schema.js";
import { StepStatusSchema } from "./step-types.js";
import { TestStepSchema } from "./step-types.js";

// Frozen IPC contract v1 (PLAN §5). Renderer ↔ main via ipcMain.handle;
// streaming via webContents.send. WS4/WS5/WS6 code runner/recorder/report
// payloads against these shapes — do not change without a ledger entry.
//
// M7 additive extension (PLAN §11 first-run browser install): the two
// `system:*` channels below are new; every pre-M7 channel is untouched.

export const IPC_CHANNELS = [
  "project:create",
  "project:list",
  "project:get",
  "project:update",
  "project:delete",
  "suite:create",
  "suite:list",
  "suite:get",
  "suite:update",
  "suite:delete",
  "suite:setCases",
  "case:create",
  "case:list",
  "case:get",
  "case:update",
  "case:delete",
  "step:upsert",
  "step:move",
  "step:delete",
  "step:reorder",
  "testdata:get",
  "testdata:set",
  "profile:get",
  "profile:set",
  "recorder:start",
  "recorder:stop",
  "runner:runSingle",
  "runner:runSuite",
  "runner:resumeFromStep",
  "runner:rerunFailed",
  "runner:rerunLastFailed",
  "runner:cancel",
  "runner:getProgress",
  "report:getHtml",
  "report:exportPdf",
  "report:openTrace",
  "transfer:exportProject",
  "transfer:exportSuite",
  "transfer:exportCase",
  "transfer:importProject",
  "transfer:importSuite",
  "transfer:importCase",
  "sync:init",
  "sync:commit",
  "sync:push",
  "sync:pull",
  "sync:status",
  "sync:branch",
  "sync:resolve",
  "sync:clone",
  "system:browserStatus",
  "system:installBrowser",
  "run:step-update",
  "run:log",
  "run:finished",
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

const idPayload = z.object({ id: z.string().min(1).max(100) });

// --- Projects / suites / cases -------------------------------------------

export const ProjectCreatePayload = z.object({
  name: z.string().trim().min(1).max(200),
  baseUrl: HttpUrlSchema.optional(),
});

export const ProjectListPayload = z.object({});

export const ProjectUpdatePayload = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(200).optional(),
  baseUrl: HttpUrlSchema.nullable().optional(),
});

export const SuiteCreatePayload = z.object({
  projectId: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(200),
});

export const SuiteListPayload = z.object({
  projectId: z.string().min(1).max(100),
});

export const SuiteUpdatePayload = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(200).optional(),
});

export const SuiteSetCasesPayload = z.object({
  suiteId: z.string().min(1).max(100),
  caseIds: z.array(z.string().min(1).max(100)).max(1000),
});

export const CaseCreatePayload = z.object({
  projectId: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional(),
  url: HttpUrlSchema.optional(),
});

export const CaseListPayload = z.object({
  projectId: z.string().min(1).max(100),
});

export const CaseUpdatePayload = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  url: HttpUrlSchema.nullable().optional(),
});

// --- Steps / test data -----------------------------------------------------

export const StepUpsertPayload = z.object({
  caseId: z.string().min(1).max(100),
  step: TestStepSchema,
});

export const StepMovePayload = z.object({
  caseId: z.string().min(1).max(100),
  id: z.string().min(1).max(100),
  toOrder: z.number().int().min(0),
});

export const StepDeletePayload = z.object({
  caseId: z.string().min(1).max(100),
  id: z.string().min(1).max(100),
});

export const StepReorderPayload = z.object({
  caseId: z.string().min(1).max(100),
  orderedIds: z.array(z.string().min(1).max(100)).max(5000),
});

export const TestDataGetPayload = z.object({
  caseId: z.string().min(1).max(100),
});

export const TestDataSetPayload = z.object({
  caseId: z.string().min(1).max(100),
  data: z
    .record(z.string(), z.string().max(10000))
    .refine(
      (entries) =>
        Object.keys(entries).every((k) => /^\w+$/.test(k)) && Object.keys(entries).length <= 500,
      "keys must match \\w+, max 500 entries",
    ),
});

// --- Recorder (WS4) ----------------------------------------------------------

// M14 (SPECS §2/§5): the renderer no longer sends emulation/auth options —
// `recorder:start({caseId})` names the case and main resolves project baseUrl +
// the case profile into `RecorderStartOptions`. Field validators are shared
// with the profile schema (one dialect). Flag mapping verified against
// `npx playwright codegen --help` (playwright@1.64.1): viewport →
// --viewport-size "W,H" (comma, NOT WxH), device → --device, colorScheme →
// --color-scheme, locale → --lang (there is no --locale flag), timezone →
// --timezone, storageStatePath → --load-storage, saveStoragePath → --save-storage.
// Values must never look like flags (no leading `-`): even though spawn
// uses an argv array (no shell), minimist would still eat a `--foo` value
// as a flag — so shape checks below reject them at the trust boundary.
//
// M15 (SPECS §2/§5): `recorder:stop` also reports `unsupported` — codegen
// lines the parser could not map to a step (unknown `page.*` / `expect(...)`
// statements). They are surfaced to the user to add as manual steps instead of
// being silently converted to a `wait` step.

const noFlagPrefix = (label: string) =>
  z
    .string()
    .min(1)
    .max(1000)
    .refine((s) => !s.startsWith("-") && !s.includes("\0"), `${label} must not start with '-'`);

export const RecorderViewportPayload = z.object({
  width: z.number().int().min(100).max(7680),
  height: z.number().int().min(100).max(4320),
});

/** Resolved emulation/auth options main builds from the case profile (M14). */
export const RecorderStartOptionsSchema = z.object({
  viewport: RecorderViewportPayload.optional(),
  device: DeviceNameSchema.optional(),
  colorScheme: z.enum(["light", "dark"]).optional(),
  locale: LocaleSchema.optional(),
  timezone: TimezoneSchema.optional(),
  storageStatePath: noFlagPrefix("storageStatePath").optional(),
  saveStoragePath: noFlagPrefix("saveStoragePath").optional(),
});

/** `recorder:start` now names only the case; main resolves the rest (M14). */
export const RecorderStartPayload = z.object({
  caseId: z.string().min(1).max(100),
});

export const RecorderStopPayload = z.object({});

/**
 * One codegen line the parser could not map to a step (M15). `line` is the
 * trimmed statement, `reason` a short human explanation — both shown in the
 * import preview so the user adds a manual step.
 */
export const RecorderUnsupportedSchema = z.object({
  line: z.string().max(10000),
  reason: z.string().max(1000),
});

/**
 * `recorder:stop` return envelope (M15): parsed steps + the lines that could
 * not be mapped + the raw codegen file for debugging.
 */
export const RecorderStopResultSchema = z.object({
  steps: z.array(TestStepSchema),
  unsupported: z.array(RecorderUnsupportedSchema),
  raw: z.string(),
});

// --- Case profile (M14) ------------------------------------------------------

export const ProfileGetPayload = z.object({
  caseId: z.string().min(1).max(100),
});

export const ProfileSetPayload = z.object({
  caseId: z.string().min(1).max(100),
  profile: CaseProfileInputSchema,
});

// --- Runner (WS5) ------------------------------------------------------------

export const RunnerRunSinglePayload = z.object({
  caseId: z.string().min(1).max(100),
  mode: RunModeSchema,
  // Pre-run pacing for supervised runs (PLAN §8): ms to wait between steps so
  // the headed browser can be followed. Omitted = 0 (previous behavior).
  actionDelayMs: z.number().int().min(0).max(10000).optional(),
});

export const RunnerRunSuitePayload = z.object({
  suiteId: z.string().min(1).max(100),
  caseIds: z.array(z.string().min(1).max(100)).min(1).max(1000),
  mode: z.literal("unsupervised"),
});

export const RunnerResumePayload = z.object({
  caseRunId: z.string().min(1).max(100),
  fromOrder: z.number().int().min(0),
});

export const RunnerRerunFailedPayload = z.object({
  suiteRunId: z.string().min(1).max(100),
});

export const RunnerRerunLastFailedPayload = z.object({
  suiteId: z.string().min(1).max(100),
});

export const RunnerCancelPayload = z.object({
  suiteRunId: z.string().min(1).max(100),
});

/**
 * Read-only live progress for one run (M21). Polled by the suite/case progress
 * panels while a run is active; the query is a handful of indexed lookups, so
 * this stays cheap at a ~1 s cadence.
 */
export const RunnerGetProgressPayload = z.object({
  suiteRunId: z.string().min(1).max(100),
});

export const RunCaseProgressSchema = z.object({
  caseRunId: z.string().min(1).max(100),
  caseId: z.string().min(1).max(100),
  /** Case name at query time; falls back to the case id if the row vanished. */
  caseName: z.string().min(1).max(200),
  status: CaseRunStatusSchema,
  durationMs: z.number().int().min(0).nullable(),
});

export const RunProgressSchema = z.object({
  suiteRunId: z.string().min(1).max(100),
  suiteId: z.string().min(1).max(100).nullable(),
  suiteName: z.string().min(1).max(200).nullable(),
  mode: RunModeSchema,
  status: SuiteRunStatusSchema,
  startedAt: z.number().int().min(0),
  endedAt: z.number().int().min(0).nullable(),
  cases: z.array(RunCaseProgressSchema),
  summary: z.object({
    total: z.number().int().min(0),
    completed: z.number().int().min(0),
    pending: z.number().int().min(0),
    running: z.number().int().min(0),
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    cancelled: z.number().int().min(0),
    skipped: z.number().int().min(0),
  }),
});

// --- Reports (WS6) -------------------------------------------------------------

export const ReportGetHtmlPayload = z.object({
  suiteRunId: z.string().min(1).max(100),
});

export const ReportExportPdfPayload = z.object({
  suiteRunId: z.string().min(1).max(100),
});

export const ReportOpenTracePayload = z.union([
  z.object({ caseRunId: z.string().min(1).max(100) }),
  z.object({ tracePath: z.string().min(1).max(1000) }),
]);

// --- Transfer: file import/export (copy semantics — fresh ids on import) -------

export const TransferExportProjectPayload = z.object({
  id: z.string().min(1).max(100),
});

export const TransferExportSuitePayload = z.object({
  id: z.string().min(1).max(100),
});

export const TransferExportCasePayload = z.object({
  id: z.string().min(1).max(100),
});

export const TransferImportProjectPayload = z.object({});

export const TransferImportSuitePayload = z.object({
  projectId: z.string().min(1).max(100),
});

export const TransferImportCasePayload = z.object({
  projectId: z.string().min(1).max(100),
  suiteIds: z.array(z.string().min(1).max(100)).max(100).optional(),
});

// --- Sync: local-git project sync (Phase 2 core) ----------------------------
// Local-path remotes only; http(s) URLs are rejected by the service.

const syncDir = z.string().min(1).max(1000);
const syncBranchName = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/,
    "invalid branch name",
  );

export const SyncAuthorPayload = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().min(1).max(200),
});

export const SyncInitPayload = z.object({
  projectId: z.string().min(1).max(100),
  dir: syncDir,
  remoteUrl: z.string().min(1).max(1000).optional(),
  author: SyncAuthorPayload,
  branch: syncBranchName.optional(),
});

export const SyncCommitPayload = z.object({
  projectId: z.string().min(1).max(100),
  dir: syncDir,
  author: SyncAuthorPayload,
  message: z.string().trim().min(1).max(5000),
});

export const SyncPushPayload = z.object({
  dir: syncDir,
  remote: z.string().min(1).max(1000).optional(),
  branch: syncBranchName.optional(),
});

export const SyncPullPayload = z.object({
  projectId: z.string().min(1).max(100),
  dir: syncDir,
  remote: z.string().min(1).max(1000).optional(),
  branch: syncBranchName.optional(),
});

export const SyncStatusPayload = z.object({
  projectId: z.string().min(1).max(100),
  dir: syncDir,
});

export const SyncBranchPayload = z.object({
  dir: syncDir,
  name: syncBranchName,
});

export const SyncResolvePayload = z.object({
  projectId: z.string().min(1).max(100),
  dir: syncDir,
  entity: z.enum(["case", "suite", "project"]),
  id: z.string().min(1).max(100),
  winner: z.enum(["mine", "theirs"]),
});

export const SyncClonePayload = z.object({
  remoteUrl: z.string().min(1).max(1000),
  dir: syncDir,
  branch: syncBranchName.optional(),
});

// --- System (M7: first-run browser install, PLAN §11) -------------------------

export const SystemBrowserStatusPayload = z.object({});

export const SystemInstallBrowserPayload = z.object({});

// --- Streamed events (main → renderer) -----------------------------------------

export const RunStepUpdateEvent = z.object({
  caseRunId: z.string().min(1).max(100),
  order: z.number().int().min(0),
  status: StepStatusSchema,
});

export const RunLogEvent = z.object({
  level: z.enum(["info", "warn", "error"]),
  msg: z.string().max(10000),
});

export const RunFinishedEvent = z.object({
  suiteRunId: z.string().min(1).max(100),
  summary: z.object({
    total: z.number().int().min(0),
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    skipped: z.number().int().min(0),
  }),
});

export type ProjectCreatePayload = z.infer<typeof ProjectCreatePayload>;
export type ProjectListPayload = z.infer<typeof ProjectListPayload>;
export type ProjectUpdatePayload = z.infer<typeof ProjectUpdatePayload>;
export type SuiteCreatePayload = z.infer<typeof SuiteCreatePayload>;
export type SuiteListPayload = z.infer<typeof SuiteListPayload>;
export type SuiteUpdatePayload = z.infer<typeof SuiteUpdatePayload>;
export type SuiteSetCasesPayload = z.infer<typeof SuiteSetCasesPayload>;
export type CaseCreatePayload = z.infer<typeof CaseCreatePayload>;
export type CaseListPayload = z.infer<typeof CaseListPayload>;
export type CaseUpdatePayload = z.infer<typeof CaseUpdatePayload>;
export type StepUpsertPayload = z.infer<typeof StepUpsertPayload>;
export type StepMovePayload = z.infer<typeof StepMovePayload>;
export type StepDeletePayload = z.infer<typeof StepDeletePayload>;
export type StepReorderPayload = z.infer<typeof StepReorderPayload>;
export type TestDataGetPayload = z.infer<typeof TestDataGetPayload>;
export type TestDataSetPayload = z.infer<typeof TestDataSetPayload>;
export type ProfileGetPayload = z.infer<typeof ProfileGetPayload>;
export type ProfileSetPayload = z.infer<typeof ProfileSetPayload>;
export type RecorderStartPayload = z.infer<typeof RecorderStartPayload>;
/** Emulation/auth options resolved from the case profile in main (M14). */
export type RecorderStartOptions = z.infer<typeof RecorderStartOptionsSchema>;
export type RecorderStopPayload = z.infer<typeof RecorderStopPayload>;
/** One unmapped codegen line reported by `recorder:stop` (M15). */
export type RecorderUnsupported = z.infer<typeof RecorderUnsupportedSchema>;
/** `recorder:stop` return envelope (M15). */
export type RecorderStopResult = z.infer<typeof RecorderStopResultSchema>;
export type RunnerRunSinglePayload = z.infer<typeof RunnerRunSinglePayload>;
export type RunnerRunSuitePayload = z.infer<typeof RunnerRunSuitePayload>;
export type RunnerResumePayload = z.infer<typeof RunnerResumePayload>;
export type RunnerRerunFailedPayload = z.infer<typeof RunnerRerunFailedPayload>;
export type RunnerRerunLastFailedPayload = z.infer<typeof RunnerRerunLastFailedPayload>;
export type RunnerCancelPayload = z.infer<typeof RunnerCancelPayload>;
export type RunnerGetProgressPayload = z.infer<typeof RunnerGetProgressPayload>;
/** One case's live row in a progress snapshot (M21). */
export type RunCaseProgress = z.infer<typeof RunCaseProgressSchema>;
/** Live run snapshot returned by `runner:getProgress` (M21). */
export type RunProgress = z.infer<typeof RunProgressSchema>;
export type ReportGetHtmlPayload = z.infer<typeof ReportGetHtmlPayload>;
export type ReportExportPdfPayload = z.infer<typeof ReportExportPdfPayload>;
export type ReportOpenTracePayload = z.infer<typeof ReportOpenTracePayload>;
export type TransferExportProjectPayload = z.infer<typeof TransferExportProjectPayload>;
export type TransferExportSuitePayload = z.infer<typeof TransferExportSuitePayload>;
export type TransferExportCasePayload = z.infer<typeof TransferExportCasePayload>;
export type TransferImportProjectPayload = z.infer<typeof TransferImportProjectPayload>;
export type TransferImportSuitePayload = z.infer<typeof TransferImportSuitePayload>;
export type TransferImportCasePayload = z.infer<typeof TransferImportCasePayload>;
export type SyncInitPayload = z.infer<typeof SyncInitPayload>;
export type SyncCommitPayload = z.infer<typeof SyncCommitPayload>;
export type SyncPushPayload = z.infer<typeof SyncPushPayload>;
export type SyncPullPayload = z.infer<typeof SyncPullPayload>;
export type SyncStatusPayload = z.infer<typeof SyncStatusPayload>;
export type SyncBranchPayload = z.infer<typeof SyncBranchPayload>;
export type SyncResolvePayload = z.infer<typeof SyncResolvePayload>;
export type SyncClonePayload = z.infer<typeof SyncClonePayload>;
export type SystemBrowserStatusPayload = z.infer<typeof SystemBrowserStatusPayload>;
export type SystemInstallBrowserPayload = z.infer<typeof SystemInstallBrowserPayload>;
export type RunStepUpdateEvent = z.infer<typeof RunStepUpdateEvent>;
export type RunLogEvent = z.infer<typeof RunLogEvent>;
export type RunFinishedEvent = z.infer<typeof RunFinishedEvent>;

/** Payload schema per request channel — main validates every call with these. */
export const IPC_PAYLOADS: Record<string, z.ZodType> = {
  "project:create": ProjectCreatePayload,
  "project:list": ProjectListPayload,
  "project:get": idPayload,
  "project:update": ProjectUpdatePayload,
  "project:delete": idPayload,
  "suite:create": SuiteCreatePayload,
  "suite:list": SuiteListPayload,
  "suite:get": idPayload,
  "suite:update": SuiteUpdatePayload,
  "suite:delete": idPayload,
  "suite:setCases": SuiteSetCasesPayload,
  "case:create": CaseCreatePayload,
  "case:list": CaseListPayload,
  "case:get": idPayload,
  "case:update": CaseUpdatePayload,
  "case:delete": idPayload,
  "step:upsert": StepUpsertPayload,
  "step:move": StepMovePayload,
  "step:delete": StepDeletePayload,
  "step:reorder": StepReorderPayload,
  "testdata:get": TestDataGetPayload,
  "testdata:set": TestDataSetPayload,
  "profile:get": ProfileGetPayload,
  "profile:set": ProfileSetPayload,
  "recorder:start": RecorderStartPayload,
  "recorder:stop": RecorderStopPayload,
  "runner:runSingle": RunnerRunSinglePayload,
  "runner:runSuite": RunnerRunSuitePayload,
  "runner:resumeFromStep": RunnerResumePayload,
  "runner:rerunFailed": RunnerRerunFailedPayload,
  "runner:rerunLastFailed": RunnerRerunLastFailedPayload,
  "runner:cancel": RunnerCancelPayload,
  "runner:getProgress": RunnerGetProgressPayload,
  "report:getHtml": ReportGetHtmlPayload,
  "report:exportPdf": ReportExportPdfPayload,
  "report:openTrace": ReportOpenTracePayload,
  "transfer:exportProject": TransferExportProjectPayload,
  "transfer:exportSuite": TransferExportSuitePayload,
  "transfer:exportCase": TransferExportCasePayload,
  "transfer:importProject": TransferImportProjectPayload,
  "transfer:importSuite": TransferImportSuitePayload,
  "transfer:importCase": TransferImportCasePayload,
  "sync:init": SyncInitPayload,
  "sync:commit": SyncCommitPayload,
  "sync:push": SyncPushPayload,
  "sync:pull": SyncPullPayload,
  "sync:status": SyncStatusPayload,
  "sync:branch": SyncBranchPayload,
  "sync:resolve": SyncResolvePayload,
  "sync:clone": SyncClonePayload,
  "system:browserStatus": SystemBrowserStatusPayload,
  "system:installBrowser": SystemInstallBrowserPayload,
};
