import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";

import type {
  RunnerCancelPayload,
  RunnerResumePayload,
  RunnerRunSinglePayload,
} from "../shared/ipc-contract.js";
import { tryWriteSuiteHtmlReport } from "./reports.js";
import {
  RunFinishedEvent,
  RunLogEvent,
  RunnerCancelPayload as RunnerCancelSchema,
  RunnerResumePayload as RunnerResumeSchema,
  RunnerRunSinglePayload as RunnerRunSingleSchema,
} from "../shared/ipc-contract.js";
import { RunStepUpdateEvent } from "../shared/ipc-contract.js";
import type { RunMode, StepRow } from "../shared/schema.js";
import { MissingTestDataKeyError, substituteTestDataValue } from "../shared/step-types.js";
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
import { getTestData, listSteps } from "./ipc-steps.js";
import { caseRuns, stepRuns, suiteRuns } from "./schema.js";

// --- Seams (production + test fake counts as the two adapters) ----------------

/**
 * Minimal page surface the runner drives (PLAN §8). Production wraps a
 * Playwright `Page`; tests inject a recording fake. Timeouts pass straight
 * through — `undefined` means the Playwright default.
 */
export interface RunPage {
  goto(url: string, timeoutMs?: number): Promise<void>;
  click(selector: string, timeoutMs?: number): Promise<void>;
  dblclick(selector: string, timeoutMs?: number): Promise<void>;
  fill(selector: string, value: string, timeoutMs?: number): Promise<void>;
  selectOption(selector: string, value: string, timeoutMs?: number): Promise<void>;
  check(selector: string, timeoutMs?: number): Promise<void>;
  press(selector: string | undefined, key: string, timeoutMs?: number): Promise<void>;
  assertVisible(selector: string, timeoutMs?: number): Promise<void>;
  assertText(selector: string, value: string, timeoutMs?: number): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(path: string): Promise<void>;
}

/** A launched browser context plus its teardown/artifact hooks. */
export interface RunContext {
  page: RunPage;
  /** Release browser + context. Call before reading the recorded video. */
  close(): Promise<void>;
  /** Playwright-assigned video file, if recording (null in fakes). */
  recordedVideoPath(): Promise<string | null>;
  /** Persist the trace to `path`; `null` discards it (pass / cancel). */
  saveTrace(path: string | null): Promise<void>;
}

export interface BrowserLauncher {
  /** `videoDir` receives Playwright's raw recording (renamed on failure). */
  launch(headless: boolean, videoDir: string): Promise<RunContext>;
}

export type RunEventChannel = "run:step-update" | "run:log" | "run:finished";

/** Main wires this to `webContents.send`; tests collect into an array. */
export type EmitRunEvent = (channel: RunEventChannel, payload: unknown) => void;

export interface RunnerDeps {
  launchBrowser: BrowserLauncher;
  emit: EmitRunEvent;
  artifactsRoot: string;
  generateId?: () => string;
  now?: () => number;
  /**
   * Wired by main.ts to the SuiteRunner's active flag so a single-case run
   * refuses to start while a parallel suite owns the browsers (and vice
   * versa). Absent in unit tests, where each runner is exercised alone.
   */
  isSuiteActive?: () => boolean;
}

/** Thrown when a second run starts while one session is still open. */
export class RunAlreadyActiveError extends Error {
  constructor() {
    super("another run is already active — cancel it before starting a new one");
    this.name = "RunAlreadyActiveError";
  }
}

/** Thrown by resume when the supervised context is gone (PLAN §8). */
export class ContextClosedError extends Error {
  constructor() {
    super("context closed — full re-run required");
    this.name = "ContextClosedError";
  }
}

/** A single step that cannot execute (missing selector/value, bad wait, …). */
export class StepExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepExecutionError";
  }
}

// --- Pure helpers (unit-tested directly) --------------------------------------

/** `{{key}}` substitution applies to step `value` only (PLAN §10). */
export function substituteStepValue(
  template: string | undefined,
  data: Record<string, string>,
): string | undefined {
  if (template === undefined) {
    return undefined;
  }
  return substituteTestDataValue(template, data);
}

/**
 * Execute one substituted step against the page. Throws StepExecutionError
 * for missing required fields so the failure message tells the user exactly
 * what to fix in the step editor.
 */
export async function executeStep(
  page: RunPage,
  step: {
    order: number;
    action: StepRow["action"];
    selector?: string;
    value?: string;
    timeoutMs?: number;
  },
): Promise<void> {
  const label = `s${step.order} (${step.action})`;
  const timeoutMs = step.timeoutMs;
  switch (step.action) {
    case "goto": {
      if (step.value === undefined || step.value === "") {
        throw new StepExecutionError(`${label} needs a URL in value`);
      }
      await page.goto(step.value, timeoutMs);
      return;
    }
    case "click": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      if (step.value === "dblclick") {
        await page.dblclick(step.selector, timeoutMs);
      } else {
        await page.click(step.selector, timeoutMs);
      }
      return;
    }
    case "fill": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      if (step.value === undefined) {
        throw new StepExecutionError(`${label} needs a value`);
      }
      await page.fill(step.selector, step.value, timeoutMs);
      return;
    }
    case "select": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      if (step.value === undefined) {
        throw new StepExecutionError(`${label} needs a value`);
      }
      await page.selectOption(step.selector, step.value, timeoutMs);
      return;
    }
    case "check": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      await page.check(step.selector, timeoutMs);
      return;
    }
    case "press": {
      if (step.value === undefined || step.value === "") {
        throw new StepExecutionError(`${label} needs a key in value (e.g. Enter)`);
      }
      await page.press(step.selector, step.value, timeoutMs);
      return;
    }
    case "assert-visible": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      await page.assertVisible(step.selector, timeoutMs);
      return;
    }
    case "assert-text": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      if (step.value === undefined) {
        throw new StepExecutionError(`${label} needs expected text in value`);
      }
      await page.assertText(step.selector, step.value, timeoutMs);
      return;
    }
    case "wait": {
      // Recorder fallback stores unparseable codegen lines as raw `value`
      // (PLAN §7) — those cannot auto-execute, so fail with guidance.
      if (step.value === undefined || !/^\d+$/.test(step.value.trim())) {
        throw new StepExecutionError(
          `${label} needs a duration in ms in value (recorded raw actions cannot auto-run — edit the step)`,
        );
      }
      await page.waitForTimeout(Number.parseInt(step.value.trim(), 10));
      return;
    }
  }
}

// --- Live session ---------------------------------------------------------------

interface LiveSession {
  suiteRunId: string;
  caseRunId: string;
  caseId: string;
  projectId: string;
  mode: RunMode;
  context: RunContext | null;
  cancelled: boolean;
  busy: boolean;
  settled: boolean;
  startedAt: number;
}

export interface StartedRun {
  suiteRunId: string;
  caseRunId: string;
  /** Resolves when the background execution settles (never rejects). */
  done: Promise<void>;
}

/**
 * Single-case runner (WS5 / M5, PLAN §8). One active session process-wide;
 * suite-parallel execution lands in M6. `runSingle` validates, persists the
 * run rows, launches the browser, and returns ids immediately — progress
 * streams over `run:step-update` / `run:log` / `run:finished`.
 *
 * Execution note: steps run directly against the Playwright library rather
 * than generated temp-spec files (see PLAN ledger 2026-10-16 WS5). Same
 * observable contract — per-step wrap, `{{key}}` substitution, screenshot
 * after every step, video/trace retain-on-failure — with live-context resume
 * and per-step streaming that a spec-file + reporter split cannot provide.
 */
export class SingleCaseRunner {
  private readonly db: AppDatabase;
  private readonly launchBrowser: BrowserLauncher;
  private readonly emit: EmitRunEvent;
  private readonly artifactsRoot: string;
  private readonly generateId: () => string;
  private readonly now: () => number;
  private readonly isSuiteActive: () => boolean;
  private session: LiveSession | null = null;

  constructor(db: AppDatabase, deps: RunnerDeps) {
    this.db = db;
    this.launchBrowser = deps.launchBrowser;
    this.emit = deps.emit;
    this.artifactsRoot = deps.artifactsRoot;
    this.generateId = deps.generateId ?? randomUUID;
    this.now = deps.now ?? Date.now;
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
    this.db
      .insert(suiteRuns)
      .values({ id: suiteRunId, suiteId: null, mode: parsed.mode, status: "running", startedAt })
      .run();
    this.db
      .insert(caseRuns)
      .values({ id: caseRunId, suiteRunId, caseId: parsed.caseId, status: "running" })
      .run();

    if (steps.length === 0) {
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

    const caseDir = ensureCaseDir(
      this.artifactsRoot,
      testCase.projectId,
      suiteRunId,
      parsed.caseId,
    );
    const session: LiveSession = {
      suiteRunId,
      caseRunId,
      caseId: parsed.caseId,
      projectId: testCase.projectId,
      mode: parsed.mode,
      context: null,
      cancelled: false,
      busy: true,
      settled: false,
      startedAt,
    };
    this.session = session;
    const done = (async (): Promise<void> => {
      try {
        const context = await this.launchBrowser.launch(parsed.mode === "unsupervised", caseDir);
        session.context = context;
        await this.executeFrom(session, steps, data, 0, startedAt);
      } catch (err) {
        this.abortSession(session, steps, err instanceof Error ? err.message : String(err));
      }
    })();
    return { suiteRunId, caseRunId, done };
  }

  /**
   * Resume a paused supervised run in its live context (PLAN §8). Reloads
   * steps + test data so edits made while paused apply. Anything else —
   * finished, cancelled, unsupervised — has no live context.
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
      await this.settleCancel(session);
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
        await executeStep(context.page, { ...step, value });
        await this.captureScreenshot(context, screenshotPath);
        this.updateStepRun(caseRunId, step.id, "pass", null, screenshotPath, stepStarted);
        this.stepEvent(caseRunId, step.order, "pass");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.captureScreenshot(context, screenshotPath);
        this.updateStepRun(caseRunId, step.id, "fail", message, screenshotPath, stepStarted);
        this.stepEvent(caseRunId, step.order, "fail");
        this.log("error", `step s${step.order} (${step.action}) failed: ${message}`);
        if (session.mode === "supervised") {
          session.busy = false;
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
      await context.close();
      discardPath(await this.safeRecordedVideo(context));
    }
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
      await context.close();
      videoPath = retainVideo(
        await this.safeRecordedVideo(context),
        caseVideoPath(this.artifactsRoot, session.projectId, session.suiteRunId, session.caseId),
      );
    }
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
      await context.close();
      discardPath(await this.safeRecordedVideo(context));
    }
    this.finishCase(session.caseRunId, "cancelled", session.startedAt);
    this.finishSuite(session.suiteRunId, "cancelled");
    // Contract has no cancelled bucket — cancellation counts as skipped.
    this.finish(session.suiteRunId, { total: 1, passed: 0, failed: 0, skipped: 1 });
    this.log("warn", "run cancelled — remaining steps skipped");
    if (this.session === session) {
      this.session = null;
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

// --- Production Playwright adapter -----------------------------------------------

class PlaywrightRunPage implements RunPage {
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto(url: string, timeoutMs?: number): Promise<void> {
    await this.page.goto(url, { timeout: timeoutMs });
  }

  async click(selector: string, timeoutMs?: number): Promise<void> {
    await this.page.locator(selector).click({ timeout: timeoutMs });
  }

  async dblclick(selector: string, timeoutMs?: number): Promise<void> {
    await this.page.locator(selector).dblclick({ timeout: timeoutMs });
  }

  async fill(selector: string, value: string, timeoutMs?: number): Promise<void> {
    await this.page.locator(selector).fill(value, { timeout: timeoutMs });
  }

  async selectOption(selector: string, value: string, timeoutMs?: number): Promise<void> {
    await this.page.locator(selector).selectOption(value, { timeout: timeoutMs });
  }

  async check(selector: string, timeoutMs?: number): Promise<void> {
    await this.page.locator(selector).check({ timeout: timeoutMs });
  }

  async press(selector: string | undefined, key: string, timeoutMs?: number): Promise<void> {
    if (selector === undefined || selector === "") {
      await this.page.keyboard.press(key);
    } else {
      await this.page.locator(selector).press(key, { timeout: timeoutMs });
    }
  }

  async assertVisible(selector: string, timeoutMs?: number): Promise<void> {
    try {
      await this.page.locator(selector).first().waitFor({ state: "visible", timeout: timeoutMs });
    } catch (err) {
      throw new Error(`expected visible: ${selector} (${asMessage(err)})`);
    }
  }

  async assertText(selector: string, value: string, timeoutMs?: number): Promise<void> {
    try {
      await this.page
        .locator(selector)
        .filter({ hasText: value })
        .first()
        .waitFor({ state: "visible", timeout: timeoutMs });
    } catch (err) {
      throw new Error(`expected text "${value}" in: ${selector} (${asMessage(err)})`);
    }
  }

  async waitForTimeout(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({ path });
  }
}

class PlaywrightRunContext implements RunContext {
  private readonly browser: Browser;
  private readonly context: BrowserContext;
  private readonly rawPage: Page;
  readonly page: RunPage;

  constructor(browser: Browser, context: BrowserContext, page: Page) {
    this.browser = browser;
    this.context = context;
    this.rawPage = page;
    this.page = new PlaywrightRunPage(page);
  }

  async close(): Promise<void> {
    await this.context.close();
    await this.browser.close();
  }

  async recordedVideoPath(): Promise<string | null> {
    // Read via the held page: context.pages() is empty after close(), but
    // the Video object outlives the context — callers read this after close.
    const video = this.rawPage.video();
    return video === null ? null : video.path();
  }

  async saveTrace(path: string | null): Promise<void> {
    if (path === null) {
      await this.context.tracing.stop();
    } else {
      await this.context.tracing.stop({ path });
    }
  }
}

function asMessage(err: unknown): string {
  return err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
}

/** Production launcher: Chromium only (MVP locked decision). */
export function playwrightLauncher(): BrowserLauncher {
  return {
    async launch(headless: boolean, videoDir: string): Promise<RunContext> {
      const browser = await chromium.launch({ headless });
      try {
        const context = await browser.newContext({ recordVideo: { dir: videoDir } });
        await context.tracing.start({ screenshots: true, snapshots: true });
        const page = await context.newPage();
        return new PlaywrightRunContext(browser, context, page);
      } catch (err) {
        await browser.close();
        throw err;
      }
    },
  };
}
