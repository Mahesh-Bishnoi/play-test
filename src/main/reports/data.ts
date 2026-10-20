import { existsSync } from "node:fs";

import { eq, inArray } from "drizzle-orm";

import type { AppDatabase } from "../db.js";
import { caseTracePath } from "../artifacts.js";
import { caseRuns, stepRuns, suiteRuns, testCases, testSteps, testSuites } from "../schema.js";

/**
 * Suite reports (WS6, PLAN §9). Electron-free so vitest covers it directly:
 * aggregate run rows from the db, render a single self-contained HTML file
 * (inline CSS, no CDN), and persist html/pdf paths back to `suite_runs`.
 * PDF *rendering* (HTML → bytes) lives in main.ts (hidden BrowserWindow);
 * this module only writes the bytes to disk.
 */

export interface ReportStep {
  order: number;
  /** Test-step id (stable reference even when the step was deleted since). */
  stepId: string;
  action: string;
  selector: string | null;
  value: string | null;
  status: "pass" | "fail" | "skipped" | "running";
  error: string | null;
  screenshotPath: string | null;
  durationMs: number | null;
}

export interface ReportCase {
  caseRunId: string;
  caseId: string;
  caseName: string;
  status: string;
  durationMs: number | null;
  videoPath: string | null;
  /** Derived from the artifacts layout (no DB column — §18.6 forbids migrations). */
  tracePath: string | null;
  steps: ReportStep[];
}

export interface ReportSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface SuiteReport {
  suiteRunId: string;
  suiteName: string | null;
  mode: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  summary: ReportSummary;
  cases: ReportCase[];
}

/** Thrown when a suite-run id has no row. */
export class SuiteRunNotFoundError extends Error {
  constructor(suiteRunId: string) {
    super(`suite run not found: ${suiteRunId}`);
    this.name = "SuiteRunNotFoundError";
  }
}

/** Aggregate one suite run (single-case or parallel) into a report model. */
export function getSuiteReport(
  db: AppDatabase,
  suiteRunId: string,
  artifactsRoot?: string,
  pathExists: (path: string) => boolean = existsSync,
): SuiteReport {
  const suiteRow = db.select().from(suiteRuns).where(eq(suiteRuns.id, suiteRunId)).all()[0];
  if (suiteRow === undefined) {
    throw new SuiteRunNotFoundError(suiteRunId);
  }
  let suiteName: string | null = null;
  if (suiteRow.suiteId !== null) {
    suiteName =
      db.select().from(testSuites).where(eq(testSuites.id, suiteRow.suiteId)).all()[0]?.name ??
      null;
  }
  const caseRows = db.select().from(caseRuns).where(eq(caseRuns.suiteRunId, suiteRunId)).all();
  // Batched lookups: one query for this run's step_runs, one for its
  // test_steps, one for its test_cases — never the whole tables, never N+1.
  const caseRunIds = caseRows.map((cr) => cr.id);
  const stepRunRows =
    caseRunIds.length === 0
      ? []
      : db.select().from(stepRuns).where(inArray(stepRuns.caseRunId, caseRunIds)).all();
  const stepRowsByCaseRun = new Map<string, typeof stepRunRows>();
  for (const sr of stepRunRows) {
    const list = stepRowsByCaseRun.get(sr.caseRunId) ?? [];
    list.push(sr);
    stepRowsByCaseRun.set(sr.caseRunId, list);
  }
  for (const list of stepRowsByCaseRun.values()) {
    list.sort((a, b) => a.order - b.order);
  }
  const stepIds = [...new Set(stepRunRows.map((s) => s.stepId))];
  const stepById = new Map(
    (stepIds.length === 0
      ? []
      : db.select().from(testSteps).where(inArray(testSteps.id, stepIds)).all()
    ).map((s) => [s.id, s] as const),
  );
  const caseIds = [...new Set(caseRows.map((cr) => cr.caseId))];
  const caseById = new Map(
    (caseIds.length === 0
      ? []
      : db.select().from(testCases).where(inArray(testCases.id, caseIds)).all()
    ).map((c) => [c.id, c] as const),
  );
  const cases: ReportCase[] = caseRows.map((cr) => {
    const testCase = caseById.get(cr.caseId);
    const stepRows = stepRowsByCaseRun.get(cr.id) ?? [];
    return {
      caseRunId: cr.id,
      caseId: cr.caseId,
      caseName: testCase?.name ?? cr.caseId,
      status: cr.status,
      durationMs: cr.durationMs,
      videoPath: cr.videoPath,
      tracePath: resolveCaseTracePath(
        testCase?.projectId ?? null,
        suiteRow,
        cr.caseId,
        artifactsRoot,
        pathExists,
      ),
      steps: stepRows.map((s) => {
        const step = stepById.get(s.stepId);
        return {
          order: s.order,
          stepId: s.stepId,
          action: step?.action ?? "step",
          selector: step?.selector ?? null,
          value: step?.value ?? null,
          status: s.status as ReportStep["status"],
          error: s.error,
          screenshotPath: s.screenshotPath,
          durationMs: s.durationMs,
        };
      }),
    };
  });
  const passed = cases.filter((c) => c.status === "passed").length;
  const failed = cases.filter((c) => c.status === "failed").length;
  // Contract summary has no cancelled/running buckets — cancellation counts as
  // skipped, and a mid-run preview's pending/running cases do too. The M21 live
  // progress panel is the place for the accurate split.
  const skipped = cases.length - passed - failed;
  return {
    suiteRunId,
    suiteName,
    mode: suiteRow.mode,
    status: suiteRow.status,
    startedAt: suiteRow.startedAt,
    endedAt: suiteRow.endedAt,
    summary: { total: cases.length, passed, failed, skipped },
    cases,
  };
}

/**
 * Derive a case's `trace.zip` from the artifacts layout (PLAN §18.1, no DB
 * migration). Returns the absolute path when `artifactsRoot` is given and
 * the file exists, else null (passing runs discard traces; orphan cases
 * without a project fall back to the run's owning project).
 */
function resolveCaseTracePath(
  projectId: string | null,
  suiteRow: { id: string; suiteId: string | null },
  caseId: string,
  artifactsRoot: string | undefined,
  pathExists: (path: string) => boolean,
): string | null {
  if (artifactsRoot === undefined) {
    return null;
  }
  const owner = projectId ?? "unknown";
  const candidate = caseTracePath(artifactsRoot, owner, suiteRow.id, caseId);
  try {
    return pathExists(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/** Project id owning a suite run — for report placement under its artifacts dir. */
export function resolveReportProjectId(db: AppDatabase, suiteRunId: string): string {
  const suiteRow = db.select().from(suiteRuns).where(eq(suiteRuns.id, suiteRunId)).all()[0];
  if (suiteRow === undefined) {
    throw new SuiteRunNotFoundError(suiteRunId);
  }
  if (suiteRow.suiteId !== null) {
    const suite = db.select().from(testSuites).where(eq(testSuites.id, suiteRow.suiteId)).all()[0];
    if (suite !== undefined) {
      return suite.projectId;
    }
  }
  const firstCase = db.select().from(caseRuns).where(eq(caseRuns.suiteRunId, suiteRunId)).all()[0];
  if (firstCase !== undefined) {
    const testCase = db.select().from(testCases).where(eq(testCases.id, firstCase.caseId)).all()[0];
    if (testCase !== undefined) {
      return testCase.projectId;
    }
  }
  return "unknown";
}
