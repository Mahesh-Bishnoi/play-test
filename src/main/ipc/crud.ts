import type { AppDatabase } from "../db.js";
import { createCase, deleteCase, getCase, listCases, updateCase } from "../ipc-cases.js";
import { getCaseProfile, setCaseProfile } from "../ipc-profiles.js";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from "../ipc-projects.js";
import {
  deleteStep,
  getTestData,
  listSteps,
  moveStep,
  reorderSteps,
  setTestData,
  upsertStep,
} from "../ipc-steps.js";
import {
  createSuite,
  deleteSuite,
  getSuite,
  getSuiteCaseIds,
  listSuites,
  setSuiteCases,
  updateSuite,
} from "../ipc-suites.js";
import type { IpcHandleFn } from "./handle.js";
import { payloadSchema } from "./handle.js";

const PROJECT_CHANNELS = [
  "project:create",
  "project:list",
  "project:get",
  "project:update",
  "project:delete",
] as const;

const SUITE_CHANNELS = [
  "suite:create",
  "suite:list",
  "suite:get",
  "suite:update",
  "suite:delete",
  "suite:setCases",
] as const;

const CASE_CHANNELS = [
  "case:create",
  "case:list",
  "case:get",
  "case:update",
  "case:delete",
] as const;

const STEP_CHANNELS = ["step:upsert", "step:move", "step:delete", "step:reorder"] as const;

const TESTDATA_CHANNELS = ["testdata:get", "testdata:set"] as const;

const PROFILE_CHANNELS = ["profile:get", "profile:set"] as const;

/** Optional wiring the main process supplies to destructive handlers. */
export interface CrudHandlerDeps {
  /** True while a single-case or suite run owns the DB/window. */
  isRunActive?: () => boolean;
  /** Root used to remove a deleted case/suite's run folders. */
  artifactsRoot?: string;
}

/** Thrown when a delete would race a live run writing its own rows. */
export class RunActiveDeleteError extends Error {
  constructor() {
    super("a run is active — cancel it or let it finish before deleting");
    this.name = "RunActiveDeleteError";
  }
}

function assertNoActiveRun(deps: CrudHandlerDeps): void {
  if (deps.isRunActive?.() === true) {
    throw new RunActiveDeleteError();
  }
}

export function registerProjectHandlers(
  handle: IpcHandleFn,
  db: AppDatabase,
  deps: CrudHandlerDeps = {},
): void {
  for (const channel of PROJECT_CHANNELS) {
    handle(channel, (rawPayload: unknown) => {
      const payload = payloadSchema(channel).parse(rawPayload) as Record<string, unknown>;
      switch (channel) {
        case "project:create":
          return createProject(db, payload as Parameters<typeof createProject>[1]);
        case "project:list":
          return listProjects(db);
        case "project:get":
          return getProject(db, payload["id"] as string);
        case "project:update":
          return updateProject(db, payload as Parameters<typeof updateProject>[1]);
        case "project:delete":
          assertNoActiveRun(deps);
          deleteProject(
            db,
            payload["id"] as string,
            deps.artifactsRoot !== undefined ? { artifactsRoot: deps.artifactsRoot } : undefined,
          );
          return null;
      }
    });
  }
}

export function registerSuiteHandlers(
  handle: IpcHandleFn,
  db: AppDatabase,
  deps: CrudHandlerDeps = {},
): void {
  for (const channel of SUITE_CHANNELS) {
    handle(channel, (rawPayload: unknown) => {
      const payload = payloadSchema(channel).parse(rawPayload) as Record<string, unknown>;
      switch (channel) {
        case "suite:create":
          return createSuite(db, payload as Parameters<typeof createSuite>[1]);
        case "suite:list":
          return listSuites(db, payload["projectId"] as string);
        case "suite:get":
          return {
            suite: getSuite(db, payload["id"] as string),
            caseIds: getSuiteCaseIds(db, payload["id"] as string),
          };
        case "suite:update":
          return updateSuite(db, payload as Parameters<typeof updateSuite>[1]);
        case "suite:delete":
          assertNoActiveRun(deps);
          deleteSuite(
            db,
            payload["id"] as string,
            deps.artifactsRoot !== undefined ? { artifactsRoot: deps.artifactsRoot } : undefined,
          );
          return null;
        case "suite:setCases":
          return setSuiteCases(db, payload["suiteId"] as string, payload["caseIds"] as string[]);
      }
    });
  }
}

export function registerCaseHandlers(
  handle: IpcHandleFn,
  db: AppDatabase,
  deps: CrudHandlerDeps = {},
): void {
  for (const channel of CASE_CHANNELS) {
    handle(channel, (rawPayload: unknown) => {
      const payload = payloadSchema(channel).parse(rawPayload) as Record<string, unknown>;
      switch (channel) {
        case "case:create":
          return createCase(db, payload as Parameters<typeof createCase>[1]);
        case "case:list": {
          const cases = listCases(db, payload["projectId"] as string);
          return cases;
        }
        case "case:get": {
          const id = payload["id"] as string;
          return { case: getCase(db, id), steps: listSteps(db, id) };
        }
        case "case:update":
          return updateCase(db, payload as Parameters<typeof updateCase>[1]);
        case "case:delete":
          assertNoActiveRun(deps);
          deleteCase(
            db,
            payload["id"] as string,
            deps.artifactsRoot !== undefined ? { artifactsRoot: deps.artifactsRoot } : undefined,
          );
          return null;
      }
    });
  }
}

export function registerStepHandlers(handle: IpcHandleFn, db: AppDatabase): void {
  for (const channel of STEP_CHANNELS) {
    handle(channel, (rawPayload: unknown) => {
      const payload = payloadSchema(channel).parse(rawPayload) as Record<string, unknown>;
      switch (channel) {
        case "step:upsert":
          return upsertStep(db, payload as Parameters<typeof upsertStep>[1]);
        case "step:move":
          return moveStep(db, payload as Parameters<typeof moveStep>[1]);
        case "step:delete":
          deleteStep(db, payload as Parameters<typeof deleteStep>[1]);
          return null;
        case "step:reorder":
          return reorderSteps(db, payload as Parameters<typeof reorderSteps>[1]);
      }
    });
  }
}

export function registerTestDataHandlers(handle: IpcHandleFn, db: AppDatabase): void {
  for (const channel of TESTDATA_CHANNELS) {
    handle(channel, (rawPayload: unknown) => {
      const payload = payloadSchema(channel).parse(rawPayload) as Record<string, unknown>;
      switch (channel) {
        case "testdata:get":
          return getTestData(db, payload as Parameters<typeof getTestData>[1]);
        case "testdata:set":
          return setTestData(db, payload as Parameters<typeof setTestData>[1]);
      }
    });
  }
}

/** All CRUD channels (projects, suites, cases, steps, test-data, case profiles). */
export function registerCrudHandlers(
  handle: IpcHandleFn,
  db: AppDatabase,
  deps: CrudHandlerDeps = {},
): void {
  registerProjectHandlers(handle, db, deps);
  registerSuiteHandlers(handle, db, deps);
  registerCaseHandlers(handle, db, deps);
  registerStepHandlers(handle, db);
  registerTestDataHandlers(handle, db);
  registerProfileHandlers(handle, db);
}

/**
 * Case-profile channels (M14, SPECS §5). `profile:get` returns
 * `{ profile | null }`; `profile:set` validates the case exists, then upserts
 * (an all-empty profile deletes the row and returns `null`). Payloads are
 * zod-validated at the boundary; the service owns the row shape.
 */
export function registerProfileHandlers(handle: IpcHandleFn, db: AppDatabase): void {
  for (const channel of PROFILE_CHANNELS) {
    handle(channel, (rawPayload: unknown) => {
      const payload = payloadSchema(channel).parse(rawPayload) as Record<string, unknown>;
      const caseId = payload["caseId"] as string;
      switch (channel) {
        case "profile:get":
          return { profile: getCaseProfile(db, caseId) };
        case "profile:set":
          // The profile hangs off a case — a stale/typo'd id must not write an
          // orphan row (there are no FKs by convention).
          getCase(db, caseId);
          return setCaseProfile(db, caseId, payload["profile"]);
      }
    });
  }
}
