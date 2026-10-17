/**
 * "Re-run last failed" selection (M12, PLAN §18.5) — the `--last-failed`
 * analogue: find a suite's latest finished run and return its failed case ids.
 */

import { and, desc, eq, ne } from "drizzle-orm";

import type { AppDatabase } from "../db.js";
import { getSuite } from "../ipc-suites.js";
import { caseRuns, suiteRuns } from "../schema.js";

/** Thrown by rerunFailed when the source run has nothing failed to retry. */
export class NoFailedCasesError extends Error {
  constructor(suiteRunId: string) {
    super(`no failed cases to re-run for suite run: ${suiteRunId}`);
    this.name = "NoFailedCasesError";
  }
}

/** Latest finished run of a suite plus the failed case ids to retry (M12). */
export interface LastFailedSelection {
  suiteRunId: string;
  suiteId: string;
  mode: "unsupervised";
  caseIds: string[];
}

/**
 * Select the failed set of a suite's latest finished run (PLAN §18.5,
 * `--last-failed` analogue). Still-running rows are skipped so a live run is
 * never read mid-flight. Throws `NoFailedCasesError` when the latest
 * finished run has nothing failed (same message as `rerunFailed`).
 */
export function selectLastFailedCaseIds(db: AppDatabase, suiteId: string): LastFailedSelection {
  getSuite(db, suiteId);
  const latest = db
    .select()
    .from(suiteRuns)
    .where(and(eq(suiteRuns.suiteId, suiteId), ne(suiteRuns.status, "running")))
    .orderBy(desc(suiteRuns.startedAt))
    .all()[0];
  if (latest === undefined) {
    throw new NoFailedCasesError(`no finished run for suite: ${suiteId}`);
  }
  if (latest.suiteId === null) {
    throw new Error(`suite run has no suite: ${latest.id}`);
  }
  const failedCaseIds = db
    .select()
    .from(caseRuns)
    .where(eq(caseRuns.suiteRunId, latest.id))
    .all()
    .filter((r) => r.status === "failed")
    .map((r) => r.caseId);
  if (failedCaseIds.length === 0) {
    throw new NoFailedCasesError(latest.id);
  }
  return {
    suiteRunId: latest.id,
    suiteId: latest.suiteId,
    mode: latest.mode as "unsupervised",
    caseIds: failedCaseIds,
  };
}
