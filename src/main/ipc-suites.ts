import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";

import type { SuiteCreatePayload, SuiteUpdatePayload } from "../shared/ipc-contract.js";
import {
  SuiteCreatePayload as SuiteCreateSchema,
  SuiteUpdatePayload as SuiteUpdateSchema,
} from "../shared/ipc-contract.js";
import type { Suite } from "../shared/schema.js";
import { SuiteSchema } from "../shared/schema.js";
import type { AppDatabase } from "./db.js";
import { inTransaction } from "./db.js";
import { removeSuiteArtifacts } from "./artifacts.js";
import { caseRuns, projects, stepRuns, suiteRuns, suiteTestCases, testCases } from "./schema.js";
import { testSuites } from "./schema.js";

/** Thrown when a suite id has no row — IPC maps this to a not-found error. */
export class SuiteNotFoundError extends Error {
  readonly suiteId: string;
  constructor(suiteId: string) {
    super(`suite not found: ${suiteId}`);
    this.name = "SuiteNotFoundError";
    this.suiteId = suiteId;
  }
}

/** Thrown when setCases references a case id with no row. */
export class SuiteCaseNotFoundError extends Error {
  readonly caseId: string;
  constructor(caseId: string) {
    super(`case not found: ${caseId}`);
    this.name = "SuiteCaseNotFoundError";
    this.caseId = caseId;
  }
}

/** Thrown when a case belongs to a different project than the suite. */
export class SuiteCaseProjectMismatchError extends Error {
  readonly caseId: string;
  constructor(caseId: string) {
    super(`case belongs to a different project: ${caseId}`);
    this.name = "SuiteCaseProjectMismatchError";
    this.caseId = caseId;
  }
}

function toSuite(row: { id: string; projectId: string; name: string; createdAt: number }): Suite {
  return SuiteSchema.parse(row);
}

function requireProject(db: AppDatabase, projectId: string): void {
  const rows = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .all();
  if (rows[0] === undefined) {
    throw new Error(`project not found: ${projectId}`);
  }
}

export function createSuite(db: AppDatabase, input: SuiteCreatePayload): Suite {
  const parsed = SuiteCreateSchema.parse(input);
  requireProject(db, parsed.projectId);
  const row = {
    id: randomUUID(),
    projectId: parsed.projectId,
    name: parsed.name,
    createdAt: Date.now(),
  };
  db.insert(testSuites).values(row).run();
  return toSuite(row);
}

export function listSuites(db: AppDatabase, projectId: string): Suite[] {
  const rows = db.select().from(testSuites).where(eq(testSuites.projectId, projectId)).all();
  return rows.map((r) =>
    toSuite({ id: r.id, projectId: r.projectId, name: r.name, createdAt: r.createdAt }),
  );
}

export function getSuite(db: AppDatabase, id: string): Suite {
  const rows = db.select().from(testSuites).where(eq(testSuites.id, id)).all();
  const found = rows[0];
  if (found === undefined) {
    throw new SuiteNotFoundError(id);
  }
  return toSuite({
    id: found.id,
    projectId: found.projectId,
    name: found.name,
    createdAt: found.createdAt,
  });
}

export function updateSuite(db: AppDatabase, input: SuiteUpdatePayload): Suite {
  const parsed = SuiteUpdateSchema.parse(input);
  const existing = getSuite(db, parsed.id);
  if (parsed.name !== undefined) {
    db.update(testSuites).set({ name: parsed.name }).where(eq(testSuites.id, parsed.id)).run();
  }
  return getSuite(db, existing.id);
}

/** Delete a suite, its join rows, its run history, and its artifact folders. */
export function deleteSuite(db: AppDatabase, id: string, opts?: { artifactsRoot?: string }): void {
  const suite = getSuite(db, id);
  const runIds = inTransaction(db, (tx) => {
    const runs = tx
      .select({ id: suiteRuns.id })
      .from(suiteRuns)
      .where(eq(suiteRuns.suiteId, id))
      .all();
    const runIds = runs.map((r) => r.id);
    if (runIds.length > 0) {
      const cases = tx
        .select({ id: caseRuns.id })
        .from(caseRuns)
        .where(inArray(caseRuns.suiteRunId, runIds))
        .all();
      const caseRunIds = cases.map((c) => c.id);
      if (caseRunIds.length > 0) {
        tx.delete(stepRuns).where(inArray(stepRuns.caseRunId, caseRunIds)).run();
      }
      tx.delete(caseRuns).where(inArray(caseRuns.suiteRunId, runIds)).run();
      tx.delete(suiteRuns).where(inArray(suiteRuns.id, runIds)).run();
    }
    tx.delete(suiteTestCases).where(eq(suiteTestCases.suiteId, id)).run();
    tx.delete(testSuites).where(eq(testSuites.id, id)).run();
    return runIds;
  });
  if (opts?.artifactsRoot !== undefined) {
    removeSuiteArtifacts(opts.artifactsRoot, suite.projectId, runIds);
  }
}

/** Ordered membership for a suite (insertion order is not tracked — sorted for stability). */
export function getSuiteCaseIds(db: AppDatabase, suiteId: string): string[] {
  getSuite(db, suiteId);
  const rows = db
    .select({ caseId: suiteTestCases.caseId })
    .from(suiteTestCases)
    .where(eq(suiteTestCases.suiteId, suiteId))
    .all();
  return rows.map((r) => r.caseId).sort();
}

/**
 * Replace suite membership. Validates every case exists and belongs to the
 * suite's project (cases are reusable across suites, never across projects).
 * Returns the deduplicated, sorted member ids.
 */
export function setSuiteCases(db: AppDatabase, suiteId: string, caseIds: string[]): string[] {
  const suite = getSuite(db, suiteId);
  const unique = [...new Set(caseIds)].sort();
  if (unique.length > 0) {
    const rows = db
      .select({ id: testCases.id, projectId: testCases.projectId })
      .from(testCases)
      .where(inArray(testCases.id, unique))
      .all();
    const byId = new Map(rows.map((r) => [r.id, r.projectId]));
    for (const caseId of unique) {
      const projectId = byId.get(caseId);
      if (projectId === undefined) {
        throw new SuiteCaseNotFoundError(caseId);
      }
      if (projectId !== suite.projectId) {
        throw new SuiteCaseProjectMismatchError(caseId);
      }
    }
  }
  return inTransaction(db, (tx) => {
    tx.delete(suiteTestCases).where(eq(suiteTestCases.suiteId, suiteId)).run();
    for (const caseId of unique) {
      tx.insert(suiteTestCases).values({ suiteId, caseId }).run();
    }
    return unique;
  });
}
