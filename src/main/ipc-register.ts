import { z } from "zod";

import type { AppDatabase } from "./db.js";
import { IPC_PAYLOADS } from "../shared/ipc-contract.js";
import { RecorderStartPayload, RecorderStopPayload } from "../shared/ipc-contract.js";
import type { RecorderStartPayload as RecorderStart } from "../shared/ipc-contract.js";
import { TestStepSchema } from "../shared/step-types.js";
import { sharedRecorder } from "./recorder.js";
import type { CodegenRecorder } from "./recorder.js";
import { createCase, deleteCase, getCase, listCases, updateCase } from "./ipc-cases.js";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from "./ipc-projects.js";
import {
  deleteStep,
  getTestData,
  listSteps,
  moveStep,
  reorderSteps,
  setTestData,
  upsertStep,
} from "./ipc-steps.js";
import {
  createSuite,
  deleteSuite,
  getSuite,
  getSuiteCaseIds,
  listSuites,
  setSuiteCases,
  updateSuite,
} from "./ipc-suites.js";

/**
 * Electron-agnostic handler registration (WS1/WS2, PLAN §5). Takes a `handle`
 * function instead of importing `ipcMain` so tests inject a fake and
 * `main.ts` (composition root) passes the real one. Every request channel is
 * validated with `IPC_PAYLOADS` before reaching a service.
 *
 * Return-envelope notes (payload schemas unchanged — frozen v1):
 * - `suite:get` → `{ suite, caseIds }` (membership has no dedicated channel).
 * - `case:get` → `{ case, steps }` (there is no `step:list` channel).
 */
export type IpcHandleFn = (channel: string, listener: (payload: unknown) => unknown) => void;

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

const RECORDER_CHANNELS = ["recorder:start", "recorder:stop"] as const;

function payloadSchema(channel: string) {
  const schema = IPC_PAYLOADS[channel];
  if (schema === undefined) {
    throw new Error(`no payload schema for channel: ${channel}`);
  }
  return schema;
}

export function registerProjectHandlers(handle: IpcHandleFn, db: AppDatabase): void {
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
          deleteProject(db, payload["id"] as string);
          return null;
      }
    });
  }
}

export function registerSuiteHandlers(handle: IpcHandleFn, db: AppDatabase): void {
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
          deleteSuite(db, payload["id"] as string);
          return null;
        case "suite:setCases":
          return setSuiteCases(db, payload["suiteId"] as string, payload["caseIds"] as string[]);
      }
    });
  }
}

export function registerCaseHandlers(handle: IpcHandleFn, db: AppDatabase): void {
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
          deleteCase(db, payload["id"] as string);
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

/** All CRUD channels (projects, suites, cases, steps, test-data). Main calls this. */
export function registerCrudHandlers(handle: IpcHandleFn, db: AppDatabase): void {
  registerProjectHandlers(handle, db);
  registerSuiteHandlers(handle, db);
  registerCaseHandlers(handle, db);
  registerStepHandlers(handle, db);
  registerTestDataHandlers(handle, db);
}

/**
 * Recorder channels (WS4, PLAN §7). The recorder is process-wide (one codegen
 * window per app), so handlers take it as a param — default the shared
 * instance in prod, inject a fake in tests.
 */
export function registerRecorderHandlers(
  handle: IpcHandleFn,
  recorder: CodegenRecorder = sharedRecorder,
): void {
  for (const channel of RECORDER_CHANNELS) {
    handle(channel, (rawPayload: unknown) => {
      switch (channel) {
        case "recorder:start": {
          const payload = RecorderStartPayload.parse(rawPayload) as RecorderStart;
          return recorder.start(payload.baseUrl);
        }
        case "recorder:stop": {
          RecorderStopPayload.parse(rawPayload);
          const result = recorder.stop();
          // Re-validate parsed steps at the trust boundary before sending out.
          return { steps: z.array(TestStepSchema).parse(result.steps), raw: result.raw };
        }
      }
    });
  }
}
