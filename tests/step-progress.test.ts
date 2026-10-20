import { describe, expect, it } from "vitest";

import { computeStepProgress } from "../src/renderer/pages/case-detail/step-progress.js";

const summary = (passed: number, failed: number, skipped: number) => ({
  total: 1,
  passed,
  failed,
  skipped,
});

describe("computeStepProgress (M21)", () => {
  it("counts terminal and running steps and leaves the rest pending", () => {
    const progress = computeStepProgress({
      statusByOrder: { 0: "pass", 1: "running" },
      totalSteps: 4,
      active: true,
      paused: false,
      summary: null,
    });
    expect(progress).toMatchObject({
      total: 4,
      completed: 1,
      percent: 25,
      passed: 1,
      failed: 0,
      running: 1,
      pending: 2,
      phase: "running",
    });
  });

  it("is indeterminate while the browser/start emits no step event yet", () => {
    const progress = computeStepProgress({
      statusByOrder: {},
      totalSteps: 4,
      active: true,
      paused: false,
      summary: null,
    });
    expect(progress.phase).toBe("starting");
    expect(progress.completed).toBe(0);
    expect(progress.pending).toBe(4);
  });

  it("reports a supervised pause on the failed step", () => {
    const progress = computeStepProgress({
      statusByOrder: { 0: "pass", 1: "fail" },
      totalSteps: 4,
      active: true,
      paused: true,
      summary: null,
    });
    expect(progress.phase).toBe("paused");
    expect(progress.completed).toBe(2);
    expect(progress.failed).toBe(1);
  });

  it("derives the final verdict from the run:finished summary", () => {
    expect(
      computeStepProgress({
        statusByOrder: { 0: "pass", 1: "pass" },
        totalSteps: 2,
        active: false,
        paused: false,
        summary: summary(1, 0, 0),
      }).phase,
    ).toBe("passed");
    expect(
      computeStepProgress({
        statusByOrder: { 0: "fail", 1: "skipped" },
        totalSteps: 2,
        active: false,
        paused: false,
        summary: summary(0, 1, 0),
      }).phase,
    ).toBe("failed");
    expect(
      computeStepProgress({
        statusByOrder: { 0: "skipped" },
        totalSteps: 1,
        active: false,
        paused: false,
        summary: summary(0, 0, 1),
      }).phase,
    ).toBe("cancelled");
  });

  it("clamps the denominator to the highest observed step order", () => {
    const progress = computeStepProgress({
      statusByOrder: { 4: "pass" },
      totalSteps: 2,
      active: true,
      paused: false,
      summary: null,
    });
    expect(progress.total).toBe(5);
    expect(progress.percent).toBe(20);
  });

  it("stays idle before the first run", () => {
    expect(
      computeStepProgress({
        statusByOrder: {},
        totalSteps: 0,
        active: false,
        paused: false,
        summary: null,
      }).phase,
    ).toBe("idle");
  });
});
