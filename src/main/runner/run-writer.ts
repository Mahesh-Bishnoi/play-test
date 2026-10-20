/**
 * Shared run persistence + emit surface for both runners (PLAN §8). Holds the
 * db writes, `run:*` events, report finish and artifact best-effort helpers that
 * `SingleCaseRunner` and `SuiteRunner` used to carry as near-identical private
 * methods. No execution logic lives here.
 */

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { StepStatus } from "../../shared/step-types.js";
import { RunFinishedEvent, RunLogEvent, RunStepUpdateEvent } from "../../shared/ipc-contract.js";
import type { RunMode, StepRow } from "../../shared/schema.js";
import type { AppDatabase } from "../db.js";
import { caseRuns, stepRuns, suiteRuns } from "../schema.js";
import { tryWriteSuiteHtmlReport } from "../reports/files.js";
import type { EmitRunEvent, RunContext } from "./seams.js";
import { captureStepScreenshot } from "./step-evidence.js";

export type CaseRunRow = typeof caseRuns.$inferSelect;
export type StepRunRow = typeof stepRuns.$inferSelect;

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface RunWriterDeps {
  emit: EmitRunEvent;
  generateId?: () => string;
  now?: () => number;
}

export class RunWriter {
  private readonly db: AppDatabase;
  private readonly emit: EmitRunEvent;
  private readonly generateId: () => string;
  private readonly now: () => number;

  constructor(db: AppDatabase, deps: RunWriterDeps) {
    this.db = db;
    this.emit = deps.emit;
    this.generateId = deps.generateId ?? randomUUID;
    this.now = deps.now ?? Date.now;
  }

  createSuiteRun(run: {
    id: string;
    suiteId: string | null;
    mode: RunMode;
    startedAt: number;
  }): void {
    this.db
      .insert(suiteRuns)
      .values({
        id: run.id,
        suiteId: run.suiteId,
        mode: run.mode,
        status: "running",
        startedAt: run.startedAt,
      })
      .run();
  }

  createCaseRun(run: { id: string; suiteRunId: string; caseId: string }): void {
    this.db
      .insert(caseRuns)
      .values({ id: run.id, suiteRunId: run.suiteRunId, caseId: run.caseId, status: "running" })
      .run();
  }

  createStepRun(
    caseRunId: string,
    stepId: string,
    order: number,
    status: StepStatus,
    error: string | null,
  ): void {
    this.db
      .insert(stepRuns)
      .values({ id: this.generateId(), caseRunId, stepId, order, status, error })
      .run();
  }

  updateStepRun(
    caseRunId: string,
    stepId: string,
    status: StepStatus,
    error: string | null,
    screenshotPath: string,
    stepStarted: number,
  ): void {
    const rows = this.listStepRuns(caseRunId);
    const row = rows.find((r) => r.stepId === stepId);
    if (row === undefined) {
      return;
    }
    this.db
      .update(stepRuns)
      .set({
        status,
        error,
        screenshotPath,
        durationMs: this.now() - stepStarted,
      })
      .where(eq(stepRuns.id, row.id))
      .run();
  }

  clearStepRunsFrom(caseRunId: string, fromOrder: number): void {
    const rows = this.listStepRuns(caseRunId);
    for (const row of rows) {
      if (row.order >= fromOrder) {
        this.db.delete(stepRuns).where(eq(stepRuns.id, row.id)).run();
      }
    }
  }

  markSkippedFrom(caseRunId: string, steps: StepRow[], fromIndex: number): void {
    for (let index = fromIndex; index < steps.length; index++) {
      const step = steps[index];
      if (step === undefined) {
        break;
      }
      this.createStepRun(caseRunId, step.id, step.order, "skipped", null);
      this.emitStep(caseRunId, step.order, "skipped");
    }
  }

  listStepRuns(caseRunId: string): StepRunRow[] {
    return this.db.select().from(stepRuns).where(eq(stepRuns.caseRunId, caseRunId)).all();
  }

  listCaseRuns(suiteRunId: string): CaseRunRow[] {
    return this.db.select().from(caseRuns).where(eq(caseRuns.suiteRunId, suiteRunId)).all();
  }

  finishCaseRun(
    caseRunId: string,
    status: "passed" | "failed" | "cancelled",
    startedAt: number,
  ): void {
    this.db
      .update(caseRuns)
      .set({ status, durationMs: this.now() - startedAt })
      .where(eq(caseRuns.id, caseRunId))
      .run();
  }

  /**
   * Settle a case only if it is still "running". A crashed worker and the
   * suite's final reconciliation must never overwrite a row that already
   * settled (passed/failed/cancelled).
   */
  settleCaseIfRunning(
    caseRunId: string,
    status: "failed" | "cancelled",
    startedAt: number,
  ): boolean {
    const row = this.db.select().from(caseRuns).where(eq(caseRuns.id, caseRunId)).all()[0];
    if (row === undefined || row.status !== "running") {
      return false;
    }
    this.finishCaseRun(caseRunId, status, startedAt);
    return true;
  }

  /** Any step left "running" by a crashed worker becomes skipped, never pass. */
  skipRunningSteps(caseRunId: string): void {
    this.db
      .update(stepRuns)
      .set({ status: "skipped" })
      .where(and(eq(stepRuns.caseRunId, caseRunId), eq(stepRuns.status, "running")))
      .run();
  }

  finishSuiteRun(suiteRunId: string, status: "passed" | "failed" | "cancelled"): void {
    this.db
      .update(suiteRuns)
      .set({ status, endedAt: this.now() })
      .where(eq(suiteRuns.id, suiteRunId))
      .run();
  }

  setCaseVideoPath(caseRunId: string, videoPath: string): void {
    this.db.update(caseRuns).set({ videoPath }).where(eq(caseRuns.id, caseRunId)).run();
  }

  emitStep(caseRunId: string, order: number, status: StepStatus): void {
    this.emit("run:step-update", RunStepUpdateEvent.parse({ caseRunId, order, status }));
  }

  log(level: "info" | "warn" | "error", msg: string): void {
    this.emit("run:log", RunLogEvent.parse({ level, msg }));
  }

  emitFinished(suiteRunId: string, summary: RunSummary): void {
    this.emit("run:finished", RunFinishedEvent.parse({ suiteRunId, summary }));
  }

  finishRun(suiteRunId: string, summary: RunSummary, artifactsRoot: string): void {
    // Report write is evidence, not verdict: best-effort before the finished
    // event so the report page can link it immediately; a write failure warns.
    tryWriteSuiteHtmlReport(this.db, artifactsRoot, suiteRunId, (msg) => {
      this.log("warn", msg);
    });
    this.emitFinished(suiteRunId, summary);
  }

  // Screenshots are evidence, not verdicts: a failed capture warns, never
  // flips the step result. Awaited (not fire-and-forget) so artifacts exist
  // before the run settles — important for tests and the report page.
  async captureScreenshot(context: RunContext, path: string): Promise<void> {
    await captureStepScreenshot(context.page, path, (message) => this.log("warn", message));
  }

  async saveVideoQuietly(context: RunContext, dest: string): Promise<boolean> {
    try {
      await context.saveVideo(dest);
      return true;
    } catch {
      return false;
    }
  }

  async discardVideoQuietly(context: RunContext): Promise<void> {
    try {
      await context.discardVideo();
    } catch {
      // A leftover recording is harmless — the run still settles.
    }
  }
}
