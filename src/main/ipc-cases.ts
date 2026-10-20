import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";

import type { CaseCreatePayload, CaseUpdatePayload } from "../shared/ipc-contract.js";
import {
  CaseCreatePayload as CaseCreateSchema,
  CaseUpdatePayload as CaseUpdateSchema,
} from "../shared/ipc-contract.js";
import type { TestCase } from "../shared/schema.js";
import { TestCaseSchema } from "../shared/schema.js";
import { sortByName } from "../shared/sort.js";
import type { AppDatabase } from "./db.js";
import { inTransaction } from "./db.js";
import { removeCaseArtifacts } from "./artifacts.js";
import { deleteCaseProfile } from "./ipc-profiles.js";
import { caseRuns, projects, stepRuns, suiteTestCases, testData, testSteps } from "./schema.js";
import { testCases } from "./schema.js";

/** Thrown when a case id has no row — IPC maps this to a not-found error. */
export class CaseNotFoundError extends Error {
  readonly caseId: string;
  constructor(caseId: string) {
    super(`case not found: ${caseId}`);
    this.name = "CaseNotFoundError";
    this.caseId = caseId;
  }
}

function toTestCase(row: {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  url: string | null;
  createdAt: number;
}): TestCase {
  return TestCaseSchema.parse(
    row.description === null && row.url === null
      ? { id: row.id, projectId: row.projectId, name: row.name, createdAt: row.createdAt }
      : {
          id: row.id,
          projectId: row.projectId,
          name: row.name,
          ...(row.description !== null ? { description: row.description } : {}),
          ...(row.url !== null ? { url: row.url } : {}),
          createdAt: row.createdAt,
        },
  );
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

export function createCase(db: AppDatabase, input: CaseCreatePayload): TestCase {
  const parsed = CaseCreateSchema.parse(input);
  requireProject(db, parsed.projectId);
  const row = {
    id: randomUUID(),
    projectId: parsed.projectId,
    name: parsed.name,
    description: parsed.description ?? null,
    url: parsed.url ?? null,
    createdAt: Date.now(),
  };
  db.insert(testCases).values(row).run();
  return toTestCase(row);
}

export function listCases(db: AppDatabase, projectId: string): TestCase[] {
  const rows = db.select().from(testCases).where(eq(testCases.projectId, projectId)).all();
  return rows.map((r) =>
    toTestCase({
      id: r.id,
      projectId: r.projectId,
      name: r.name,
      description: r.description,
      url: r.url,
      createdAt: r.createdAt,
    }),
  );
}

export function getCase(db: AppDatabase, id: string): TestCase {
  const rows = db.select().from(testCases).where(eq(testCases.id, id)).all();
  const found = rows[0];
  if (found === undefined) {
    throw new CaseNotFoundError(id);
  }
  return toTestCase({
    id: found.id,
    projectId: found.projectId,
    name: found.name,
    description: found.description,
    url: found.url,
    createdAt: found.createdAt,
  });
}

export function updateCase(db: AppDatabase, input: CaseUpdatePayload): TestCase {
  const parsed = CaseUpdateSchema.parse(input);
  const existing = getCase(db, parsed.id);
  const patch: { name?: string; description?: string | null; url?: string | null } = {};
  if (parsed.name !== undefined) {
    patch.name = parsed.name;
  }
  if (parsed.description !== undefined) {
    patch.description = parsed.description;
  }
  if (parsed.url !== undefined) {
    patch.url = parsed.url;
  }
  if (Object.keys(patch).length > 0) {
    db.update(testCases).set(patch).where(eq(testCases.id, parsed.id)).run();
  }
  return getCase(db, existing.id);
}

/**
 * Delete a case and everything scoped to it (steps, test-data, suite joins,
 * its case profile, plus its case_runs and their step_runs). Suites that
 * referenced it keep their remaining members.
 */
export function deleteCase(db: AppDatabase, id: string, opts?: { artifactsRoot?: string }): void {
  const testCase = getCase(db, id);
  const suiteRunIds = inTransaction(db, (tx) => {
    const runs = tx
      .select({ id: caseRuns.id, suiteRunId: caseRuns.suiteRunId })
      .from(caseRuns)
      .where(eq(caseRuns.caseId, id))
      .all();
    const runIds = runs.map((r) => r.id);
    if (runIds.length > 0) {
      tx.delete(stepRuns).where(inArray(stepRuns.caseRunId, runIds)).run();
      tx.delete(caseRuns).where(inArray(caseRuns.id, runIds)).run();
    }
    tx.delete(suiteTestCases).where(eq(suiteTestCases.caseId, id)).run();
    tx.delete(testSteps).where(eq(testSteps.caseId, id)).run();
    tx.delete(testData).where(eq(testData.caseId, id)).run();
    deleteCaseProfile(tx, id);
    tx.delete(testCases).where(eq(testCases.id, id)).run();
    return [...new Set(runs.map((r) => r.suiteRunId))];
  });
  // Filesystem cleanup after the commit; optional so sync/test callers that
  // have no artifacts root keep working.
  if (opts?.artifactsRoot !== undefined) {
    removeCaseArtifacts(opts.artifactsRoot, testCase.projectId, suiteRunIds, id);
  }
}

/** Cases for an explicit id list in name order — backs the suite-detail table. */
export function listCasesByIds(db: AppDatabase, memberIds: string[]): TestCase[] {
  if (memberIds.length === 0) {
    return [];
  }
  const rows = db.select().from(testCases).where(inArray(testCases.id, memberIds)).all();
  return sortByName(
    rows.map((r) =>
      toTestCase({
        id: r.id,
        projectId: r.projectId,
        name: r.name,
        description: r.description,
        url: r.url,
        createdAt: r.createdAt,
      }),
    ),
  );
}
