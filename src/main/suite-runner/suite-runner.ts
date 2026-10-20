import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import type {
  RunnerCancelPayload,
  RunnerRerunFailedPayload,
  RunnerRerunLastFailedPayload,
  RunnerRunSuitePayload,
} from "../../shared/ipc-contract.js";
import {
  RunnerCancelPayload as RunnerCancelSchema,
  RunnerRerunFailedPayload as RunnerRerunFailedSchema,
  RunnerRerunLastFailedPayload as RunnerRerunLastFailedSchema,
  RunnerRunSuitePayload as RunnerRunSuiteSchema,
} from "../../shared/ipc-contract.js";
import type { AppDatabase } from "../db.js";
import { getCase } from "../ipc-cases.js";
import { getSuite, getSuiteCaseIds } from "../ipc-suites.js";
import { caseRuns, suiteRuns } from "../schema.js";
import { RunAlreadyActiveError } from "../runner/errors.js";
import { RunWriter } from "../runner/run-writer.js";
import type { BrowserLauncher, EmitRunEvent } from "../runner/seams.js";
import type { CaseExecutionDeps } from "./case-execution.js";
import { runOneCase } from "./case-execution.js";
import { NoFailedCasesError, selectLastFailedCaseIds } from "./last-failed.js";
import { defaultWorkerCount, runCasePool } from "./pool.js";

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

export class SuiteRunner {
  private readonly db: AppDatabase;
  private readonly launchBrowser: BrowserLauncher;
  private readonly artifactsRoot: string;
  private readonly generateId: () => string;
  private readonly now: () => number;
  private readonly isSingleActive: () => boolean;
  private readonly workerCount: (caseCount: number) => number;
  private readonly runs: RunWriter;
  private activeSuiteRunId: string | null = null;
  private readonly cancelled = new Set<string>();

  constructor(db: AppDatabase, deps: SuiteRunnerDeps) {
    this.db = db;
    this.launchBrowser = deps.launchBrowser;
    this.artifactsRoot = deps.artifactsRoot;
    this.generateId = deps.generateId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.isSingleActive = deps.isSingleActive ?? (() => false);
    this.workerCount = deps.workerCount ?? defaultWorkerCount;
    this.runs = new RunWriter(db, { emit: deps.emit, generateId: this.generateId, now: this.now });
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
    const members = new Set(getSuiteCaseIds(this.db, suite.id));
    for (const caseId of parsed.caseIds) {
      const testCase = getCase(this.db, caseId);
      if (!members.has(caseId)) {
        throw new Error(`case ${caseId} is not a member of suite ${suite.id}`);
      }
      if (testCase.projectId !== suite.projectId) {
        throw new Error(`case ${caseId} belongs to a different project than suite ${suite.id}`);
      }
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

  /**
   * Re-run the failed cases of a suite's latest finished run (M12, PLAN
   * §18.5). Same immutability as `rerunFailed` — the retry is a new row.
   */
  rerunLastFailed(input: RunnerRerunLastFailedPayload): StartedSuiteRun {
    const parsed = RunnerRerunLastFailedSchema.parse(input);
    if (this.activeSuiteRunId !== null || this.isSingleActive()) {
      throw new RunAlreadyActiveError();
    }
    const selection = selectLastFailedCaseIds(this.db, parsed.suiteId);
    return this.start(selection.suiteId, selection.caseIds, selection.mode);
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
    this.runs.createSuiteRun({ id: suiteRunId, suiteId, mode, startedAt });
    const caseRunIds = new Map<string, string>();
    for (const caseId of caseIds) {
      const caseRunId = this.generateId();
      caseRunIds.set(caseId, caseRunId);
      // Queued up front, claimed by a worker in `runOneCase` → the live panel
      // can distinguish "waiting for a worker" from "executing".
      this.runs.createCaseRun({ id: caseRunId, suiteRunId, caseId, status: "pending" });
    }
    this.activeSuiteRunId = suiteRunId;
    const caseDeps: CaseExecutionDeps = {
      db: this.db,
      runs: this.runs,
      artifactsRoot: this.artifactsRoot,
      now: this.now,
      isCancelled: (id: string) => this.cancelled.has(id),
    };
    const done = (async (): Promise<void> => {
      try {
        await runCasePool({
          caseIds,
          caseRunIds,
          workerCount: this.workerCount(caseIds.length),
          isCancelled: () => this.cancelled.has(suiteRunId),
          launchBrowser: () => this.launchBrowser.launchBrowser(true),
          runCase: (getBrowser, caseId, caseRunId) =>
            runOneCase(caseDeps, getBrowser, suiteRunId, caseId, caseRunId),
          onCaseError: (caseId, caseRunId, err) => {
            this.settleCrashedCase(caseId, caseRunId, err);
          },
        });
      } catch (err) {
        this.runs.log(
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

  /**
   * A case threw outside its own failure paths (e.g. its row was deleted
   * mid-run). Settle only that case: siblings keep running, and the suite is
   * not marked passed from an unfinished row.
   */
  private settleCrashedCase(caseId: string, caseRunId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.runs.log("error", `case ${caseId} failed to execute: ${message}`);
    this.runs.skipRunningSteps(caseRunId);
    this.runs.settleCaseIfRunning(caseRunId, "failed", this.now());
  }

  /** Derive suite status + summary from the settled case rows, then report. */
  private settleSuite(suiteRunId: string): void {
    const cancelledRun = this.cancelled.has(suiteRunId);
    // Defensive: every worker has stopped by the time we settle, so any case
    // still running (or queued but never claimed) was crashed/never started.
    // Cancelled runs settle as cancelled; otherwise failed — never "passed".
    const unsettled = this.runs
      .listCaseRuns(suiteRunId)
      .filter((r) => r.status === "running" || r.status === "pending");
    for (const row of unsettled) {
      this.runs.skipRunningSteps(row.id);
      this.runs.finishCaseRun(row.id, cancelledRun ? "cancelled" : "failed", this.now());
    }
    if (unsettled.length > 0 && !cancelledRun) {
      this.runs.log(
        "error",
        `${unsettled.length} queued/running case(s) did not settle — marked failed instead of passed`,
      );
    }
    const rows = this.runs.listCaseRuns(suiteRunId);
    const passed = rows.filter((r) => r.status === "passed").length;
    const failed = rows.filter((r) => r.status === "failed").length;
    const cancelled = rows.filter((r) => r.status === "cancelled").length;
    const status = failed > 0 ? "failed" : cancelled > 0 ? "cancelled" : "passed";
    this.runs.finishSuiteRun(suiteRunId, status);
    const summary = { total: rows.length, passed, failed, skipped: rows.length - passed - failed };
    this.runs.finishRun(suiteRunId, summary, this.artifactsRoot);
  }
}
