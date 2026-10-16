import { z } from "zod";

import { TestStepSchema } from "./step-types.js";

// Shared zod entity schemas (PLAN §4 + §15). IPC payloads derive from these;
// inner main/renderer code trusts only the parsed type (parse, don't validate).

const idField = z.string().min(1).max(100);
const nameField = z.string().trim().min(1).max(200);
const millisField = z.number().int().min(0);

export const RunModeSchema = z.enum(["supervised", "unsupervised"]);
export type RunMode = z.infer<typeof RunModeSchema>;

export const SuiteRunStatusSchema = z.enum(["pending", "running", "passed", "failed", "cancelled"]);
export type SuiteRunStatus = z.infer<typeof SuiteRunStatusSchema>;

export const CaseRunStatusSchema = z.enum([
  "pending",
  "running",
  "passed",
  "failed",
  "skipped",
  "cancelled",
]);
export type CaseRunStatus = z.infer<typeof CaseRunStatusSchema>;

export const TestDataSourceSchema = z.enum(["kv", "csv"]);
export type TestDataSource = z.infer<typeof TestDataSourceSchema>;

export const ProjectSchema = z.object({
  id: idField,
  name: nameField,
  baseUrl: z.string().trim().max(2000).optional(),
  createdAt: millisField,
});
export type Project = z.infer<typeof ProjectSchema>;

export const SuiteSchema = z.object({
  id: idField,
  projectId: idField,
  name: nameField,
  createdAt: millisField,
});
export type Suite = z.infer<typeof SuiteSchema>;

export const TestCaseSchema = z.object({
  id: idField,
  projectId: idField,
  name: nameField,
  description: z.string().max(5000).optional(),
  url: z.string().trim().max(2000).optional(),
  createdAt: millisField,
});
export type TestCase = z.infer<typeof TestCaseSchema>;

export const StepRowSchema = TestStepSchema.extend({
  id: idField,
  caseId: idField,
  editedAt: millisField,
});
export type StepRow = z.infer<typeof StepRowSchema>;

export const TestDataRowSchema = z.object({
  caseId: idField,
  key: z.string().regex(/^\w+$/, "key must match \\w+ (letters, digits, underscore)"),
  value: z.string().max(10000),
  source: TestDataSourceSchema,
});
export type TestDataRow = z.infer<typeof TestDataRowSchema>;

export const SuiteRunSchema = z.object({
  id: idField,
  suiteId: idField.nullable(),
  mode: RunModeSchema,
  status: SuiteRunStatusSchema,
  startedAt: millisField,
  endedAt: millisField.nullable(),
  reportHtmlPath: z.string().max(4000).nullable(),
  reportPdfPath: z.string().max(4000).nullable(),
});
export type SuiteRun = z.infer<typeof SuiteRunSchema>;

export const CaseRunSchema = z.object({
  id: idField,
  suiteRunId: idField,
  caseId: idField,
  status: CaseRunStatusSchema,
  durationMs: millisField.nullable(),
  videoPath: z.string().max(4000).nullable(),
});
export type CaseRun = z.infer<typeof CaseRunSchema>;

export const StepRunSchema = z.object({
  id: idField,
  caseRunId: idField,
  stepId: idField,
  order: z.number().int().min(0),
  // Reuses the short step status vocabulary (pass/fail/skipped/running).
  status: z.enum(["pass", "fail", "skipped", "running"]),
  error: z.string().max(20000).nullable(),
  screenshotPath: z.string().max(4000).nullable(),
  durationMs: millisField.nullable(),
});
export type StepRun = z.infer<typeof StepRunSchema>;
