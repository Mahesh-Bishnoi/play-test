/**
 * One suite case, end to end: launch a fresh context on the worker's shared
 * browser, run every step, settle pass/fail/cancel, then persist artifacts.
 * Called by the pool; never pauses (suites run unsupervised).
 */

import { caseTracePath, caseVideoPath, ensureCaseDir, stepScreenshotPath } from "../artifacts.js";
import type { StepRow, TestCase } from "../../shared/schema.js";
import type { AppDatabase } from "../db.js";
import { getCase } from "../ipc-cases.js";
import { getCaseProfile } from "../ipc-profiles.js";
import { getProject } from "../ipc-projects.js";
import { getTestData, listSteps } from "../ipc-steps.js";
import { formatStepError } from "../runner/errors.js";
import { executeStep } from "../runner/execute-step.js";
import { flakeHints } from "../runner/flake-hints.js";
import { contextLaunchOptionsFromProfile } from "../runner/launcher.js";
import type { RunWriter } from "../runner/run-writer.js";
import type { BrowserHandle, RunContext } from "../runner/seams.js";
import { runStepInTraceGroup, stepTraceLabel } from "../runner/step-evidence.js";
import { firstMissingKey, substituteStepValue } from "../runner/step-values.js";

export interface CaseExecutionDeps {
  db: AppDatabase;
  runs: RunWriter;
  artifactsRoot: string;
  now: () => number;
  isCancelled: (suiteRunId: string) => boolean;
}

/** Settle one case: launch context → steps → pass/fail/cancel → artifacts. */
export async function runOneCase(
  deps: CaseExecutionDeps,
  getBrowser: () => Promise<BrowserHandle>,
  suiteRunId: string,
  caseId: string,
  caseRunId: string,
): Promise<void> {
  const startedAt = deps.now();
  // Preflight is inside the per-case failure path: a case deleted mid-run must
  // settle this row, not reject the worker (which would end the suite early).
  let preflight: { testCase: TestCase; steps: StepRow[]; data: Record<string, string> };
  try {
    preflight = {
      testCase: getCase(deps.db, caseId),
      steps: listSteps(deps.db, caseId),
      data: getTestData(deps.db, { caseId }),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.runs.log("error", `case ${caseId} could not be read: ${message}`);
    deps.runs.settleCaseIfRunning(caseRunId, "failed", startedAt);
    return;
  }
  const { testCase, steps, data } = preflight;
  const prefix = `[${testCase.name}]`;

  if (steps.length === 0) {
    deps.runs.finishCaseRun(caseRunId, "passed", startedAt);
    deps.runs.log("warn", `${prefix} no steps — nothing to execute`);
    return;
  }

  const missingKey = firstMissingKey(steps, data);
  if (missingKey !== null) {
    deps.runs.createStepRun(
      caseRunId,
      missingKey.stepId,
      missingKey.order,
      "fail",
      `missing test-data key: ${missingKey.key}`,
    );
    for (const step of steps) {
      if (step.order !== missingKey.order) {
        deps.runs.createStepRun(caseRunId, step.id, step.order, "skipped", null);
      }
    }
    deps.runs.emitStep(caseRunId, missingKey.order, "fail");
    deps.runs.log("error", `${prefix} missing test-data key: ${missingKey.key}`);
    deps.runs.finishCaseRun(caseRunId, "failed", startedAt);
    return;
  }

  // Same Playwright best-practice warnings as the single-case runner (M18).
  for (const hint of flakeHints(steps)) {
    deps.runs.log("warn", `${prefix} ${hint}`);
  }

  let context: RunContext;
  try {
    const caseDir = ensureCaseDir(deps.artifactsRoot, testCase.projectId, suiteRunId, caseId);
    // Resolve the case profile (M14) before the browser: a missing auth-state
    // file is a config error, caught by the same per-case failure path as a
    // launch failure. The worker's browser is shared; the context is fresh.
    const options = contextLaunchOptionsFromProfile({
      artifactsRoot: deps.artifactsRoot,
      projectId: testCase.projectId,
      caseName: testCase.name,
      projectBaseUrl: getProject(deps.db, testCase.projectId).baseUrl,
      profile: getCaseProfile(deps.db, caseId),
      videoDir: caseDir,
      onLog: (level, msg) => deps.runs.log(level, `${prefix} ${msg}`),
    });
    const browser = await getBrowser();
    context = await browser.newContext(options);
  } catch (err) {
    for (const step of steps) {
      deps.runs.createStepRun(caseRunId, step.id, step.order, "skipped", null);
    }
    const message = err instanceof Error ? err.message : String(err);
    deps.runs.log("error", `${prefix} browser launch failed: ${message}`);
    deps.runs.finishCaseRun(caseRunId, "failed", startedAt);
    return;
  }

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (step === undefined) {
      break;
    }
    if (deps.isCancelled(suiteRunId)) {
      deps.runs.markSkippedFrom(caseRunId, steps, index);
      await closeQuietly(context, deps.runs);
      deps.runs.finishCaseRun(caseRunId, "cancelled", startedAt);
      return;
    }
    const screenshotPath = stepScreenshotPath(
      deps.artifactsRoot,
      testCase.projectId,
      suiteRunId,
      caseId,
      step.order,
    );
    deps.runs.createStepRun(caseRunId, step.id, step.order, "running", null);
    deps.runs.emitStep(caseRunId, step.order, "running");
    const stepStarted = deps.now();
    try {
      const value = substituteStepValue(step.value, data);
      await runStepInTraceGroup(context, stepTraceLabel({ ...step, value }), () =>
        executeStep(context.page, { ...step, value }),
      );
      await deps.runs.captureScreenshot(context, screenshotPath);
      deps.runs.updateStepRun(caseRunId, step.id, "pass", null, screenshotPath, stepStarted);
      deps.runs.emitStep(caseRunId, step.order, "pass");
    } catch (err) {
      const message = formatStepError(err);
      await deps.runs.captureScreenshot(context, screenshotPath);
      deps.runs.updateStepRun(caseRunId, step.id, "fail", message, screenshotPath, stepStarted);
      deps.runs.emitStep(caseRunId, step.order, "fail");
      deps.runs.log("error", `${prefix} step s${step.order} (${step.action}) failed: ${message}`);
      deps.runs.markSkippedFrom(caseRunId, steps, index + 1);
      const traceDest = caseTracePath(deps.artifactsRoot, testCase.projectId, suiteRunId, caseId);
      try {
        await context.saveTrace(traceDest);
      } catch {
        deps.runs.log("warn", `${prefix} failed to save trace`);
      }
      const videoDest = caseVideoPath(deps.artifactsRoot, testCase.projectId, suiteRunId, caseId);
      if (await deps.runs.saveVideoQuietly(context, videoDest)) {
        deps.runs.setCaseVideoPath(caseRunId, videoDest);
      }
      await context.close();
      deps.runs.finishCaseRun(caseRunId, "failed", startedAt);
      return;
    }
  }
  if (deps.isCancelled(suiteRunId)) {
    await closeQuietly(context, deps.runs);
    deps.runs.finishCaseRun(caseRunId, "cancelled", startedAt);
    return;
  }
  try {
    await context.saveTrace(null);
  } catch {
    deps.runs.log("warn", `${prefix} failed to discard trace`);
  }
  await deps.runs.discardVideoQuietly(context);
  await context.close();
  deps.runs.finishCaseRun(caseRunId, "passed", startedAt);
}

async function closeQuietly(context: RunContext, runs: RunWriter): Promise<void> {
  try {
    await context.saveTrace(null);
  } catch {
    // Context may already be half-closed — cancellation still proceeds.
  }
  await runs.discardVideoQuietly(context);
  await context.close();
}
