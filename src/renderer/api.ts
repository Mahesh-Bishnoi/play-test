import { z } from "zod";

import type { IpcChannel } from "../shared/ipc-contract.js";
import { StepRowSchema, SuiteSchema, TestCaseSchema } from "../shared/schema.js";
import { ProjectSchema } from "../shared/schema.js";
import type { Project, StepRow, Suite, TestCase } from "../shared/schema.js";
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
};
