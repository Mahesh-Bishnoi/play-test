import type { AppDatabase } from "./db.js";
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  exportFileName,
  parseExportText,
  type ExportCase,
  type ExportFile,
  type ExportScope,
  type ExportStep,
} from "../shared/export-format.js";
import { CaseProfileInputSchema } from "../shared/schema.js";
import { getCaseProfile, setCaseProfile } from "./ipc-profiles.js";
import { getProject } from "./ipc-projects.js";
import { createProject, deleteProject } from "./ipc-projects.js";
import { getCase, createCase, deleteCase, listCases, listCasesByIds } from "./ipc-cases.js";
import { getSuite, createSuite, deleteSuite, getSuiteCaseIds } from "./ipc-suites.js";
import { listSuites, setSuiteCases } from "./ipc-suites.js";
import { getTestData, listSteps, setTestData, upsertStep } from "./ipc-steps.js";

/** Thrown when a file's scope doesn't match the import channel used. */
export class ExportScopeMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`expected a ${expected} export, got ${actual}`);
    this.name = "ExportScopeMismatchError";
  }
}

/**
 * File + dialog surface for import/export. The composition root (main.ts)
 * injects the real Electron dialogs + fs; tests inject fakes — transfer.ts
 * itself never imports Electron.
 */
export interface TransferIoDeps {
  showSaveDialog(defaultFileName: string): Promise<string | null>;
  showOpenDialog(): Promise<string | null>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, text: string): Promise<void>;
}

export interface ExportResult {
  saved: boolean;
  path?: string;
}

export interface ImportResult {
  imported: boolean;
  summary?: ImportSummary;
}

/** Save-dialog flow for one built export file. */
export async function saveExportFile(
  io: TransferIoDeps,
  baseName: string,
  scope: ExportScope,
  file: ExportFile,
): Promise<ExportResult> {
  const chosen = await io.showSaveDialog(exportFileName(baseName, scope));
  if (chosen === null) {
    return { saved: false };
  }
  await io.writeTextFile(chosen, JSON.stringify(file, null, 2));
  return { saved: true, path: chosen };
}

/** Open-dialog flow: read a file, parse + validate, run the importer. */
export async function loadImportFile(
  io: TransferIoDeps,
  run: (file: ExportFile) => ImportSummary,
): Promise<ImportResult> {
  const chosen = await io.showOpenDialog();
  if (chosen === null) {
    return { imported: false };
  }
  const text = await io.readTextFile(chosen);
  const summary = run(parseExportText(text));
  return { imported: true, summary };
}

export interface ImportSummary {
  projectId: string;
  suiteIds: string[];
  caseIds: string[];
  caseCount: number;
  stepCount: number;
}

function toExportSteps(
  rows: Array<{
    order: number;
    action: string;
    selector?: string;
    value?: string;
    timeoutMs?: number;
  }>,
): ExportStep[] {
  return [...rows]
    .sort((a, b) => a.order - b.order)
    .map((s) => ({
      order: s.order,
      action: s.action,
      ...(s.selector !== undefined ? { selector: s.selector } : {}),
      ...(s.value !== undefined ? { value: s.value } : {}),
      ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
    })) as ExportStep[];
}

function readCaseBundle(db: AppDatabase, caseId: string): ExportCase {
  const c = getCase(db, caseId);
  const steps = toExportSteps(listSteps(db, caseId));
  const testData = getTestData(db, { caseId });
  // Profile travels as the mutable input shape only (the shared schema strips
  // identity: `caseId`/`updatedAt`). Auth state file CONTENTS never travel —
  // just the filenames. An absent/empty profile stays absent in the bundle.
  const stored = getCaseProfile(db, caseId);
  const profile = stored === null ? null : CaseProfileInputSchema.parse(stored);
  return {
    name: c.name,
    ...(c.description !== undefined ? { description: c.description } : {}),
    ...(c.url !== undefined ? { url: c.url } : {}),
    steps,
    testData,
    ...(profile !== null && Object.keys(profile).length > 0 ? { profile } : {}),
  };
}

/** Full project bundle: every suite + every case (member or not) + steps + KV. */
export function buildProjectExport(db: AppDatabase, projectId: string): ExportFile {
  const project = getProject(db, projectId);
  const suites = listSuites(db, projectId);
  const allCases = listCases(db, projectId);
  const nameById = new Map(allCases.map((c) => [c.id, c.name]));
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    scope: "project",
    project: {
      name: project.name,
      ...(project.baseUrl !== undefined ? { baseUrl: project.baseUrl } : {}),
    },
    suites: suites.map((s) => ({
      name: s.name,
      caseNames: getSuiteCaseIds(db, s.id).map((id) => nameById.get(id) ?? "(missing)"),
    })),
    cases: allCases.map((c) => readCaseBundle(db, c.id)),
  };
}

/** Single-suite bundle: the suite + its member cases + their steps + KV. */
export function buildSuiteExport(db: AppDatabase, suiteId: string): ExportFile {
  const suite = getSuite(db, suiteId);
  const project = getProject(db, suite.projectId);
  const memberIds = getSuiteCaseIds(db, suiteId);
  const members = listCasesByIds(db, memberIds);
  const nameById = new Map(members.map((c) => [c.id, c.name]));
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    scope: "suite",
    sourceProjectName: project.name,
    suites: [
      { name: suite.name, caseNames: memberIds.map((id) => nameById.get(id) ?? "(missing)") },
    ],
    cases: members.map((c) => readCaseBundle(db, c.id)),
  };
}

/** Single-case bundle: one case + its steps + KV. */
export function buildCaseExport(db: AppDatabase, caseId: string): ExportFile {
  const c = getCase(db, caseId);
  const project = getProject(db, c.projectId);
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    scope: "case",
    sourceProjectName: project.name,
    suites: [],
    cases: [readCaseBundle(db, caseId)],
  };
}

/** Create one case (fresh ids) with steps + KV; returns the new id + step count. */
function createCaseFromBundle(
  db: AppDatabase,
  projectId: string,
  bundle: ExportCase,
): { caseId: string; steps: number } {
  const created = createCase(db, {
    projectId,
    name: bundle.name,
    ...(bundle.description !== undefined ? { description: bundle.description } : {}),
    ...(bundle.url !== undefined ? { url: bundle.url } : {}),
  });
  const ordered = [...bundle.steps].sort((a, b) => a.order - b.order);
  ordered.forEach((step, index) => {
    upsertStep(db, { caseId: created.id, step: { ...step, order: index } });
  });
  if (Object.keys(bundle.testData).length > 0) {
    setTestData(db, { caseId: created.id, data: bundle.testData });
  }
  // Fresh id: the profile (filenames only) is copied onto the new case.
  if (bundle.profile !== undefined) {
    setCaseProfile(db, created.id, bundle.profile);
  }
  return { caseId: created.id, steps: ordered.length };
}

/**
 * Import a project-scope file as a brand-new project (name + baseUrl kept,
 * all ids regenerated, membership remapped by case name). Atomic: a failure
 * deletes the half-created project.
 */
export function importProjectBundle(db: AppDatabase, file: ExportFile): ImportSummary {
  if (file.scope !== "project" || file.project === undefined) {
    throw new ExportScopeMismatchError("project", file.scope);
  }
  const created = createProject(db, {
    name: file.project.name,
    ...(file.project.baseUrl !== undefined ? { baseUrl: file.project.baseUrl } : {}),
  });
  try {
    const nameQueues = new Map<string, string[]>();
    const caseIds: string[] = [];
    let steps = 0;
    for (const bundle of file.cases) {
      const r = createCaseFromBundle(db, created.id, bundle);
      caseIds.push(r.caseId);
      steps += r.steps;
      const queue = nameQueues.get(bundle.name) ?? [];
      queue.push(r.caseId);
      nameQueues.set(bundle.name, queue);
    }
    const suiteIds: string[] = [];
    for (const bundle of file.suites) {
      const suite = createSuite(db, { projectId: created.id, name: bundle.name });
      suiteIds.push(suite.id);
      const memberIds = bundle.caseNames
        .map((n) => nameQueues.get(n)?.shift())
        .filter((id): id is string => id !== undefined);
      setSuiteCases(db, suite.id, memberIds);
    }
    return {
      projectId: created.id,
      suiteIds,
      caseIds,
      caseCount: caseIds.length,
      stepCount: steps,
    };
  } catch (err) {
    deleteProject(db, created.id);
    throw err;
  }
}

/**
 * Import a suite-scope file into an existing project. The target project's
 * baseUrl wins (source baseUrl is not carried — cases hold no baseUrl).
 * Atomic: removes created suites/cases on failure.
 */
export function importSuiteBundle(
  db: AppDatabase,
  file: ExportFile,
  projectId: string,
): ImportSummary {
  if (file.scope !== "suite") {
    throw new ExportScopeMismatchError("suite", file.scope);
  }
  getProject(db, projectId);
  const createdSuites: string[] = [];
  const createdCases: string[] = [];
  try {
    const nameQueues = new Map<string, string[]>();
    let steps = 0;
    for (const bundle of file.cases) {
      const r = createCaseFromBundle(db, projectId, bundle);
      createdCases.push(r.caseId);
      steps += r.steps;
      const queue = nameQueues.get(bundle.name) ?? [];
      queue.push(r.caseId);
      nameQueues.set(bundle.name, queue);
    }
    for (const bundle of file.suites) {
      const suite = createSuite(db, { projectId, name: bundle.name });
      createdSuites.push(suite.id);
      const memberIds = bundle.caseNames
        .map((n) => nameQueues.get(n)?.shift())
        .filter((id): id is string => id !== undefined);
      setSuiteCases(db, suite.id, memberIds);
    }
    return {
      projectId,
      suiteIds: createdSuites,
      caseIds: createdCases,
      caseCount: createdCases.length,
      stepCount: steps,
    };
  } catch (err) {
    for (const id of createdSuites) {
      try {
        deleteSuite(db, id);
      } catch {
        // Rollback is best-effort; the original error carries the failure.
      }
    }
    for (const id of createdCases) {
      try {
        deleteCase(db, id);
      } catch {
        // Best-effort (see above).
      }
    }
    throw err;
  }
}

/**
 * Import case-scope files into a project, optionally appending to suites.
 * Suite membership merges (existing members kept); foreign suites rejected
 * by the same-project check in setSuiteCases.
 */
export function importCaseBundle(
  db: AppDatabase,
  file: ExportFile,
  projectId: string,
  suiteIds: string[] = [],
): ImportSummary {
  if (file.scope !== "case") {
    throw new ExportScopeMismatchError("case", file.scope);
  }
  getProject(db, projectId);
  for (const suiteId of suiteIds) {
    const suite = getSuite(db, suiteId);
    if (suite.projectId !== projectId) {
      throw new Error(`suite belongs to a different project: ${suiteId}`);
    }
  }
  const createdCases: string[] = [];
  try {
    let steps = 0;
    for (const bundle of file.cases) {
      const r = createCaseFromBundle(db, projectId, bundle);
      createdCases.push(r.caseId);
      steps += r.steps;
    }
    for (const suiteId of suiteIds) {
      setSuiteCases(db, suiteId, [...getSuiteCaseIds(db, suiteId), ...createdCases]);
    }
    return {
      projectId,
      suiteIds,
      caseIds: createdCases,
      caseCount: createdCases.length,
      stepCount: steps,
    };
  } catch (err) {
    for (const id of createdCases) {
      try {
        deleteCase(db, id);
      } catch {
        // Rollback is best-effort; the original error carries the failure.
      }
    }
    throw err;
  }
}
