import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/main/db.js";
import type { AppDatabase, DatabaseHandle } from "../src/main/db.js";
import { createCase } from "../src/main/ipc-cases.js";
import { createProject } from "../src/main/ipc-projects.js";
import { createSuite } from "../src/main/ipc-suites.js";
import { caseRuns, suiteRuns } from "../src/main/schema.js";
import { RunProgressSchema } from "../src/shared/ipc-contract.js";
import { RunNotFoundError, getRunProgress, isRunActive } from "../src/main/run-progress.js";

let openHandles: DatabaseHandle[] = [];
afterEach(() => {
  for (const handle of openHandles) {
    handle.close();
  }
  openHandles = [];
});

interface Seeded {
  db: AppDatabase;
  suiteRunId: string;
  caseIds: string[];
}

/** One suite run with one case per supplied status, inserted for control. */
function seed(statuses: Array<"pending" | "running" | "passed" | "failed" | "cancelled">): Seeded {
  const handle = createDatabase(":memory:");
  openHandles.push(handle);
  const db = handle.db;
  const project = createProject(db, { name: "P" });
  const suite = createSuite(db, { projectId: project.id, name: "Tax flows" });
  const cases = statuses.map((_, index) =>
    createCase(db, { projectId: project.id, name: `Case ${index}` }),
  );
  const suiteRunId = "run-1";
  db.insert(suiteRuns)
    .values({
      id: suiteRunId,
      suiteId: suite.id,
      mode: "unsupervised",
      status: statuses.every((s) => s === "passed") ? "passed" : "running",
      startedAt: 1_000,
      endedAt: statuses.every((s) => s === "passed") ? 2_000 : null,
    })
    .run();
  db.insert(caseRuns)
    .values(
      cases.map((testCase, index) => ({
        id: `cr-${index}`,
        suiteRunId,
        caseId: testCase.id,
        status: statuses[index] ?? "pending",
        durationMs: statuses[index] === "passed" ? 500 : null,
      })),
    )
    .run();
  return { db, suiteRunId, caseIds: cases.map((c) => c.id) };
}

describe("getRunProgress (M21)", () => {
  it("splits queued, running, and terminal cases into honest buckets", () => {
    const { db, suiteRunId, caseIds } = seed([
      "pending",
      "running",
      "passed",
      "failed",
      "cancelled",
    ]);
    const progress = getRunProgress(db, suiteRunId);

    expect(RunProgressSchema.parse(progress)).toEqual(progress);
    expect(progress.suiteName).toBe("Tax flows");
    expect(progress.mode).toBe("unsupervised");
    expect(progress.status).toBe("running");
    expect(progress.startedAt).toBe(1_000);
    expect(progress.endedAt).toBeNull();
    expect(progress.summary).toEqual({
      total: 5,
      completed: 3,
      pending: 1,
      running: 1,
      passed: 1,
      failed: 1,
      cancelled: 1,
      skipped: 0,
    });
    // Cases are returned in deterministic case-id order.
    expect(progress.cases.map((c) => c.caseId)).toEqual([...caseIds].sort());
    expect(progress.cases.find((c) => c.caseId === caseIds[2])?.caseName).toBe("Case 2");
    expect(progress.cases.find((c) => c.caseId === caseIds[2])?.durationMs).toBe(500);
  });

  it("reports a finished run's terminal status and timestamps", () => {
    const { db, suiteRunId } = seed(["passed"]);
    const progress = getRunProgress(db, suiteRunId);
    expect(progress.status).toBe("passed");
    expect(progress.endedAt).toBe(2_000);
    expect(progress.summary).toMatchObject({ total: 1, completed: 1, passed: 1, pending: 0 });
  });

  it("throws a named error for an unknown run", () => {
    const { db } = seed(["passed"]);
    expect(() => getRunProgress(db, "ghost")).toThrow(RunNotFoundError);
  });

  it("knows whether a report can still change", () => {
    const { db, suiteRunId } = seed(["running"]);
    expect(isRunActive(db, suiteRunId)).toBe(true);
    expect(isRunActive(db, "ghost")).toBe(false);
    expect(isRunActive(db, getRunProgress(db, suiteRunId).suiteRunId)).toBe(true);
  });
});
