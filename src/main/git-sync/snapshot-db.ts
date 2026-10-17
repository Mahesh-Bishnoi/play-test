/**
 * DB <-> snapshot: turn a project's rows into the definitions-only snapshot
 * written to git, and write validated snapshot content back into the DB
 * (clone, take-remote, merged pull).
 */

import fs from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";

import { CaseProfileInputSchema } from "../../shared/schema.js";
import type { AppDatabase } from "../db.js";
import { getCase, listCases } from "../ipc-cases.js";
import { getCaseProfile, setCaseProfile } from "../ipc-profiles.js";
import { getProject, updateProject } from "../ipc-projects.js";
import { getTestData, listSteps } from "../ipc-steps.js";
import { getSuite, listSuites } from "../ipc-suites.js";
import { suiteTestCases, testCases, testData, testSteps, testSuites } from "../schema.js";
import {
  canonical,
  type Snapshot,
  type SnapshotCase,
  type SnapshotStep,
  type SnapshotSuite,
} from "./snapshot.js";

// --- DB <-> snapshot ----------------------------------------------------------

export function readSnapshotFromDb(db: AppDatabase, projectId: string): Snapshot {
  const project = getProject(db, projectId);
  const suites: Record<string, SnapshotSuite> = {};
  for (const suite of listSuites(db, projectId)) {
    const memberIds = db
      .select({ caseId: suiteTestCases.caseId })
      .from(suiteTestCases)
      .where(eq(suiteTestCases.suiteId, suite.id))
      .all()
      .map((r) => r.caseId);
    suites[suite.id] = { id: suite.id, name: suite.name, memberCaseIds: memberIds };
  }
  const cases: Record<string, SnapshotCase> = {};
  for (const c of listCases(db, projectId)) {
    const steps = listSteps(db, c.id).map((s) => ({
      id: s.id,
      order: s.order,
      action: s.action,
      ...(s.selector !== undefined ? { selector: s.selector } : {}),
      ...(s.value !== undefined ? { value: s.value } : {}),
      ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
    }));
    // Profile identity is dropped (shared schema) and an empty profile is
    // omitted, so "no row" and a blank row hash the same everywhere.
    const stored = getCaseProfile(db, c.id);
    const profile = stored === null ? null : CaseProfileInputSchema.parse(stored);
    cases[c.id] = {
      id: c.id,
      name: c.name,
      ...(c.description !== undefined ? { description: c.description } : {}),
      ...(c.url !== undefined ? { url: c.url } : {}),
      steps: steps as SnapshotStep[],
      testData: getTestData(db, { caseId: c.id }),
      ...(profile !== null && Object.keys(profile).length > 0 ? { profile } : {}),
    };
  }
  return {
    project: {
      id: project.id,
      name: project.name,
      ...(project.baseUrl !== undefined ? { baseUrl: project.baseUrl } : {}),
    },
    suites,
    cases,
  };
}

export function writeSnapshotFiles(dir: string, snapshot: Snapshot): void {
  fs.writeFileSync(path.join(dir, "project.json"), `${canonical(snapshot.project)}\n`);
  fs.rmSync(path.join(dir, "suites"), { recursive: true, force: true });
  fs.rmSync(path.join(dir, "cases"), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "suites"), { recursive: true });
  fs.mkdirSync(path.join(dir, "cases"), { recursive: true });
  for (const [id, suite] of Object.entries(snapshot.suites)) {
    assertSafeId(id);
    fs.writeFileSync(path.join(dir, "suites", `${id}.json`), `${canonical(suite)}\n`);
  }
  for (const [id, c] of Object.entries(snapshot.cases)) {
    assertSafeId(id);
    fs.writeFileSync(path.join(dir, "cases", `${id}.json`), `${canonical(c)}\n`);
  }
}

function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    throw new Error(`unsafe entity id in snapshot: ${id}`);
  }
}

/** Insert snapshot content under an existing project id (clone, take-remote). */
export function insertSnapshotContent(db: AppDatabase, snapshot: Snapshot): void {
  const now = Date.now();
  const projectId = snapshot.project.id;
  getProject(db, projectId);
  for (const c of Object.values(snapshot.cases)) {
    insertCaseContent(db, projectId, c, now);
  }
  for (const suite of Object.values(snapshot.suites)) {
    insertSuiteContent(db, projectId, suite, now);
  }
  updateProject(db, {
    id: projectId,
    name: snapshot.project.name,
    baseUrl: snapshot.project.baseUrl ?? null,
  });
  for (const suite of Object.values(snapshot.suites)) {
    setMembership(db, suite);
  }
}

export function insertCaseContent(
  db: AppDatabase,
  projectId: string,
  c: SnapshotCase,
  now: number,
): void {
  try {
    getCase(db, c.id);
    throw new Error(`case already exists in this database: ${c.id}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("case already exists")) {
      throw err;
    }
  }
  db.insert(testCases)
    .values({
      id: c.id,
      projectId,
      name: c.name,
      description: c.description ?? null,
      url: c.url ?? null,
      createdAt: now,
    })
    .run();
  c.steps
    .slice()
    .sort((a, b) => a.order - b.order)
    .forEach((step, index) => {
      db.insert(testSteps)
        .values({
          id: step.id,
          caseId: c.id,
          order: index,
          action: step.action,
          selector: step.selector ?? null,
          value: step.value ?? null,
          timeoutMs: step.timeoutMs ?? null,
          editedAt: now,
        })
        .run();
    });
  for (const [key, value] of Object.entries(c.testData)) {
    db.insert(testData).values({ caseId: c.id, key, value }).run();
  }
  // The profile is part of the case entity — set it authoritatively so a case
  // re-inserted after a direct delete never keeps a stale profile row.
  setCaseProfile(db, c.id, c.profile ?? {});
}

export function insertSuiteContent(
  db: AppDatabase,
  projectId: string,
  suite: SnapshotSuite,
  now: number,
): void {
  try {
    getSuite(db, suite.id);
    throw new Error(`suite already exists in this database: ${suite.id}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("suite already exists")) {
      throw err;
    }
  }
  db.insert(testSuites).values({ id: suite.id, projectId, name: suite.name, createdAt: now }).run();
}

export function setMembership(db: AppDatabase, suite: SnapshotSuite): void {
  const members = [...new Set(suite.memberCaseIds)];
  for (const caseId of members) {
    getCase(db, caseId);
  }
  db.delete(suiteTestCases).where(eq(suiteTestCases.suiteId, suite.id)).run();
  for (const caseId of members) {
    db.insert(suiteTestCases).values({ suiteId: suite.id, caseId }).run();
  }
}
