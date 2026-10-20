import { describe, expect, it } from "vitest";

import { createDatabase } from "../src/main/db.js";
import { reconcileInterruptedRuns } from "../src/main/run-reconcile.js";
import { caseRuns, stepRuns, suiteRuns } from "../src/main/schema.js";

describe("reconcileInterruptedRuns (review counted #2)", () => {
  it("settles rows left running by a quit/crash", () => {
    const handle = createDatabase(":memory:");
    try {
      handle.db
        .insert(suiteRuns)
        .values({ id: "sr", suiteId: null, mode: "supervised", status: "running", startedAt: 1 })
        .run();
      handle.db
        .insert(caseRuns)
        .values({ id: "cr", suiteRunId: "sr", caseId: "case", status: "running" })
        .run();
      handle.db
        .insert(stepRuns)
        .values({
          id: "st",
          caseRunId: "cr",
          stepId: "step",
          order: 0,
          status: "running",
        })
        .run();

      expect(reconcileInterruptedRuns(handle.db)).toEqual({ suites: 1, cases: 1, steps: 1 });
      expect(handle.db.select().from(suiteRuns).all()[0]).toMatchObject({
        status: "failed",
      });
      expect(handle.db.select().from(caseRuns).all()[0]).toMatchObject({ status: "failed" });
      expect(handle.db.select().from(stepRuns).all()[0]).toMatchObject({ status: "skipped" });
      // Idempotent: a second launch has nothing to settle.
      expect(reconcileInterruptedRuns(handle.db)).toEqual({ suites: 0, cases: 0, steps: 0 });
    } finally {
      handle.close();
    }
  });
});
