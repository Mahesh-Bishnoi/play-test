import { z } from "zod";

import type { IpcChannel } from "../shared/ipc-contract.js";
import { RunFinishedEvent, RunLogEvent, RunStepUpdateEvent } from "../shared/ipc-contract.js";
import type {
  RunFinishedEvent as RunFinished,
  RunLogEvent as RunLog,
  RunStepUpdateEvent as RunStepUpdate,
} from "../shared/ipc-contract.js";
import { StepRowSchema, SuiteSchema, TestCaseSchema } from "../shared/schema.js";
import { ProjectSchema } from "../shared/schema.js";
import type { Project, StepRow, Suite, TestCase } from "../shared/schema.js";
import type { RunMode } from "../shared/schema.js";
import { TestStepSchema } from "../shared/step-types.js";
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
  updateCase(id: string, patch: { name?: string }): Promise<TestCase> {
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

  // Recorder (WS4; handlers registered in main.ts, payloads frozen in v1).
  startRecorder(baseUrl: string): Promise<{ pid: number }> {
    return invoke("recorder:start", { baseUrl }, (raw) =>
      z.object({ pid: z.number().int() }).parse(raw),
    );
  },
  stopRecorder(): Promise<{ steps: TestStep[]; raw: string }> {
    return invoke("recorder:stop", {}, (raw) =>
      z.object({ steps: z.array(TestStepSchema), raw: z.string() }).parse(raw),
    );
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

  // Reports (WS6/M6; per suite run, payloads frozen in v1).
  getReportHtml(suiteRunId: string): Promise<string> {
    return invoke("report:getHtml", { suiteRunId }, (raw) => z.string().parse(raw));
  },
  exportReportPdf(suiteRunId: string): Promise<string> {
    return invoke("report:exportPdf", { suiteRunId }, (raw) => z.string().parse(raw));
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
