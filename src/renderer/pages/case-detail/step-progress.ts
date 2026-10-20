/**
 * Step-level progress for an active single-case run (M21). The renderer already
 * receives every step status over `run:step-update`; this pure helper turns
 * that stream into the progress bar's counts/phase so the rules are testable
 * without a DOM.
 */

import type { RunFinishedEvent } from "../../../shared/ipc-contract.js";
import type { StepStatus } from "../../../shared/step-types.js";

export type StepRunPhase =
  "idle" | "starting" | "running" | "paused" | "passed" | "failed" | "cancelled";

export interface StepProgress {
  total: number;
  completed: number;
  percent: number;
  passed: number;
  failed: number;
  skipped: number;
  running: number;
  pending: number;
  phase: StepRunPhase;
}

export interface StepProgressInput {
  statusByOrder: Record<number, StepStatus>;
  totalSteps: number;
  active: boolean;
  paused: boolean;
  /** Case-level summary from `run:finished`; null while idle/running. */
  summary: RunFinishedEvent["summary"] | null;
}

export function computeStepProgress(input: StepProgressInput): StepProgress {
  const entries = Object.entries(input.statusByOrder);
  let maxOrder = -1;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let running = 0;
  for (const [rawOrder, status] of entries) {
    const order = Number(rawOrder);
    if (Number.isInteger(order) && order > maxOrder) {
      maxOrder = order;
    }
    switch (status) {
      case "pass":
        passed += 1;
        break;
      case "fail":
        failed += 1;
        break;
      case "skipped":
        skipped += 1;
        break;
      case "running":
        running += 1;
        break;
    }
  }

  // Step edits while paused can add rows the run never saw; the observed
  // orders keep the denominator honest without inflating it from the editor.
  const total = Math.max(input.totalSteps, maxOrder + 1, 0);
  const completed = passed + failed + skipped;
  const pending = Math.max(0, total - completed - running);
  const percent =
    total === 0 ? 0 : Math.max(0, Math.min(100, Math.round((completed / total) * 100)));

  let phase: StepRunPhase;
  if (input.active) {
    if (input.paused) {
      phase = "paused";
    } else if (completed === 0 && running === 0) {
      phase = "starting";
    } else {
      phase = "running";
    }
  } else if (input.summary !== null) {
    phase = phaseFromSummary(input.summary);
  } else if (completed > 0) {
    phase = failed > 0 ? "failed" : passed > 0 ? "passed" : "cancelled";
  } else {
    phase = "idle";
  }

  return { total, completed, percent, passed, failed, skipped, running, pending, phase };
}

function phaseFromSummary(summary: RunFinishedEvent["summary"]): StepRunPhase {
  if (summary.failed > 0) {
    return "failed";
  }
  if (summary.passed > 0) {
    return "passed";
  }
  return "cancelled";
}
