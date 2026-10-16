import { cpus } from "node:os";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import type {
  RunnerCancelPayload,
  RunnerRerunFailedPayload,
  RunnerRunSuitePayload,
} from "../shared/ipc-contract.js";
import {
  RunFinishedEvent,
  RunLogEvent,
  RunnerCancelPayload as RunnerCancelSchema,
  RunnerRerunFailedPayload as RunnerRerunFailedSchema,
  RunnerRunSuitePayload as RunnerRunSuiteSchema,
  RunStepUpdateEvent,
} from "../shared/ipc-contract.js";
import type { StepRow } from "../shared/schema.js";
import { MissingTestDataKeyError } from "../shared/step-types.js";
import type { StepStatus } from "../shared/step-types.js";
import type { AppDatabase } from "./db.js";
import {
  caseTracePath,
  caseVideoPath,
  discardPath,
  ensureCaseDir,
  retainVideo,
  stepScreenshotPath,
} from "./artifacts.js";
import { getCase } from "./ipc-cases.js";
import { getSuite } from "./ipc-suites.js";
import { getTestData, listSteps } from "./ipc-steps.js";
import { tryWriteSuiteHtmlReport } from "./reports.js";
import { caseRuns, stepRuns, suiteRuns } from "./schema.js";
import type { BrowserLauncher, EmitRunEvent, RunContext } from "./runner.js";
import { executeStep, RunAlreadyActiveError, substituteStepValue } from "./runner.js";

/**
 * Parallel suite runner (WS5 part 2 / M6, PLAN §2 + §8). Unsupervised only,
 * headless, one browser per case, `workers = min(cpu/2, cases)`, suite-level
 * continue-on-failure (each case settles independently). Single-case
 * pause/resume semantics stay in `SingleCaseRunner` — suites never pause.
 *
 * Seams mirror `SingleCaseRunner` (injected launcher/emit/artifactsRoot/id/now)
 * so tests drive the pool with fake browsers and a tmp artifacts dir.
 */

export interface SuiteRunnerDeps {
  launchBrowser: BrowserLauncher;
  emit: EmitRunEvent;
  artifactsRoot: string;
  generateId?: () => string;
  now?: () => number;
  /** Wired by main.ts to the single runner so suites refuse while it is live. */
  isSingleActive?: () => boolean;
  /** Overridable worker count (tests force 2 on 1-case suites and vice versa). */
  workerCount?: (caseCount: number) => number;
}

export interface StartedSuiteRun {
  suiteRunId: string;
  /** Resolves when every case settles and the report is written (never rejects). */
  done: Promise<void>;
}

/** Thrown by rerunFailed when the source run has nothing failed to retry. */
export class NoFailedCasesError extends Error {
  constructor(suiteRunId: string) {
    super(`no failed cases to re-run for suite run: ${suiteRunId}`);
    this.name = "NoFailedCasesError";
  }
}

/** Default pool size: `min(cpu/2, cases)`, at least 1 (PLAN §2). */
export function defaultWorkerCount(caseCount: number): number {
  const half = Math.floor(cpus().length / 2);
  return Math.max(1, Math.min(half <= 0 ? 1 : half, Math.max(1, caseCount)));
}

export class SuiteRunner {
  private readonly db: AppDatabase;
  private readonly launchBrowser: BrowserLauncher;
  private readonly emit: EmitRunEvent;
  private readonly artifactsRoot: string;
  private readonly generateId: () => string;
  private readonly now: () => number;
  private readonly isSingleActive: () => boolean;
  private readonly workerCount: (caseCount: number) => number;
  private activeSuiteRunId: string | null = null;
  private readonly cancelled = new Set<string>();

  constructor(db: AppDatabase, deps: SuiteRunnerDeps) {
    this.db = db;
    this.launchBrowser = deps.launchBrowser;
    this.emit = deps.emit;
    this.artifactsRoot = deps.artifactsRoot;
    this.generateId = deps.generateId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.isSingleActive = deps.isSingleActive ?? (() => false);
    this.workerCount = deps.workerCount ?? defaultWorkerCount;
  }

  /** True while a parallel suite owns the browsers. */
  hasActiveRun(): boolean {
    return this.activeSuiteRunId !== null;
  }

  /**
   * Start an unsupervised parallel run over `caseIds`. Validates the suite +
   * every case, persists the run rows, and returns immediately — progress
   * streams over `run:step-update` / `run:log` / `run:finished`.
   */
  runSuite(input: RunnerRunSuitePayload): StartedSuiteRun {
    const parsed = RunnerRunSuiteSchema.parse(input);
    if (this.activeSuiteRunId !== null || this.isSingleActive()) {
      throw new RunAlreadyActiveError();
    }
    const suite = getSuite(this.db, parsed.suiteId);
    for (const caseId of parsed.caseIds) {
      getCase(this.db, caseId);
    }
    return this.start(suite.id, parsed.caseIds, parsed.mode);
  }

  /**
   * Re-run only the failed cases of a finished suite run as a brand-new suite
   * run (same suite + mode). History stays immutable — the retry is a new row.
   */
  rerunFailed(input: RunnerRerunFailedPayload): StartedSuiteRun {
    const parsed = RunnerRerunFailedSchema.parse(input);
    if (this.activeSuiteRunId !== null || this.isSingleActive()) {
      throw new RunAlreadyActiveError();
    }
    const source = this.db
      .select()
      .from(suiteRuns)
      .where(eq(suiteRuns.id, parsed.suiteRunId))
      .all()[0];
    if (source === undefined) {
      throw new Error(`suite run not found: ${parsed.suiteRunId}`);
    }
    const failedCaseIds = this.db
      .select()
      .from(caseRuns)
      .where(eq(caseRuns.suiteRunId, parsed.suiteRunId))
      .all()
      .filter((r) => r.status === "failed")
      .map((r) => r.caseId);
    if (failedCaseIds.length === 0) {
      throw new NoFailedCasesError(parsed.suiteRunId);
    }
    return this.start(source.suiteId, failedCaseIds, source.mode as "unsupervised");
  }

  /** Flag cancellation; workers settle between steps, then the suite settles. */
  async cancelRun(input: RunnerCancelPayload): Promise<null> {
    const parsed = RunnerCancelSchema.parse(input);
    if (this.activeSuiteRunId === parsed.suiteRunId) {
      this.cancelled.add(parsed.suiteRunId);
    }
    return null;
  }

  // --- Orchestration ----------------------------------------------------------

  private start(suiteId: string | null, caseIds: string[], mode: "unsupervised"): StartedSuiteRun {
    const startedAt = this.now();
    const suiteRunId = this.generateId();
    this.db
      .insert(suiteRuns)
      .values({ id: suiteRunId, suiteId, mode, status: "running", startedAt })
      .run();
    const caseRunIds = new Map<string, string>();
    for (const caseId of caseIds) {
      const caseRunId = this.generateId();
      caseRunIds.set(caseId, caseRunId);
      this.db
        .insert(caseRuns)
        .values({ id: caseRunId, suiteRunId, caseId, status: "running" })
        .run();
    }
    this.activeSuiteRunId = suiteRunId;
    const done = (async (): Promise<void> => {
      try {
        const queue = [...caseIds];
        const workers = Array.from(
          { length: this.workerCount(caseIds.length) },
          async (): Promise<void> => {
            while (queue.length > 0) {
              if (this.cancelled.has(suiteRunId)) {
                return;
              }
              const caseId = queue.shift();
              if (caseId === undefined) {
                return;
              }
              const caseRunId = caseRunIds.get(caseId);
              if (caseRunId !== undefined) {
                await this.runOneCase(suiteRunId, caseId, caseRunId);
              }
            }
          },
        );
        await Promise.all(workers);
      } catch (err) {
        this.log(
          "error",
          `suite worker failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        this.settleSuite(suiteRunId);
        if (this.activeSuiteRunId === suiteRunId) {
          this.activeSuiteRunId = null;
        }
        this.cancelled.delete(suiteRunId);
      }
    })();
    return { suiteRunId, done };
  }

  /** Settle one case: launch → steps → pass/fail/cancel → artifacts. */
  private async runOneCase(suiteRunId: string, caseId: string, caseRunId: string): Promise<void> {
    const testCase = getCase(this.db, caseId);
    const steps = listSteps(this.db, caseId);
    const data = getTestData(this.db, { caseId });
    const startedAt = this.now();
    const prefix = `[${testCase.name}]`;

    if (steps.length === 0) {
      this.finishCase(caseRunId, "passed", startedAt);
      this.log("warn", `${prefix} no steps — nothing to execute`);
      return;
    }

    const missingKey = firstMissingKey(steps, data);
    if (missingKey !== null) {
      this.createStepRun(
        caseRunId,
        missingKey.stepId,
        missingKey.order,
        "fail",
        `missing test-data key: ${missingKey.key}`,
      );
      for (const step of steps) {
        if (step.order !== missingKey.order) {
          this.createStepRun(caseRunId, step.id, step.order, "skipped", null);
        }
      }
      this.stepEvent(caseRunId, missingKey.order, "fail");
      this.log("error", `${prefix} missing test-data key: ${missingKey.key}`);
      this.finishCase(caseRunId, "failed", startedAt);
      return;
    }

    const caseDir = ensureCaseDir(this.artifactsRoot, testCase.projectId, suiteRunId, caseId);
    let context: RunContext;
    try {
      context = await this.launchBrowser.launch(true, caseDir);
    } catch (err) {
      for (const step of steps) {
        this.createStepRun(caseRunId, step.id, step.order, "skipped", null);
      }
      const message = err instanceof Error ? err.message : String(err);
      this.log("error", `${prefix} browser launch failed: ${message}`);
      this.finishCase(caseRunId, "failed", startedAt);
      return;
    }

    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      if (step === undefined) {
        break;
      }
      if (this.cancelled.has(suiteRunId)) {
        this.markSkippedFrom(caseRunId, steps, index);
        await this.closeQuietly(context);
        this.finishCase(caseRunId, "cancelled", startedAt);
        return;
      }
      const screenshotPath = stepScreenshotPath(
        this.artifactsRoot,
        testCase.projectId,
        suiteRunId,
        caseId,
        step.order,
      );
      this.createStepRun(caseRunId, step.id, step.order, "running", null);
      this.stepEvent(caseRunId, step.order, "running");
      const stepStarted = this.now();
      try {
        const value = substituteStepValue(step.value, data);
        await executeStep(context.page, { ...step, value });
        await this.captureScreenshot(context, screenshotPath);
        this.updateStepRun(caseRunId, step.id, "pass", null, screenshotPath, stepStarted);
        this.stepEvent(caseRunId, step.order, "pass");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.captureScreenshot(context, screenshotPath);
        this.updateStepRun(caseRunId, step.id, "fail", message, screenshotPath, stepStarted);
        this.stepEvent(caseRunId, step.order, "fail");
        this.log("error", `${prefix} step s${step.order} (${step.action}) failed: ${message}`);
        this.markSkippedFrom(caseRunId, steps, index + 1);
        const traceDest = caseTracePath(this.artifactsRoot, testCase.projectId, suiteRunId, caseId);
        try {
          await context.saveTrace(traceDest);
        } catch {
          this.log("warn", `${prefix} failed to save trace`);
        }
        await context.close();
        const videoPath = retainVideo(
          await this.safeRecordedVideo(context),
          caseVideoPath(this.artifactsRoot, testCase.projectId, suiteRunId, caseId),
        );
        if (videoPath !== null) {
          this.db.update(caseRuns).set({ videoPath }).where(eq(caseRuns.id, caseRunId)).run();
        }
        this.finishCase(caseRunId, "failed", startedAt);
        return;
      }
    }
    if (this.cancelled.has(suiteRunId)) {
      await this.closeQuietly(context);
      this.finishCase(caseRunId, "cancelled", startedAt);
      return;
    }
    try {
      await context.saveTrace(null);
    } catch {
      this.log("warn", `${prefix} failed to discard trace`);
    }
    await context.close();
    discardPath(await this.safeRecordedVideo(context));
    this.finishCase(caseRunId, "passed", startedAt);
  }

  /** Derive suite status + summary from the settled case rows, then report. */
  private settleSuite(suiteRunId: string): void {
    const rows = this.db.select().from(caseRuns).where(eq(caseRuns.suiteRunId, suiteRunId)).all();
    const passed = rows.filter((r) => r.status === "passed").length;
    const failed = rows.filter((r) => r.status === "failed").length;
    const cancelled = rows.filter((r) => r.status === "cancelled").length;
    const status = failed > 0 ? "failed" : cancelled > 0 ? "cancelled" : "passed";
    this.db
      .update(suiteRuns)
      .set({ status, endedAt: this.now() })
      .where(eq(suiteRuns.id, suiteRunId))
      .run();
    tryWriteSuiteHtmlReport(this.db, this.artifactsRoot, suiteRunId, (msg) => {
      this.log("warn", msg);
    });
    const summary = { total: rows.length, passed, failed, skipped: rows.length - passed - failed };
    this.emit("run:finished", RunFinishedEvent.parse({ suiteRunId, summary }));
  }

  // --- Small persistence / emit helpers (one effect per line) ------------------

  private createStepRun(
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

  private updateStepRun(
    caseRunId: string,
    stepId: string,
    status: StepStatus,
    error: string | null,
    screenshotPath: string,
    stepStarted: number,
  ): void {
    const rows = this.db.select().from(stepRuns).where(eq(stepRuns.caseRunId, caseRunId)).all();
    const row = rows.find((r) => r.stepId === stepId);
    if (row === undefined) {
      return;
    }
    this.db
      .update(stepRuns)
      .set({
        status,
        error: error?.slice(0, 20000) ?? null,
        screenshotPath,
        durationMs: this.now() - stepStarted,
      })
      .where(eq(stepRuns.id, row.id))
      .run();
  }

  private markSkippedFrom(caseRunId: string, steps: StepRow[], fromIndex: number): void {
    for (let index = fromIndex; index < steps.length; index++) {
      const step = steps[index];
      if (step === undefined) {
        break;
      }
      this.createStepRun(caseRunId, step.id, step.order, "skipped", null);
      this.stepEvent(caseRunId, step.order, "skipped");
    }
  }

  private finishCase(
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

  private stepEvent(caseRunId: string, order: number, status: StepStatus): void {
    this.emit("run:step-update", RunStepUpdateEvent.parse({ caseRunId, order, status }));
  }

  private log(level: "info" | "warn" | "error", msg: string): void {
    this.emit("run:log", RunLogEvent.parse({ level, msg }));
  }

  private async captureScreenshot(context: RunContext, path: string): Promise<void> {
    try {
      await context.page.screenshot(path);
    } catch {
      this.log("warn", `screenshot failed for ${path}`);
    }
  }

  private async safeRecordedVideo(context: RunContext): Promise<string | null> {
    try {
      return await context.recordedVideoPath();
    } catch {
      return null;
    }
  }

  private async closeQuietly(context: RunContext): Promise<void> {
    try {
      await context.saveTrace(null);
    } catch {
      // Context may already be half-closed — cancellation still proceeds.
    }
    await context.close();
    discardPath(await this.safeRecordedVideo(context));
  }
}

/** First step whose `{{key}}` has no test-data entry (fail-fast pre-scan). */
function firstMissingKey(
  steps: StepRow[],
  data: Record<string, string>,
): { stepId: string; order: number; key: string } | null {
  for (const step of steps) {
    try {
      substituteStepValue(step.value, data);
    } catch (err) {
      if (err instanceof MissingTestDataKeyError) {
        return { stepId: step.id, order: step.order, key: err.key };
      }
      throw err;
    }
  }
  return null;
}
