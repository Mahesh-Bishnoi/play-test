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

// Case profile (M14, SPECS §4): the recording/run environment persisted per
// case. Field validators are shared with the recorder options (ipc-contract) so
// there is exactly one dialect. No row == defaults (1280x720, no auth).

/** Playwright device-preset name — same shape the codegen argv builder accepts. */
export const DeviceNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^(?![-])(?!.*--)[A-Za-z0-9 _.()/+-]+$/, "unsafe device name");

/** BCP47-like locale, e.g. `en-GB` (maps to codegen `--lang`). */
export const LocaleSchema = z
  .string()
  .min(2)
  .max(20)
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "locale must be BCP47-like, e.g. en-GB");

/** IANA-like timezone, e.g. `Europe/Rome`. */
export const TimezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^(?!.*\.\.)(?!-)[A-Za-z0-9_+/-]+$/, "timezone must be IANA-like, e.g. Europe/Rome");

/** Bare filename of an auth state file under `~/PlayTestData/<projectId>/auth/`. */
export const AuthStateFilenameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    "auth state must be a bare filename, e.g. login.json",
  );

export const ProfileDialogPolicySchema = z.enum(["default", "accept", "dismiss"]);
export type ProfileDialogPolicy = z.infer<typeof ProfileDialogPolicySchema>;

/**
 * Mutable profile fields. Absent field == not configured; absent `storageState`
 * means no auth state is loaded, absent `saveStorageState` means none is saved,
 * absent `sessionState` means no sessionStorage is seeded at run start.
 */
export const CaseProfileInputSchema = z.object({
  device: DeviceNameSchema.optional(),
  viewportW: z.number().int().min(100).max(7680).optional(),
  viewportH: z.number().int().min(100).max(4320).optional(),
  colorScheme: z.enum(["light", "dark"]).optional(),
  locale: LocaleSchema.optional(),
  timezone: TimezoneSchema.optional(),
  storageState: AuthStateFilenameSchema.optional(),
  saveStorageState: AuthStateFilenameSchema.optional(),
  sessionState: AuthStateFilenameSchema.optional(),
  dialogPolicy: ProfileDialogPolicySchema.optional(),
});
export type CaseProfileInput = z.infer<typeof CaseProfileInputSchema>;

/** Persisted profile row (M14) — `updatedAt` is server-set on write. */
export const CaseProfileSchema = CaseProfileInputSchema.extend({
  caseId: idField,
  updatedAt: millisField,
});
export type CaseProfile = z.infer<typeof CaseProfileSchema>;

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
