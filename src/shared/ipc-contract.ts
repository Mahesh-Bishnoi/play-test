import { z } from "zod";

import { RunModeSchema } from "./schema.js";
import { StepStatusSchema } from "./step-types.js";
import { TestStepSchema } from "./step-types.js";

// Frozen IPC contract v1 (PLAN §5). Renderer ↔ main via ipcMain.handle;
// streaming via webContents.send. WS4/WS5/WS6 code runner/recorder/report
// payloads against these shapes — do not change without a ledger entry.

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
  "recorder:start",
  "recorder:stop",
  "runner:runSingle",
  "runner:runSuite",
  "runner:resumeFromStep",
  "runner:rerunFailed",
  "runner:cancel",
  "report:getHtml",
  "report:exportPdf",
  "run:step-update",
  "run:log",
  "run:finished",
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

const idPayload = z.object({ id: z.string().min(1).max(100) });

// --- Projects / suites / cases -------------------------------------------

export const ProjectCreatePayload = z.object({
  name: z.string().trim().min(1).max(200),
  baseUrl: z.string().trim().max(2000).optional(),
});

export const ProjectListPayload = z.object({});

export const ProjectUpdatePayload = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(200).optional(),
  baseUrl: z.string().trim().max(2000).nullable().optional(),
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
  url: z.string().trim().max(2000).optional(),
});

export const CaseListPayload = z.object({
  projectId: z.string().min(1).max(100),
});

export const CaseUpdatePayload = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  url: z.string().trim().max(2000).nullable().optional(),
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

export const RecorderStartPayload = z.object({
  baseUrl: z.string().trim().min(1).max(2000),
});

export const RecorderStopPayload = z.object({});

// --- Runner (WS5) ------------------------------------------------------------

export const RunnerRunSinglePayload = z.object({
  caseId: z.string().min(1).max(100),
  mode: RunModeSchema,
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

export const RunnerCancelPayload = z.object({
  suiteRunId: z.string().min(1).max(100),
});

// --- Reports (WS6) -------------------------------------------------------------

export const ReportGetHtmlPayload = z.object({
  suiteRunId: z.string().min(1).max(100),
});

export const ReportExportPdfPayload = z.object({
  suiteRunId: z.string().min(1).max(100),
});

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
export type RecorderStartPayload = z.infer<typeof RecorderStartPayload>;
export type RecorderStopPayload = z.infer<typeof RecorderStopPayload>;
export type RunnerRunSinglePayload = z.infer<typeof RunnerRunSinglePayload>;
export type RunnerRunSuitePayload = z.infer<typeof RunnerRunSuitePayload>;
export type RunnerResumePayload = z.infer<typeof RunnerResumePayload>;
export type RunnerRerunFailedPayload = z.infer<typeof RunnerRerunFailedPayload>;
export type RunnerCancelPayload = z.infer<typeof RunnerCancelPayload>;
export type ReportGetHtmlPayload = z.infer<typeof ReportGetHtmlPayload>;
export type ReportExportPdfPayload = z.infer<typeof ReportExportPdfPayload>;
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
  "recorder:start": RecorderStartPayload,
  "recorder:stop": RecorderStopPayload,
  "runner:runSingle": RunnerRunSinglePayload,
  "runner:runSuite": RunnerRunSuitePayload,
  "runner:resumeFromStep": RunnerResumePayload,
  "runner:rerunFailed": RunnerRerunFailedPayload,
  "runner:cancel": RunnerCancelPayload,
  "report:getHtml": ReportGetHtmlPayload,
  "report:exportPdf": ReportExportPdfPayload,
};
