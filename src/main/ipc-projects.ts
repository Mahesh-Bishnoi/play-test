import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";

import type { ProjectCreatePayload } from "../shared/ipc-contract.js";
import type { ProjectUpdatePayload } from "../shared/ipc-contract.js";
import {
  ProjectCreatePayload as ProjectCreateSchema,
  ProjectUpdatePayload as ProjectUpdateSchema,
} from "../shared/ipc-contract.js";
import type { Project } from "../shared/schema.js";
import { ProjectSchema } from "../shared/schema.js";
import type { AppDatabase } from "./db.js";
import { defaultArtifactsRoot, removeProjectArtifacts } from "./artifacts.js";
import {
  caseProfiles,
  caseRuns,
  stepRuns,
  suiteRuns,
  suiteTestCases,
  testCases,
  testData,
  testSteps,
  testSuites,
} from "./schema.js";
import { projects } from "./schema.js";

/** Thrown when a project id has no row — IPC maps this to a not-found error. */
export class ProjectNotFoundError extends Error {
  readonly projectId: string;
  constructor(projectId: string) {
    super(`project not found: ${projectId}`);
    this.name = "ProjectNotFoundError";
    this.projectId = projectId;
  }
}

interface ProjectRow {
  id: string;
  name: string;
  baseUrl: string | null;
  createdAt: number;
}

function toProject(row: {
  id: string;
  name: string;
  baseUrl: string | null;
  createdAt: number;
}): Project {
  const normalized: ProjectRow = {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    createdAt: row.createdAt,
  };
  return ProjectSchema.parse(
    normalized.baseUrl === null
      ? { id: normalized.id, name: normalized.name, createdAt: normalized.createdAt }
      : normalized,
  );
}

export function createProject(db: AppDatabase, input: ProjectCreatePayload): Project {
  const parsed = ProjectCreateSchema.parse(input);
  const now = Date.now();
  const row = {
    id: randomUUID(),
    name: parsed.name,
    baseUrl: parsed.baseUrl ?? null,
    createdAt: now,
  };
  db.insert(projects).values(row).run();
  return toProject(row);
}

export function listProjects(db: AppDatabase): Project[] {
  const rows = db.select().from(projects).all();
  return rows.map((r) =>
    toProject({ id: r.id, name: r.name, baseUrl: r.baseUrl, createdAt: r.createdAt }),
  );
}

export function getProject(db: AppDatabase, id: string): Project {
  const rows = db.select().from(projects).where(eq(projects.id, id)).all();
  const found: { id: string; name: string; baseUrl: string | null; createdAt: number } | undefined =
    rows[0];
  if (found === undefined) {
    throw new ProjectNotFoundError(id);
  }
  return toProject(found);
}

/** Narrow update input — full shape validated by the IPC contract schema. */
export function updateProject(db: AppDatabase, input: ProjectUpdatePayload): Project {
  const parsed = ProjectUpdateSchema.parse(input);
  const existing = getProject(db, parsed.id);
  const patch: { name?: string; baseUrl?: string | null } = {};
  if (parsed.name !== undefined) {
    patch.name = parsed.name;
  }
  if (parsed.baseUrl !== undefined) {
    patch.baseUrl = parsed.baseUrl;
  }
  if (Object.keys(patch).length > 0) {
    db.update(projects).set(patch).where(eq(projects.id, parsed.id)).run();
  }
  return getProject(db, existing.id);
}

/**
 * Delete a project and everything scoped to it (suites, cases, steps,
 * test-data, case profiles, join rows, all run history) plus its artifact tree.
 * Sequential deletes are safe: single writer, no concurrent IPC mutation
 * mid-delete. `opts.artifactsRoot` is injectable so tests use a tmp dir;
 * production passes the real ~/PlayTestData root.
 */
export function deleteProject(
  db: AppDatabase,
  id: string,
  opts?: { artifactsRoot?: string },
): void {
  getProject(db, id);
  const suites = db
    .select({ id: testSuites.id })
    .from(testSuites)
    .where(eq(testSuites.projectId, id))
    .all();
  const cases = db
    .select({ id: testCases.id })
    .from(testCases)
    .where(eq(testCases.projectId, id))
    .all();
  const suiteIds = suites.map((s) => s.id);
  const caseIds = cases.map((c) => c.id);

  // Run history first (child-to-parent): step_runs → case_runs → suite_runs.
  // case_runs rows are reachable by suite-run id (suite runs) or by case id
  // (supervised single-case runs), so collect both.
  const suiteRunIds = new Set<string>();
  if (suiteIds.length > 0) {
    const bySuite = db
      .select({ id: suiteRuns.id })
      .from(suiteRuns)
      .where(inArray(suiteRuns.suiteId, suiteIds))
      .all();
    for (const r of bySuite) {
      suiteRunIds.add(r.id);
    }
  }
  if (caseIds.length > 0) {
    const byCase = db
      .select({ suiteRunId: caseRuns.suiteRunId })
      .from(caseRuns)
      .where(inArray(caseRuns.caseId, caseIds))
      .all();
    for (const r of byCase) {
      suiteRunIds.add(r.suiteRunId);
    }
  }
  const caseRunIds: string[] = [];
  if (suiteRunIds.size > 0) {
    const ids = [...suiteRunIds];
    const bySuiteRun = db
      .select({ id: caseRuns.id })
      .from(caseRuns)
      .where(inArray(caseRuns.suiteRunId, ids))
      .all();
    for (const r of bySuiteRun) {
      caseRunIds.push(r.id);
    }
  }
  if (caseIds.length > 0) {
    const byCase = db
      .select({ id: caseRuns.id })
      .from(caseRuns)
      .where(inArray(caseRuns.caseId, caseIds))
      .all();
    for (const r of byCase) {
      if (!caseRunIds.includes(r.id)) {
        caseRunIds.push(r.id);
      }
    }
  }
  if (caseRunIds.length > 0) {
    db.delete(stepRuns).where(inArray(stepRuns.caseRunId, caseRunIds)).run();
    db.delete(caseRuns).where(inArray(caseRuns.id, caseRunIds)).run();
  }
  if (suiteRunIds.size > 0) {
    db.delete(suiteRuns)
      .where(inArray(suiteRuns.id, [...suiteRunIds]))
      .run();
  }

  if (suiteIds.length > 0) {
    db.delete(suiteTestCases).where(inArray(suiteTestCases.suiteId, suiteIds)).run();
    db.delete(testSuites).where(inArray(testSuites.id, suiteIds)).run();
  }
  if (caseIds.length > 0) {
    db.delete(caseProfiles).where(inArray(caseProfiles.caseId, caseIds)).run();
    db.delete(testSteps).where(inArray(testSteps.caseId, caseIds)).run();
    db.delete(testData).where(inArray(testData.caseId, caseIds)).run();
    db.delete(testCases).where(inArray(testCases.id, caseIds)).run();
  }
  db.delete(projects).where(eq(projects.id, id)).run();
  removeProjectArtifacts(opts?.artifactsRoot ?? defaultArtifactsRoot(), id);
}
