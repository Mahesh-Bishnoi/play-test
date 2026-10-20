/**
 * Live run progress (M21). A read-only snapshot of one suite/case run derived
 * from the run tables — no runner state, no artifacts, no Electron. The
 * renderer's suite panel, global run strip, and report banner poll this while a
 * run is active; every query is an indexed lookup, so a ~1 s cadence is cheap.
 *
 * Suite progress is deliberately case-level: queued cases have no step_runs
 * yet, and counting test_steps here would go stale when the user edits steps
 * mid-run. Single-case step progress is derived in the renderer from the live
 * `run:step-update` stream instead.
 */

import { eq, inArray } from "drizzle-orm";

import type { RunCaseProgress, RunProgress } from "../shared/ipc-contract.js";
import type { AppDatabase } from "./db.js";
import { caseRuns, suiteRuns, testCases, testSuites } from "./schema.js";

/** Thrown when `runner:getProgress` names a suite run that does not exist. */
export class RunNotFoundError extends Error {
  constructor(suiteRunId: string) {
    super(`suite run not found: ${suiteRunId}`);
    this.name = "RunNotFoundError";
  }
}

/**
 * True while a run can still change. The report handler regenerates its HTML
 * for these runs so the in-app Refresh button never serves a stale snapshot.
 */
export function isRunActive(db: AppDatabase, suiteRunId: string): boolean {
  const row = db.select().from(suiteRuns).where(eq(suiteRuns.id, suiteRunId)).all()[0];
  return row !== undefined && (row.status === "pending" || row.status === "running");
}

/**
 * Aggregate one run into the renderer's live progress model. Cases keep a
 * deterministic name order so a polled list never reshuffles while the run is
 * in flight.
 */
export function getRunProgress(db: AppDatabase, suiteRunId: string): RunProgress {
  const suiteRow = db.select().from(suiteRuns).where(eq(suiteRuns.id, suiteRunId)).all()[0];
  if (suiteRow === undefined) {
    throw new RunNotFoundError(suiteRunId);
  }

  let suiteName: string | null = null;
  if (suiteRow.suiteId !== null) {
    suiteName =
      db.select().from(testSuites).where(eq(testSuites.id, suiteRow.suiteId)).all()[0]?.name ??
      null;
  }

  const caseRows = db
    .select()
    .from(caseRuns)
    .where(eq(caseRuns.suiteRunId, suiteRunId))
    .orderBy(caseRuns.caseId)
    .all();
  const caseIds = [...new Set(caseRows.map((row) => row.caseId))];
  const caseById = new Map(
    (caseIds.length === 0
      ? []
      : db.select().from(testCases).where(inArray(testCases.id, caseIds)).all()
    ).map((row) => [row.id, row] as const),
  );

  const cases: RunCaseProgress[] = caseRows.map((row) => ({
    caseRunId: row.id,
    caseId: row.caseId,
    // Deleting cases is blocked while a run is live; the fallback keeps a
    // historical snapshot readable if a case was removed anyway.
    caseName: caseById.get(row.caseId)?.name ?? row.caseId,
    status: row.status as RunCaseProgress["status"],
    durationMs: row.durationMs,
  }));

  const total = cases.length;
  const passed = cases.filter((c) => c.status === "passed").length;
  const failed = cases.filter((c) => c.status === "failed").length;
  const cancelled = cases.filter((c) => c.status === "cancelled").length;
  const skipped = cases.filter((c) => c.status === "skipped").length;
  const pending = cases.filter((c) => c.status === "pending").length;
  const running = cases.filter((c) => c.status === "running").length;
  // Derive completion instead of summing the buckets: an unexpected status
  // string must never make a finished run look partially complete.
  const completed = Math.max(0, total - pending - running);

  return {
    suiteRunId: suiteRow.id,
    suiteId: suiteRow.suiteId,
    suiteName,
    mode: suiteRow.mode as RunProgress["mode"],
    status: suiteRow.status as RunProgress["status"],
    startedAt: suiteRow.startedAt,
    endedAt: suiteRow.endedAt,
    cases,
    summary: { total, completed, pending, running, passed, failed, cancelled, skipped },
  };
}
