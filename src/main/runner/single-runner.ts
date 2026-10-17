/**
 * Single-case runner (WS5 / M5, PLAN §8). One active session process-wide;
 * suite-parallel execution lives in `suite-runner.ts`. `runSingle` validates,
 * persists the run rows, launches the browser, and returns ids immediately —
 * progress streams over `run:step-update` / `run:log` / `run:finished`.
 *
 * Execution note: steps run directly against the Playwright library rather
 * than generated temp-spec files (see PLAN ledger 2026-10-16 WS5). Same
 * observable contract — per-step wrap, `{{key}}` substitution, screenshot
 * after every step, video/trace retain-on-failure — with live-context resume
 * and per-step streaming that a spec-file + reporter split cannot provide.
 */

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import type { StepStatus } from "../../shared/step-types.js";
import { MissingTestDataKeyError } from "../../shared/step-types.js";
import type {
  RunnerCancelPayload,
  RunnerResumePayload,
  RunnerRunSinglePayload,
} from "../../shared/ipc-contract.js";
import {
  RunFinishedEvent,
  RunLogEvent,
  RunnerCancelPayload as RunnerCancelSchema,
  RunnerResumePayload as RunnerResumeSchema,
  RunnerRunSinglePayload as RunnerRunSingleSchema,
  RunStepUpdateEvent,
} from "../../shared/ipc-contract.js";
import type { RunMode, StepRow } from "../../shared/schema.js";
import { caseTracePath, caseVideoPath, ensureCaseDir, stepScreenshotPath } from "../artifacts.js";
import type { AppDatabase } from "../db.js";
import { getCase } from "../ipc-cases.js";
import { getCaseProfile } from "../ipc-profiles.js";
import { getProject } from "../ipc-projects.js";
import { getTestData, listSteps } from "../ipc-steps.js";
import { tryWriteSuiteHtmlReport } from "../reports.js";
import { caseRuns, stepRuns, suiteRuns } from "../schema.js";
import { ContextClosedError, RunAlreadyActiveError, formatStepError } from "./errors.js";
import { executeStep } from "./execute-step.js";
import { contextLaunchOptionsFromProfile } from "./launcher.js";
import type { BrowserHandle, BrowserLauncher, EmitRunEvent, RunContext } from "./seams.js";
import { captureStepScreenshot, runStepInTraceGroup, stepTraceLabel } from "./step-evidence.js";
import { clickFollowsPageEvent, substituteStepValue } from "./step-values.js";

interface LiveSession {
  suiteRunId: string;
  caseRunId: string;
  caseId: string;
  projectId: string;
  mode: RunMode;
  actionDelayMs: number;
  /** One browser per run; every run uses a single fresh context (M14). */
  browser: BrowserHandle | null;
  context: RunContext | null;
  cancelled: boolean;
  busy: boolean;
  settled: boolean;
  startedAt: number;
  /** Pause snapshot: remaining steps are marked skipped if cancelled while paused. */
  pausedSteps?: StepRow[];
  pausedFromIndex?: number;
}

export interface StartedRun {
  suiteRunId: string;
  caseRunId: string;
  /** Resolves when the background execution settles (never rejects). */
  done: Promise<void>;
}

export interface RunnerDeps {
  launchBrowser: BrowserLauncher;
  emit: EmitRunEvent;
  artifactsRoot: string;
  generateId?: () => string;
  now?: () => number;
  /** Injectable inter-step pacing (tests record calls; prod sleeps). */
  delay?: (ms: number) => Promise<void>;
  /**
   * Wired by main.ts to the SuiteRunner's active flag so a single-case run
   * refuses to start while a parallel suite owns the browsers (and vice
   * versa). Absent in unit tests, where each runner is exercised alone.
   */
  isSuiteActive?: () => boolean;
}

export class SingleCaseRunner {
  private readonly db: AppDatabase;
  private readonly launchBrowser: BrowserLauncher;
  private readonly emit: EmitRunEvent;
  private readonly artifactsRoot: string;
  private readonly generateId: () => string;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly isSuiteActive: () => boolean;
  private session: LiveSession | null = null;

  constructor(db: AppDatabase, deps: RunnerDeps) {
    this.db = db;
    this.launchBrowser = deps.launchBrowser;
    this.emit = deps.emit;
    this.artifactsRoot = deps.artifactsRoot;
    this.generateId = deps.generateId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.delay = deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.isSuiteActive = deps.isSuiteActive ?? (() => false);
  }

  /** True while a single-case session (live or paused) holds its context. */
  hasActiveSession(): boolean {
    return this.session !== null;
  }

  /** Start a supervised (headed, pausable) or unsupervised (headless) single-case run. */
  runSingle(input: RunnerRunSinglePayload): StartedRun {
    const parsed = RunnerRunSingleSchema.parse(input);
    if (this.session !== null || this.isSuiteActive()) {
      throw new RunAlreadyActiveError();
    }
    const testCase = getCase(this.db, parsed.caseId);
    const steps = listSteps(this.db, parsed.caseId);
    const data = getTestData(this.db, { caseId: parsed.caseId });

    const startedAt = this.now();
    const suiteRunId = this.generateId();
    const caseRunId = this.generateId();
    const insertRunRows = (): void => {
      this.insertSuiteRun(suiteRunId, parsed.mode, startedAt);
      this.insertCaseRun(caseRunId, suiteRunId, parsed.caseId);
    };

    if (steps.length === 0) {
      insertRunRows();
      this.finishSuite(suiteRunId, "passed");
      this.finishCase(caseRunId, "passed", startedAt);
      this.log("warn", "no steps — nothing to execute");
      this.finish(suiteRunId, { total: 1, passed: 1, failed: 0, skipped: 0 });
      return { suiteRunId, caseRunId, done: Promise.resolve() };
    }

    // Fail fast on config errors without launching a browser: the run record
    // still exists (failed step + finished event) so the graph shows red.
    const missingKey = firstMissingKey(steps, data);
    if (missingKey !== null) {
      insertRunRows();
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
      this.log("error", `missing test-data key: ${missingKey.key}`);
      this.finishCase(caseRunId, "failed", startedAt);
      this.finishSuite(suiteRunId, "failed");
      this.finish(suiteRunId, { total: 1, passed: 0, failed: 1, skipped: 0 });
      return { suiteRunId, caseRunId, done: Promise.resolve() };
    }

    // Resolve the run environment (M14) before writing any run row: a missing
    // auth-state file is a config error that must not leave a perpetually
    // "running" row behind (it throws synchronously to the caller).
    const caseDir = ensureCaseDir(
      this.artifactsRoot,
      testCase.projectId,
      suiteRunId,
      parsed.caseId,
    );
    const launchOptions = contextLaunchOptionsFromProfile({
      artifactsRoot: this.artifactsRoot,
      projectId: testCase.projectId,
      caseName: testCase.name,
      projectBaseUrl: getProject(this.db, testCase.projectId).baseUrl,
      profile: getCaseProfile(this.db, parsed.caseId),
      videoDir: caseDir,
      onLog: (level, msg) => this.log(level, msg),
    });
    insertRunRows();
    const session: LiveSession = {
      suiteRunId,
      caseRunId,
      caseId: parsed.caseId,
      projectId: testCase.projectId,
      mode: parsed.mode,
      actionDelayMs: parsed.actionDelayMs ?? 0,
      browser: null,
      context: null,
      cancelled: false,
      busy: true,
      settled: false,
      startedAt,
    };
    this.session = session;
    const done = (async (): Promise<void> => {
      try {
        const browser = await this.launchBrowser.launchBrowser(parsed.mode === "unsupervised");
        session.browser = browser;
        session.context = await browser.newContext(launchOptions);
        await this.executeFrom(session, steps, data, 0, startedAt);
      } catch (err) {
        await this.closeSessionResources(session);
        this.abortSession(session, steps, err instanceof Error ? err.message : String(err));
      }
    })();
    return { suiteRunId, caseRunId, done };
  }

  /**
   * Resume a paused supervised run in its live context (PLAN §8). Reloads
   * steps + test data so edits made while paused apply. The live context keeps
   * the profile it launched with (M14) — re-resolving here would change the
   * environment mid-run; anything without a live context has none to resume.
   */
  resumeFromStep(input: RunnerResumePayload): StartedRun {
    const parsed = RunnerResumeSchema.parse(input);
    const session = this.session;
    if (session === null || session.caseRunId !== parsed.caseRunId || session.context === null) {
      throw new ContextClosedError();
    }
    if (session.busy) {
      throw new RunAlreadyActiveError();
    }
    const steps = listSteps(this.db, session.caseId);
    if (parsed.fromOrder < 0 || parsed.fromOrder >= steps.length) {
      throw new ContextClosedError();
    }
    const data = getTestData(this.db, { caseId: session.caseId });
    this.clearStepRunsFrom(session.caseRunId, parsed.fromOrder);
    session.busy = true;
    session.cancelled = false;
    session.pausedSteps = undefined;
    session.pausedFromIndex = undefined;
    const startedAt = this.now();
    session.startedAt = startedAt;
    const done = (async (): Promise<void> => {
      try {
        await this.executeFrom(session, steps, data, parsed.fromOrder, startedAt);
      } catch (err) {
        this.abortSession(session, steps, err instanceof Error ? err.message : String(err));
      }
    })();
    return { suiteRunId: session.suiteRunId, caseRunId: session.caseRunId, done };
  }

  /** Flag cancellation; the loop settles between steps, or now when paused. */
  async cancelRun(input: RunnerCancelPayload): Promise<null> {
    const parsed = RunnerCancelSchema.parse(input);
    const session = this.session;
    if (session === null || session.suiteRunId !== parsed.suiteRunId) {
      return null;
    }
    session.cancelled = true;
    if (!session.busy) {
      await this.settleCancel(session, session.pausedSteps, session.pausedFromIndex);
    }
    return null;
  }

  // --- Execution loop ---------------------------------------------------------

  private async executeFrom(
    session: LiveSession,
    steps: StepRow[],
    data: Record<string, string>,
    fromOrder: number,
    startedAt: number,
  ): Promise<void> {
    const { caseRunId, suiteRunId } = session;
    for (let index = fromOrder; index < steps.length; index++) {
      const step = steps[index];
      if (step === undefined) {
        break;
      }
      if (session.cancelled) {
        await this.settleCancel(session, steps, index);
        return;
      }
      // Pre-run speed control: pace supervised runs so each headed action can
      // be followed. Skipped for the first step of each executeFrom batch so a
      // resume continues immediately rather than idling first.
      if (session.actionDelayMs > 0 && index > fromOrder) {
        await this.delay(session.actionDelayMs);
        if (session.cancelled) {
          await this.settleCancel(session, steps, index);
          return;
        }
      }
      const context = session.context;
      if (context === null) {
        throw new ContextClosedError();
      }
      const screenshotPath = stepScreenshotPath(
        this.artifactsRoot,
        session.projectId,
        suiteRunId,
        session.caseId,
        step.order,
      );
      this.createStepRun(caseRunId, step.id, step.order, "running", null);
      this.stepEvent(caseRunId, step.order, "running");
      const stepStarted = this.now();
      try {
        // Substitution inside the try: data may change while paused, so a
        // deleted key fails this step (and pauses again) instead of aborting.
        const value = substituteStepValue(step.value, data);
        // M16: a plain click that opens a tab leaves it in the background —
        // snapshot the context's page count and hint at the `popup` token
        // when it grew. Clicks that opt in (popup/download) are excluded.
        const watchPopup = step.action === "click" && !clickFollowsPageEvent(value);
        const pagesBefore = watchPopup ? context.page.pageCount() : 0;
        await runStepInTraceGroup(context, stepTraceLabel({ ...step, value }), () =>
          executeStep(context.page, { ...step, value }),
        );
        if (watchPopup && context.page.pageCount() > pagesBefore) {
          this.log(
            "warn",
            `step s${step.order} (click) opened a new page — add the "popup" token to value to follow it`,
          );
        }
        await this.captureScreenshot(context, screenshotPath);
        this.updateStepRun(caseRunId, step.id, "pass", null, screenshotPath, stepStarted);
        this.stepEvent(caseRunId, step.order, "pass");
      } catch (err) {
        const message = formatStepError(err);
        await this.captureScreenshot(context, screenshotPath);
        this.updateStepRun(caseRunId, step.id, "fail", message, screenshotPath, stepStarted);
        this.stepEvent(caseRunId, step.order, "fail");
        this.log("error", `step s${step.order} (${step.action}) failed: ${message}`);
        if (session.mode === "supervised") {
          session.busy = false;
          session.pausedSteps = steps;
          session.pausedFromIndex = index + 1;
          // Persist the failure evidence now: an edit-and-resume must not lose
          // the trace. Restarting the chunk keeps the resumed run traced too.
          try {
            await context.saveTraceChunk(
              caseTracePath(this.artifactsRoot, session.projectId, suiteRunId, session.caseId),
            );
          } catch {
            this.log("warn", "failed to save trace");
          }
          this.log("warn", `paused at step ${step.order} — edit the step and resume, or re-run`);
          return;
        }
        this.markSkippedFrom(caseRunId, steps, index + 1);
        await this.settleFailure(session, startedAt);
        return;
      }
    }
    if (session.cancelled) {
      await this.settleCancel(session, steps, steps.length);
      return;
    }
    await this.settlePass(session, startedAt);
  }

  private async settlePass(session: LiveSession, startedAt: number): Promise<void> {
    const context = session.context;
    if (context !== null) {
      try {
        await context.saveTrace(null);
      } catch {
        this.log("warn", "failed to discard trace");
      }
      await this.safeDiscardVideo(context);
    }
    await this.closeSessionResources(session);
    this.finishCase(session.caseRunId, "passed", startedAt);
    this.finishSuite(session.suiteRunId, "passed");
    this.finish(session.suiteRunId, { total: 1, passed: 1, failed: 0, skipped: 0 });
    if (this.session === session) {
      this.session = null;
    }
  }

  private async settleFailure(session: LiveSession, startedAt: number): Promise<void> {
    const context = session.context;
    let videoPath: string | null = null;
    if (context !== null) {
      const traceDest = caseTracePath(
        this.artifactsRoot,
        session.projectId,
        session.suiteRunId,
        session.caseId,
      );
      try {
        await context.saveTrace(traceDest);
      } catch {
        this.log("warn", "failed to save trace");
      }
      const videoDest = caseVideoPath(
        this.artifactsRoot,
        session.projectId,
        session.suiteRunId,
        session.caseId,
      );
      if (await this.safeSaveVideo(context, videoDest)) {
        videoPath = videoDest;
      }
    }
    await this.closeSessionResources(session);
    if (videoPath !== null) {
      this.db.update(caseRuns).set({ videoPath }).where(eq(caseRuns.id, session.caseRunId)).run();
    }
    this.finishCase(session.caseRunId, "failed", startedAt);
    this.finishSuite(session.suiteRunId, "failed");
    this.finish(session.suiteRunId, { total: 1, passed: 0, failed: 1, skipped: 0 });
    if (this.session === session) {
      this.session = null;
    }
  }

  /** Idempotent — the loop and cancelRun can both reach it. */
  private async settleCancel(
    session: LiveSession,
    steps?: StepRow[],
    fromIndex?: number,
  ): Promise<void> {
    if (session.settled) {
      return;
    }
    session.settled = true;
    if (steps !== undefined && fromIndex !== undefined) {
      this.markSkippedFrom(session.caseRunId, steps, fromIndex);
    }
    const context = session.context;
    if (context !== null) {
      try {
        await context.saveTrace(null);
      } catch {
        // Context may already be half-closed — cancellation still proceeds.
      }
      await this.safeDiscardVideo(context);
    }
    await this.closeSessionResources(session);
    this.finishCase(session.caseRunId, "cancelled", session.startedAt);
    this.finishSuite(session.suiteRunId, "cancelled");
    // Contract has no cancelled bucket — cancellation counts as skipped.
    this.finish(session.suiteRunId, { total: 1, passed: 0, failed: 0, skipped: 1 });
    this.log("warn", "run cancelled — remaining steps skipped");
    if (this.session === session) {
      this.session = null;
    }
  }

  /**
   * Close the run's context then its browser (M14: the browser outlives a
   * single context). Best-effort — teardown failures must not unseat a settled
   * run.
   */
  private async closeSessionResources(session: LiveSession): Promise<void> {
    const context = session.context;
    if (context !== null) {
      try {
        await context.close();
      } catch {
        // Already closing — nothing left to do.
      }
      session.context = null;
    }
    const browser = session.browser;
    if (browser !== null) {
      try {
        await browser.close();
      } catch {
        // Already closing — nothing left to do.
      }
      session.browser = null;
    }
  }

  /** Last-resort: background threw outside per-step handling (e.g. launch). */
  private abortSession(session: LiveSession, steps: StepRow[], message: string): void {
    if (this.session !== session) {
      return;
    }
    try {
      const rows = this.db
        .select()
        .from(stepRuns)
        .where(eq(stepRuns.caseRunId, session.caseRunId))
        .all();
      if (rows.length === 0) {
        for (const step of steps) {
          this.createStepRun(session.caseRunId, step.id, step.order, "skipped", null);
        }
      }
      this.log("error", message);
      this.finishCase(session.caseRunId, "failed", this.now());
      this.finishSuite(session.suiteRunId, "failed");
      this.finish(session.suiteRunId, { total: 1, passed: 0, failed: 1, skipped: 0 });
    } catch {
      this.log("error", message);
    } finally {
      this.session = null;
    }
  }

  // --- Small persistence / emit helpers (one effect per line) ------------------

  private insertSuiteRun(suiteRunId: string, mode: RunMode, startedAt: number): void {
    this.db
      .insert(suiteRuns)
      .values({ id: suiteRunId, suiteId: null, mode, status: "running", startedAt })
      .run();
  }

  private insertCaseRun(caseRunId: string, suiteRunId: string, caseId: string): void {
    this.db.insert(caseRuns).values({ id: caseRunId, suiteRunId, caseId, status: "running" }).run();
  }

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
        error,
        screenshotPath,
        durationMs: this.now() - stepStarted,
      })
      .where(eq(stepRuns.id, row.id))
      .run();
  }

  private clearStepRunsFrom(caseRunId: string, fromOrder: number): void {
    const rows = this.db.select().from(stepRuns).where(eq(stepRuns.caseRunId, caseRunId)).all();
    for (const row of rows) {
      if (row.order >= fromOrder) {
        this.db.delete(stepRuns).where(eq(stepRuns.id, row.id)).run();
      }
    }
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

  private finishSuite(suiteRunId: string, status: "passed" | "failed" | "cancelled"): void {
    this.db
      .update(suiteRuns)
      .set({ status, endedAt: this.now() })
      .where(eq(suiteRuns.id, suiteRunId))
      .run();
  }

  private stepEvent(caseRunId: string, order: number, status: StepStatus): void {
    this.emit("run:step-update", RunStepUpdateEvent.parse({ caseRunId, order, status }));
  }

  private log(level: "info" | "warn" | "error", msg: string): void {
    this.emit("run:log", RunLogEvent.parse({ level, msg }));
  }

  private finish(
    suiteRunId: string,
    summary: { total: number; passed: number; failed: number; skipped: number },
  ): void {
    // Report write is evidence, not verdict: best-effort before the finished
    // event so the report page can link it immediately; a write failure warns.
    tryWriteSuiteHtmlReport(this.db, this.artifactsRoot, suiteRunId, (msg) => {
      this.log("warn", msg);
    });
    this.emit("run:finished", RunFinishedEvent.parse({ suiteRunId, summary }));
  }

  // Screenshots are evidence, not verdicts: a failed capture warns, never
  // flips the step result. Awaited (not fire-and-forget) so artifacts exist
  // before the run settles — important for tests and the report page.
  private async captureScreenshot(context: RunContext, path: string): Promise<void> {
    await captureStepScreenshot(context.page, path, (message) => this.log("warn", message));
  }

  private async safeSaveVideo(context: RunContext, dest: string): Promise<boolean> {
    try {
      await context.saveVideo(dest);
      return true;
    } catch {
      return false;
    }
  }

  private async safeDiscardVideo(context: RunContext): Promise<void> {
    try {
      await context.discardVideo();
    } catch {
      // A leftover recording is harmless — the run still settles.
    }
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
