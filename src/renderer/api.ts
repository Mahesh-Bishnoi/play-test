import { z } from "zod";

import type { IpcChannel } from "../shared/ipc-contract.js";
import {
  RecorderStopResultSchema,
  RunFinishedEvent,
  RunLogEvent,
  RunProgressSchema,
  RunStepUpdateEvent,
} from "../shared/ipc-contract.js";
import type {
  RecorderStopResult,
  RunFinishedEvent as RunFinished,
  RunLogEvent as RunLog,
  RunProgress,
  RunStepUpdateEvent as RunStepUpdate,
} from "../shared/ipc-contract.js";
import { CaseProfileSchema, StepRowSchema, SuiteSchema, TestCaseSchema } from "../shared/schema.js";
import { ProjectSchema } from "../shared/schema.js";
import type { CaseProfile, CaseProfileInput } from "../shared/schema.js";
import type { Project, StepRow, Suite, TestCase } from "../shared/schema.js";
import type { RunMode } from "../shared/schema.js";
import type { TestStep } from "../shared/step-types.js";

async function invoke<T>(
  channel: IpcChannel,
  payload: unknown,
  parse: (raw: unknown) => T,
): Promise<T> {
  const raw = await window.playtest.invoke(channel, payload);
  return parse(raw);
}

const SuiteDetailSchema = z.object({ suite: SuiteSchema, caseIds: z.array(z.string()) });
export interface SuiteDetail {
  suite: Suite;
  caseIds: string[];
}

const CaseDetailSchema = z.object({ case: TestCaseSchema, steps: z.array(StepRowSchema) });
export interface CaseDetail {
  case: TestCase;
  steps: StepRow[];
}

const BrowserStatusSchema = z.object({ installed: z.boolean(), executablePath: z.string() });

const ExportOutcomeSchema = z.object({ saved: z.boolean(), path: z.string().optional() });
export interface ExportOutcome {
  saved: boolean;
  path?: string;
}

const ImportSummarySchema = z.object({
  projectId: z.string(),
  suiteIds: z.array(z.string()),
  caseIds: z.array(z.string()),
  caseCount: z.number().int(),
  stepCount: z.number().int(),
});
const ImportOutcomeSchema = z.object({
  imported: z.boolean(),
  summary: ImportSummarySchema.optional(),
});
export interface ImportOutcome {
  imported: boolean;
  summary?: {
    projectId: string;
    suiteIds: string[];
    caseIds: string[];
    caseCount: number;
    stepCount: number;
  };
}

export interface SyncAuthorInput {
  name: string;
  email: string;
}

const SyncCommitResultSchema = z.object({ hash: z.string(), changed: z.array(z.string()) });
export interface SyncCommitResult {
  hash: string;
  changed: string[];
}

const SyncConflictSchema = z.object({
  entity: z.enum(["case", "suite", "project"]),
  id: z.string(),
  name: z.string(),
  remoteDeleted: z.boolean().optional(),
});
export interface SyncConflict {
  entity: "case" | "suite" | "project";
  id: string;
  name: string;
  remoteDeleted?: boolean;
}

const SyncPullResultSchema = z.object({
  applied: z.array(z.string()),
  conflicts: z.array(SyncConflictSchema),
});
export interface SyncPullResult {
  applied: string[];
  conflicts: SyncConflict[];
}

const SyncStatusResultSchema = z.object({
  branch: z.string(),
  local: z.string().nullable(),
  tracking: z.string().nullable(),
  ahead: z.number().int(),
  behind: z.number().int(),
  dirty: z.boolean(),
});
export interface SyncStatusResult {
  branch: string;
  local: string | null;
  tracking: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
}

const SyncPushResultSchema = z.object({ pushed: z.boolean(), hash: z.string() });

/** Shared renderer error formatter (single copy — pages/components import this). */
export function formatApiError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const api = {
  listProjects(): Promise<Project[]> {
    return invoke("project:list", {}, (raw) => z.array(ProjectSchema).parse(raw));
  },
  createProject(name: string, baseUrl?: string): Promise<Project> {
    return invoke(
      "project:create",
      { name, ...(baseUrl !== undefined ? { baseUrl } : {}) },
      (raw) => ProjectSchema.parse(raw),
    );
  },
  updateProject(id: string, patch: { name?: string; baseUrl?: string | null }): Promise<Project> {
    return invoke("project:update", { id, ...patch }, (raw) => ProjectSchema.parse(raw));
  },
  deleteProject(id: string): Promise<void> {
    return invoke("project:delete", { id }, () => undefined);
  },

  listSuites(projectId: string): Promise<Suite[]> {
    return invoke("suite:list", { projectId }, (raw) => z.array(SuiteSchema).parse(raw));
  },
  createSuite(projectId: string, name: string): Promise<Suite> {
    return invoke("suite:create", { projectId, name }, (raw) => SuiteSchema.parse(raw));
  },
  updateSuite(id: string, name: string): Promise<Suite> {
    return invoke("suite:update", { id, name }, (raw) => SuiteSchema.parse(raw));
  },
  deleteSuite(id: string): Promise<void> {
    return invoke("suite:delete", { id }, () => undefined);
  },
  getSuiteDetail(id: string): Promise<SuiteDetail> {
    return invoke("suite:get", { id }, (raw) => SuiteDetailSchema.parse(raw));
  },
  setSuiteCases(suiteId: string, caseIds: string[]): Promise<string[]> {
    return invoke("suite:setCases", { suiteId, caseIds }, (raw) => z.array(z.string()).parse(raw));
  },

  listCases(projectId: string): Promise<TestCase[]> {
    return invoke("case:list", { projectId }, (raw) => z.array(TestCaseSchema).parse(raw));
  },
  createCase(projectId: string, name: string): Promise<TestCase> {
    return invoke("case:create", { projectId, name }, (raw) => TestCaseSchema.parse(raw));
  },
  updateCase(id: string, patch: { name?: string; url?: string | null }): Promise<TestCase> {
    return invoke("case:update", { id, ...patch }, (raw) => TestCaseSchema.parse(raw));
  },
  deleteCase(id: string): Promise<void> {
    return invoke("case:delete", { id }, () => undefined);
  },
  getCaseDetail(id: string): Promise<CaseDetail> {
    return invoke("case:get", { id }, (raw) => CaseDetailSchema.parse(raw));
  },

  // Steps (WS3 editor; channels/handlers landed in WS2, payloads frozen in v1).
  upsertStep(caseId: string, step: TestStep): Promise<StepRow> {
    return invoke("step:upsert", { caseId, step }, (raw) => StepRowSchema.parse(raw));
  },
  moveStep(caseId: string, id: string, toOrder: number): Promise<StepRow> {
    return invoke("step:move", { caseId, id, toOrder }, (raw) => StepRowSchema.parse(raw));
  },
  deleteStep(caseId: string, id: string): Promise<void> {
    return invoke("step:delete", { caseId, id }, () => undefined);
  },
  reorderSteps(caseId: string, orderedIds: string[]): Promise<StepRow[]> {
    return invoke("step:reorder", { caseId, orderedIds }, (raw) =>
      z.array(StepRowSchema).parse(raw),
    );
  },
  getTestData(caseId: string): Promise<Record<string, string>> {
    return invoke("testdata:get", { caseId }, (raw) => z.record(z.string(), z.string()).parse(raw));
  },
  setTestData(caseId: string, data: Record<string, string>): Promise<Record<string, string>> {
    return invoke("testdata:set", { caseId, data }, (raw) =>
      z.record(z.string(), z.string()).parse(raw),
    );
  },

  // Case profile (M14; PLAN §M14 item 7): one persisted record-options row per
  // case, shared by the recorder and every run. `null` = no row / defaults.
  profileGet(caseId: string): Promise<CaseProfile | null> {
    return invoke(
      "profile:get",
      { caseId },
      (raw) => z.object({ profile: CaseProfileSchema.nullable() }).parse(raw).profile,
    );
  },
  profileSet(caseId: string, profile: CaseProfileInput): Promise<CaseProfile | null> {
    return invoke("profile:set", { caseId, profile }, (raw) =>
      CaseProfileSchema.nullable().parse(raw),
    );
  },

  // Recorder (WS4/M14; main resolves project baseUrl + the case profile).
  startRecorder(caseId: string): Promise<{ pid: number }> {
    return invoke("recorder:start", { caseId }, (raw) =>
      z.object({ pid: z.number().int() }).parse(raw),
    );
  },
  stopRecorder(): Promise<RecorderStopResult> {
    return invoke("recorder:stop", {}, (raw) => RecorderStopResultSchema.parse(raw));
  },

  // Runner (WS5; streams progress over run:* events, payloads frozen in v1).
  runSingleCase(
    caseId: string,
    mode: RunMode,
    actionDelayMs?: number,
  ): Promise<{ suiteRunId: string; caseRunId: string }> {
    return invoke(
      "runner:runSingle",
      actionDelayMs === undefined ? { caseId, mode } : { caseId, mode, actionDelayMs },
      (raw) => z.object({ suiteRunId: z.string(), caseRunId: z.string() }).parse(raw),
    );
  },
  resumeFromStep(
    caseRunId: string,
    fromOrder: number,
  ): Promise<{ suiteRunId: string; caseRunId: string }> {
    return invoke("runner:resumeFromStep", { caseRunId, fromOrder }, (raw) =>
      z.object({ suiteRunId: z.string(), caseRunId: z.string() }).parse(raw),
    );
  },
  cancelRun(suiteRunId: string): Promise<void> {
    return invoke("runner:cancel", { suiteRunId }, () => undefined);
  },
  /** Live progress snapshot for one run (M21). Polled only while it is active. */
  getRunProgress(suiteRunId: string): Promise<RunProgress> {
    return invoke("runner:getProgress", { suiteRunId }, (raw) => RunProgressSchema.parse(raw));
  },

  // Parallel suites (WS6/M6; unsupervised only, payloads frozen in v1).
  runSuite(suiteId: string, caseIds: string[]): Promise<{ suiteRunId: string }> {
    return invoke("runner:runSuite", { suiteId, caseIds, mode: "unsupervised" }, (raw) =>
      z.object({ suiteRunId: z.string() }).parse(raw),
    );
  },
  rerunFailed(suiteRunId: string): Promise<{ suiteRunId: string }> {
    return invoke("runner:rerunFailed", { suiteRunId }, (raw) =>
      z.object({ suiteRunId: z.string() }).parse(raw),
    );
  },
  rerunLastFailed(suiteId: string): Promise<{ suiteRunId: string }> {
    return invoke("runner:rerunLastFailed", { suiteId }, (raw) =>
      z.object({ suiteRunId: z.string() }).parse(raw),
    );
  },

  // Reports (WS6/M6; per suite run, payloads frozen in v1).
  getReportHtml(suiteRunId: string): Promise<string> {
    return invoke("report:getHtml", { suiteRunId }, (raw) => z.string().parse(raw));
  },
  exportReportPdf(suiteRunId: string): Promise<ExportOutcome> {
    return invoke("report:exportPdf", { suiteRunId }, (raw) => ExportOutcomeSchema.parse(raw));
  },
  openTrace(input: { caseRunId: string } | { tracePath: string }): Promise<{ opened: boolean }> {
    return invoke("report:openTrace", input, (raw) =>
      z.object({ opened: z.literal(true) }).parse(raw),
    );
  },

  // Transfer (file import/export; copy semantics — fresh ids on import).
  exportProject(id: string): Promise<ExportOutcome> {
    return invoke("transfer:exportProject", { id }, (raw) => ExportOutcomeSchema.parse(raw));
  },
  exportSuite(id: string): Promise<ExportOutcome> {
    return invoke("transfer:exportSuite", { id }, (raw) => ExportOutcomeSchema.parse(raw));
  },
  exportCase(id: string): Promise<ExportOutcome> {
    return invoke("transfer:exportCase", { id }, (raw) => ExportOutcomeSchema.parse(raw));
  },
  importProject(): Promise<ImportOutcome> {
    return invoke("transfer:importProject", {}, (raw) => ImportOutcomeSchema.parse(raw));
  },
  importSuite(projectId: string): Promise<ImportOutcome> {
    return invoke("transfer:importSuite", { projectId }, (raw) => ImportOutcomeSchema.parse(raw));
  },
  importCases(projectId: string, suiteIds?: string[]): Promise<ImportOutcome> {
    return invoke(
      "transfer:importCase",
      suiteIds === undefined ? { projectId } : { projectId, suiteIds },
      (raw) => ImportOutcomeSchema.parse(raw),
    );
  },

  // Sync (local-git project sync; stable ids — pull converges, never dupes).
  syncInit(
    projectId: string,
    dir: string,
    author: SyncAuthorInput,
    opts?: { remoteUrl?: string; branch?: string },
  ): Promise<SyncCommitResult> {
    return invoke("sync:init", { projectId, dir, author, ...opts }, (raw) =>
      SyncCommitResultSchema.parse(raw),
    );
  },
  syncCommit(
    projectId: string,
    dir: string,
    author: SyncAuthorInput,
    message: string,
  ): Promise<SyncCommitResult> {
    return invoke("sync:commit", { projectId, dir, author, message }, (raw) =>
      SyncCommitResultSchema.parse(raw),
    );
  },
  syncPush(
    dir: string,
    opts?: { remote?: string; branch?: string },
  ): Promise<{ pushed: boolean; hash: string }> {
    return invoke("sync:push", { dir, ...opts }, (raw) => SyncPushResultSchema.parse(raw));
  },
  syncPull(
    projectId: string,
    dir: string,
    opts?: { remote?: string; branch?: string },
  ): Promise<SyncPullResult> {
    return invoke("sync:pull", { projectId, dir, ...opts }, (raw) =>
      SyncPullResultSchema.parse(raw),
    );
  },
  syncStatus(projectId: string, dir: string): Promise<SyncStatusResult> {
    return invoke("sync:status", { projectId, dir }, (raw) => SyncStatusResultSchema.parse(raw));
  },
  syncBranch(dir: string, name: string): Promise<{ branch: string }> {
    return invoke("sync:branch", { dir, name }, (raw) =>
      z.object({ branch: z.string() }).parse(raw),
    );
  },
  syncResolve(
    projectId: string,
    dir: string,
    entity: "case" | "suite" | "project",
    id: string,
    winner: "mine" | "theirs",
  ): Promise<{ resolved: boolean }> {
    return invoke("sync:resolve", { projectId, dir, entity, id, winner }, (raw) =>
      z.object({ resolved: z.boolean() }).parse(raw),
    );
  },
  syncClone(remoteUrl: string, dir: string, branch?: string): Promise<{ projectId: string }> {
    return invoke(
      "sync:clone",
      branch === undefined ? { remoteUrl, dir } : { remoteUrl, dir, branch },
      (raw) => z.object({ projectId: z.string() }).parse(raw),
    );
  },

  // System (M7; first-run Chromium check + install, PLAN §11).
  browserStatus(): Promise<{ installed: boolean; executablePath: string }> {
    return invoke("system:browserStatus", {}, (raw) => BrowserStatusSchema.parse(raw));
  },
  installBrowser(): Promise<{ installed: boolean; executablePath: string }> {
    return invoke("system:installBrowser", {}, (raw) => BrowserStatusSchema.parse(raw));
  },
  onRunStepUpdate(listener: (event: RunStepUpdate) => void): () => void {
    return window.playtest.on("run:step-update", (raw) => {
      listener(RunStepUpdateEvent.parse(raw));
    });
  },
  onRunLog(listener: (event: RunLog) => void): () => void {
    return window.playtest.on("run:log", (raw) => {
      listener(RunLogEvent.parse(raw));
    });
  },
  onRunFinished(listener: (event: RunFinished) => void): () => void {
    return window.playtest.on("run:finished", (raw) => {
      listener(RunFinishedEvent.parse(raw));
    });
  },
};
