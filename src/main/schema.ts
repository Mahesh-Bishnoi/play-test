import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Drizzle SQLite tables (PLAN §4). Column names are the contract —
// shared zod schemas validate shapes, these tables persist them.
// Timestamps are unix-ms integers (Date.now()) for easy duration math.

// No FK constraints by design (MVP): services enforce ownership
// (projectId scoping, join-table cleanup) so deletes never hit
// surprise FK violations; a later migration can add them with cascades.

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  baseUrl: text("base_url"),
  createdAt: integer("created_at").notNull(),
});

export const testSuites = sqliteTable("test_suites", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const testCases = sqliteTable("test_cases", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  url: text("url"),
  createdAt: integer("created_at").notNull(),
});

export const suiteTestCases = sqliteTable(
  "suite_test_cases",
  {
    suiteId: text("suite_id").notNull(),
    caseId: text("case_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.suiteId, t.caseId] })],
);

export const testSteps = sqliteTable("test_steps", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull(),
  order: integer("order").notNull(),
  action: text("action").notNull(),
  selector: text("selector"),
  value: text("value"),
  timeoutMs: integer("timeout_ms"),
  editedAt: integer("edited_at").notNull(),
});

export const testData = sqliteTable(
  "test_data",
  {
    caseId: text("case_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    source: text("source").notNull().default("kv"),
  },
  (t) => [primaryKey({ columns: [t.caseId, t.key] })],
);

// Per-case recording/run environment (M14). One row per case at most; no row
// means defaults. `case_id` is the PK (no FK by convention — services delete).
export const caseProfiles = sqliteTable("case_profiles", {
  caseId: text("case_id").primaryKey(),
  device: text("device"),
  viewportW: integer("viewport_w"),
  viewportH: integer("viewport_h"),
  colorScheme: text("color_scheme"),
  locale: text("locale"),
  timezone: text("timezone"),
  storageState: text("storage_state"),
  saveStorageState: text("save_storage_state"),
  dialogPolicy: text("dialog_policy"),
  updatedAt: integer("updated_at").notNull(),
});

export const suiteRuns = sqliteTable("suite_runs", {
  id: text("id").primaryKey(),
  suiteId: text("suite_id"),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
  reportHtmlPath: text("report_html_path"),
  reportPdfPath: text("report_pdf_path"),
});

export const caseRuns = sqliteTable("case_runs", {
  id: text("id").primaryKey(),
  suiteRunId: text("suite_run_id").notNull(),
  caseId: text("case_id").notNull(),
  status: text("status").notNull(),
  durationMs: integer("duration_ms"),
  videoPath: text("video_path"),
});

export const stepRuns = sqliteTable("step_runs", {
  id: text("id").primaryKey(),
  caseRunId: text("case_run_id").notNull(),
  stepId: text("step_id").notNull(),
  order: integer("order").notNull(),
  status: text("status").notNull(),
  error: text("error"),
  screenshotPath: text("screenshot_path"),
  durationMs: integer("duration_ms"),
});
