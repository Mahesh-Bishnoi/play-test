/**
 * Pure display model for live suite/case progress (M21). Kept free of React so
 * the counts, percentages, phase rules, and elapsed formatting are unit-tested
 * directly; the polling hook and panel only render these values.
 */

import type { RunCaseProgress, RunProgress } from "../../../shared/ipc-contract.js";
import type { CaseRunStatus, SuiteRunStatus } from "../../../shared/schema.js";

export type RunVisualState = "starting" | "running" | "passed" | "failed" | "cancelled";

export type CaseStatusTone = "mute" | "run" | "pass" | "fail" | "warn";

export interface RunProgressCounts {
  total: number;
  completed: number;
  pending: number;
  running: number;
  passed: number;
  failed: number;
  cancelled: number;
  skipped: number;
}

/** Derive the same buckets the main-process snapshot exposes (tests + panel). */
export function summarizeRunCases(cases: RunCaseProgress[]): RunProgressCounts {
  const pending = cases.filter((c) => c.status === "pending").length;
  const running = cases.filter((c) => c.status === "running").length;
  return {
    total: cases.length,
    completed: Math.max(0, cases.length - pending - running),
    pending,
    running,
    passed: cases.filter((c) => c.status === "passed").length,
    failed: cases.filter((c) => c.status === "failed").length,
    cancelled: cases.filter((c) => c.status === "cancelled").length,
    skipped: cases.filter((c) => c.status === "skipped").length,
  };
}

export function runPercent(progress: RunProgress): number {
  if (progress.summary.total <= 0) {
    return 0;
  }
  const percent = Math.round((progress.summary.completed / progress.summary.total) * 100);
  return Math.max(0, Math.min(100, percent));
}

/**
 * A suite with no completed cases yet is still spinning up (or running its
 * first long case) — showing an indeterminate bar is more honest than 0%.
 */
export function runVisualState(progress: RunProgress): RunVisualState {
  if (progress.status === "pending") {
    return "starting";
  }
  if (progress.status === "running") {
    return progress.summary.completed === 0 ? "starting" : "running";
  }
  if (progress.status === "passed") {
    return "passed";
  }
  if (progress.status === "failed") {
    return "failed";
  }
  return "cancelled";
}

export function isSuiteRunFinished(status: SuiteRunStatus): boolean {
  return status === "passed" || status === "failed" || status === "cancelled";
}

export function caseStatusTone(status: CaseRunStatus): CaseStatusTone {
  switch (status) {
    case "passed":
      return "pass";
    case "failed":
      return "fail";
    case "running":
      return "run";
    case "cancelled":
    case "skipped":
      return "warn";
    default:
      return "mute";
  }
}

export function caseStatusLabel(status: CaseRunStatus): string {
  return status === "pending" ? "pending" : status;
}

/** Compact elapsed time: `0s`, `42s`, `1m 05s`, `12m 03s`. */
export function formatElapsedMs(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  if (safe < 60_000) {
    return `${Math.floor(safe / 1000)}s`;
  }
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function elapsedMs(progress: RunProgress, now: number): number {
  return Math.max(0, (progress.endedAt ?? now) - progress.startedAt);
}

/** Terminal one-liner for the panel's live region. */
export function runOutcomeLabel(progress: RunProgress): string {
  const { passed, failed, cancelled, total } = progress.summary;
  switch (progress.status) {
    case "passed":
      return `Run passed — ${passed} of ${total} case(s) passed.`;
    case "failed":
      return `Run failed — ${passed} passed, ${failed} failed of ${total}.`;
    case "cancelled":
      return `Run cancelled — ${cancelled > 0 ? `${cancelled} cancelled, ` : ""}${passed} passed of ${total}.`;
    default:
      return progress.status === "pending" ? "Run queued." : "Run in progress.";
  }
}
