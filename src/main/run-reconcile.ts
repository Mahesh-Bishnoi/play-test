/**
 * Startup reconciliation for runs interrupted by a quit/crash (review counted
 * #2). Run rows are written "running" and only the runner loop settles them;
 * an app quit mid-run would otherwise leave a perpetually running suite/case
 * and a "running" step forever. Called once after the DB opens, before any
 * window can read the history.
 */

import { eq, inArray } from "drizzle-orm";

import type { AppDatabase } from "./db.js";
import { inTransaction } from "./db.js";
import { caseRuns, stepRuns, suiteRuns } from "./schema.js";

export interface ReconcileResult {
  suites: number;
  cases: number;
  steps: number;
}

export function reconcileInterruptedRuns(db: AppDatabase): ReconcileResult {
  const now = Date.now();
  return inTransaction(db, (tx) => {
    const suites = tx
      .update(suiteRuns)
      .set({ status: "failed", endedAt: now })
      .where(eq(suiteRuns.status, "running"))
      .run();
    // Queued suite cases (`pending`) also belong to a run that will never
    // resume; settle them with the running ones so no row stays forever queued.
    const cases = tx
      .update(caseRuns)
      .set({ status: "failed" })
      .where(inArray(caseRuns.status, ["running", "pending"]))
      .run();
    const steps = tx
      .update(stepRuns)
      .set({ status: "skipped" })
      .where(eq(stepRuns.status, "running"))
      .run();
    return { suites: suites.changes, cases: cases.changes, steps: steps.changes };
  });
}
