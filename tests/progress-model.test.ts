import { describe, expect, it } from "vitest";

import type { RunCaseProgress, RunProgress } from "../src/shared/ipc-contract.js";
import {
  caseStatusLabel,
  caseStatusTone,
  elapsedMs,
  formatElapsedMs,
  isSuiteRunFinished,
  runOutcomeLabel,
  runPercent,
  runVisualState,
  summarizeRunCases,
} from "../src/renderer/components/run-progress/progress-model.js";

function caseRow(status: RunCaseProgress["status"], index: number): RunCaseProgress {
  return {
    caseRunId: `cr-${index}`,
    caseId: `c-${index}`,
    caseName: `Case ${index}`,
    status,
    durationMs: null,
  };
}

function progress(overrides: Partial<RunProgress> = {}): RunProgress {
  return {
    suiteRunId: "run-1",
    suiteId: "suite-1",
    suiteName: "S",
    mode: "unsupervised",
    status: "running",
    startedAt: 1_000,
    endedAt: null,
    cases: [],
    summary: {
      total: 0,
      completed: 0,
      pending: 0,
      running: 0,
      passed: 0,
      failed: 0,
      cancelled: 0,
      skipped: 0,
    },
    ...overrides,
  };
}

describe("live suite progress model (M21)", () => {
  it("summarizes case buckets the same way the main query does", () => {
    const cases = [
      caseRow("pending", 0),
      caseRow("running", 1),
      caseRow("passed", 2),
      caseRow("failed", 3),
      caseRow("cancelled", 4),
      caseRow("skipped", 5),
    ];
    expect(summarizeRunCases(cases)).toEqual({
      total: 6,
      completed: 4,
      pending: 1,
      running: 1,
      passed: 1,
      failed: 1,
      cancelled: 1,
      skipped: 1,
    });
  });

  it("derives percent and an honest visual state", () => {
    const running = progress({
      summary: {
        total: 4,
        completed: 1,
        pending: 2,
        running: 1,
        passed: 1,
        failed: 0,
        cancelled: 0,
        skipped: 0,
      },
    });
    expect(runPercent(running)).toBe(25);
    expect(runVisualState(running)).toBe("running");
    expect(runVisualState(progress())).toBe("starting");
    expect(runVisualState(progress({ status: "passed" }))).toBe("passed");
    expect(runVisualState(progress({ status: "failed" }))).toBe("failed");
    expect(runVisualState(progress({ status: "cancelled" }))).toBe("cancelled");
    expect(runPercent(progress())).toBe(0);
  });

  it("knows terminal statuses and labels cases", () => {
    expect(isSuiteRunFinished("passed")).toBe(true);
    expect(isSuiteRunFinished("running")).toBe(false);
    expect(caseStatusLabel("pending")).toBe("pending");
    expect(caseStatusTone("passed")).toBe("pass");
    expect(caseStatusTone("failed")).toBe("fail");
    expect(caseStatusTone("running")).toBe("run");
    expect(caseStatusTone("cancelled")).toBe("warn");
    expect(caseStatusTone("pending")).toBe("mute");
  });

  it("formats elapsed time and terminal outcomes", () => {
    expect(formatElapsedMs(0)).toBe("0s");
    expect(formatElapsedMs(42_000)).toBe("42s");
    expect(formatElapsedMs(65_000)).toBe("1m 05s");
    expect(formatElapsedMs(723_000)).toBe("12m 03s");
    expect(elapsedMs(progress({ endedAt: 6_000 }), 99_000)).toBe(5_000);
    expect(elapsedMs(progress(), 6_000)).toBe(5_000);
    expect(
      runOutcomeLabel(
        progress({
          status: "passed",
          summary: {
            total: 2,
            completed: 2,
            pending: 0,
            running: 0,
            passed: 2,
            failed: 0,
            cancelled: 0,
            skipped: 0,
          },
        }),
      ),
    ).toContain("Run passed");
    expect(runOutcomeLabel(progress({ status: "failed" }))).toContain("Run failed");
    expect(runOutcomeLabel(progress({ status: "cancelled" }))).toContain("Run cancelled");
  });
});
