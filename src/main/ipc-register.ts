import { z } from "zod";

import { existsSync } from "node:fs";

import type { AppDatabase } from "./db.js";
import { IPC_PAYLOADS } from "../shared/ipc-contract.js";
import {
  RecorderStartPayload,
  RecorderStopPayload,
  ReportExportPdfPayload,
  ReportGetHtmlPayload,
  ReportOpenTracePayload,
} from "../shared/ipc-contract.js";
import { SystemBrowserStatusPayload, SystemInstallBrowserPayload } from "../shared/ipc-contract.js";
import type { RecorderStartPayload as RecorderStart } from "../shared/ipc-contract.js";
import {
  RunnerCancelPayload,
  RunnerResumePayload,
  RunnerRerunFailedPayload,
  RunnerRunSinglePayload,
  RunnerRunSuitePayload,
} from "../shared/ipc-contract.js";
import { TestStepSchema } from "../shared/step-types.js";
import { sharedRecorder } from "./recorder.js";
import type { CodegenRecorder } from "./recorder.js";
import { defaultBrowserSetupDeps, getBrowserStatus, installChromium } from "./browser-setup.js";
import type { BrowserSetupDeps } from "./browser-setup.js";
import { readSuiteHtmlReport, writeSuitePdfReport } from "./reports.js";
import { ensureSuiteHtmlPath } from "./reports.js";
import { defaultSpawnShowTrace, openTrace, openTraceForCase } from "./trace-viewer.js";
import {
  TransferExportCasePayload,
  TransferExportProjectPayload,
  TransferExportSuitePayload,
  TransferImportCasePayload,
  TransferImportProjectPayload,
  TransferImportSuitePayload,
} from "../shared/ipc-contract.js";
import {
  SyncBranchPayload,
  SyncClonePayload,
  SyncCommitPayload,
  SyncInitPayload,
  SyncPullPayload,
  SyncPushPayload,
  SyncResolvePayload,
  SyncStatusPayload,
} from "../shared/ipc-contract.js";
import {
  cloneSyncRepo,
  createSyncBranch,
  initSyncRepo,
  resolveSyncConflict,
  syncCommit,
  syncPull,
  syncPush,
  syncStatus,
} from "./git-sync.js";
import {
  buildCaseExport,
  buildProjectExport,
  buildSuiteExport,
  importCaseBundle,
  importProjectBundle,
  importSuiteBundle,
  loadImportFile,
  saveExportFile,
} from "./transfer.js";
import type { TransferIoDeps } from "./transfer.js";
import type { SingleCaseRunner } from "./runner.js";
import type { SuiteRunner } from "./suite-runner.js";
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

const RUNNER_CHANNELS = [
  "runner:runSingle",
  "runner:runSuite",
  "runner:resumeFromStep",
  "runner:rerunFailed",
  "runner:cancel",
] as const;

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
 * Runner channels (WS5/WS6, PLAN §5 + §8). `runSingle` returns `{ suiteRunId,
 * caseRunId }` and streams progress over `run:*` events; the background `done`
 * promises never reject (failures settle into the db + a `run:finished`
 * event), so handlers drop them. Suite channels delegate to the parallel
 * `SuiteRunner` (M6); `cancel` fans out to both (each no-ops on unknown ids).
 */
export function registerRunnerHandlers(
  handle: IpcHandleFn,
  single: SingleCaseRunner,
  suite: SuiteRunner,
): void {
  for (const channel of RUNNER_CHANNELS) {
    handle(channel, (rawPayload: unknown) => {
      switch (channel) {
        case "runner:runSingle": {
          const payload = RunnerRunSinglePayload.parse(rawPayload);
          const started = single.runSingle(payload);
          return { suiteRunId: started.suiteRunId, caseRunId: started.caseRunId };
        }
        case "runner:runSuite": {
          const payload = RunnerRunSuitePayload.parse(rawPayload);
          const started = suite.runSuite(payload);
          return { suiteRunId: started.suiteRunId };
        }
        case "runner:resumeFromStep": {
          const payload = RunnerResumePayload.parse(rawPayload);
          const resumed = single.resumeFromStep(payload);
          return { suiteRunId: resumed.suiteRunId, caseRunId: resumed.caseRunId };
        }
        case "runner:rerunFailed": {
          const payload = RunnerRerunFailedPayload.parse(rawPayload);
          const started = suite.rerunFailed(payload);
          return { suiteRunId: started.suiteRunId };
        }
        case "runner:cancel": {
          const payload = RunnerCancelPayload.parse(rawPayload);
          return Promise.all([single.cancelRun(payload), suite.cancelRun(payload)]).then(
            () => null,
          );
        }
      }
    });
  }
}
/**
 * Transfer channels (file import/export, Phase 1). Export builds the bundle in
 * the handler and saves it through the injected dialogs; import reads + parses
 * (size cap + schema at the trust boundary) and imports with copy semantics.
 * Cancelled dialogs resolve `{ saved: false }` / `{ imported: false }` — never
 * an error — so the UI can silently no-op.
 */
export function registerTransferHandlers(
  handle: IpcHandleFn,
  db: AppDatabase,
  io: TransferIoDeps,
): void {
  handle("transfer:exportProject", (rawPayload: unknown) => {
    const payload = TransferExportProjectPayload.parse(rawPayload);
    return (async () => {
      const file = buildProjectExport(db, payload.id);
      return saveExportFile(io, file.project?.name ?? "project", "project", file);
    })();
  });
  handle("transfer:exportSuite", (rawPayload: unknown) => {
    const payload = TransferExportSuitePayload.parse(rawPayload);
    return (async () => {
      const file = buildSuiteExport(db, payload.id);
      return saveExportFile(io, file.suites[0]?.name ?? "suite", "suite", file);
    })();
  });
  handle("transfer:exportCase", (rawPayload: unknown) => {
    const payload = TransferExportCasePayload.parse(rawPayload);
    return (async () => {
      const file = buildCaseExport(db, payload.id);
      return saveExportFile(io, file.cases[0]?.name ?? "case", "case", file);
    })();
  });
  handle("transfer:importProject", (rawPayload: unknown) => {
    TransferImportProjectPayload.parse(rawPayload);
    return loadImportFile(io, (file) => importProjectBundle(db, file));
  });
  handle("transfer:importSuite", (rawPayload: unknown) => {
    const payload = TransferImportSuitePayload.parse(rawPayload);
    return loadImportFile(io, (file) => importSuiteBundle(db, file, payload.projectId));
  });
  handle("transfer:importCase", (rawPayload: unknown) => {
    const payload = TransferImportCasePayload.parse(rawPayload);
    return loadImportFile(io, (file) =>
      importCaseBundle(db, file, payload.projectId, payload.suiteIds ?? []),
    );
  });
}

/**
 * Sync channels (local-git project sync, Phase 2 core). Payloads are zod
 * validated at the boundary; the service owns remote/path validation and
 * throws SyncRemoteError on transport problems. All handlers are async and
 * return serialized results (hashes, entity ids, status) — no live handles.
 */
export function registerSyncHandlers(handle: IpcHandleFn, db: AppDatabase): void {
  handle("sync:init", (rawPayload: unknown) => {
    const payload = SyncInitPayload.parse(rawPayload);
    return initSyncRepo(db, payload.projectId, {
      dir: payload.dir,
      ...(payload.remoteUrl !== undefined ? { remoteUrl: payload.remoteUrl } : {}),
      author: payload.author,
      ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
    });
  });
  handle("sync:commit", (rawPayload: unknown) => {
    const payload = SyncCommitPayload.parse(rawPayload);
    return syncCommit(db, payload.projectId, {
      dir: payload.dir,
      author: payload.author,
      message: payload.message,
    });
  });
  handle("sync:push", (rawPayload: unknown) => {
    const payload = SyncPushPayload.parse(rawPayload);
    return syncPush({
      dir: payload.dir,
      ...(payload.remote !== undefined ? { remote: payload.remote } : {}),
      ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
    });
  });
  handle("sync:pull", (rawPayload: unknown) => {
    const payload = SyncPullPayload.parse(rawPayload);
    return syncPull(db, payload.projectId, {
      dir: payload.dir,
      ...(payload.remote !== undefined ? { remote: payload.remote } : {}),
      ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
    });
  });
  handle("sync:status", (rawPayload: unknown) => {
    const payload = SyncStatusPayload.parse(rawPayload);
    return syncStatus(db, payload.projectId, payload.dir);
  });
  handle("sync:branch", (rawPayload: unknown) => {
    const payload = SyncBranchPayload.parse(rawPayload);
    return createSyncBranch(payload.dir, payload.name);
  });
  handle("sync:resolve", (rawPayload: unknown) => {
    const payload = SyncResolvePayload.parse(rawPayload);
    return resolveSyncConflict(db, payload.projectId, {
      dir: payload.dir,
      entity: payload.entity,
      id: payload.id,
      winner: payload.winner,
    });
  });
  handle("sync:clone", (rawPayload: unknown) => {
    const payload = SyncClonePayload.parse(rawPayload);
    return cloneSyncRepo(db, {
      remoteUrl: payload.remoteUrl,
      dir: payload.dir,
      ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
    });
  });
}

/**
 * Report channels (WS6, PLAN §5 + §9; M8 adds `report:openTrace`). `renderPdf`
 * is Electron's printToPDF in prod and a fake in tests — this module stays
 * Electron-free. Trace launching defaults to the real `playwright show-trace`
 * spawn; tests inject `spawnShowTrace`/`pathExists` fakes so no GUI launches.
 */
export function registerReportHandlers(
  handle: IpcHandleFn,
  db: AppDatabase,
  opts: {
    artifactsRoot: string;
    renderPdf: (htmlPath: string) => Promise<Uint8Array>;
    spawnShowTrace?: (tracePath: string) => void;
    pathExists?: (path: string) => boolean;
  },
): void {
  const traceDeps = {
    artifactsRoot: opts.artifactsRoot,
    pathExists: opts.pathExists ?? existsSync,
    spawnShowTrace: opts.spawnShowTrace ?? defaultSpawnShowTrace,
  };
  handle("report:getHtml", (rawPayload: unknown) => {
    const payload = ReportGetHtmlPayload.parse(rawPayload);
    return readSuiteHtmlReport(db, opts.artifactsRoot, payload.suiteRunId);
  });
  handle("report:exportPdf", (rawPayload: unknown) => {
    const payload = ReportExportPdfPayload.parse(rawPayload);
    return (async (): Promise<string> => {
      const htmlPath = ensureSuiteHtmlPath(db, opts.artifactsRoot, payload.suiteRunId);
      const pdfBytes = await opts.renderPdf(htmlPath);
      return writeSuitePdfReport(db, opts.artifactsRoot, payload.suiteRunId, pdfBytes);
    })();
  });
  handle("report:openTrace", (rawPayload: unknown) => {
    const payload = ReportOpenTracePayload.parse(rawPayload);
    if ("caseRunId" in payload) {
      return openTraceForCase(db, traceDeps, payload.caseRunId);
    }
    return openTrace(traceDeps, payload.tracePath);
  });
}

/**
 * System channels (M7, PLAN §11). First-run Chromium check + install; the
 * module stays Electron-free by taking `BrowserSetupDeps` (default prod, fake
 * in tests — same pattern as the recorder handlers above).
 */
export function registerSystemHandlers(
  handle: IpcHandleFn,
  deps: BrowserSetupDeps = defaultBrowserSetupDeps(),
): void {
  handle("system:browserStatus", (rawPayload: unknown) => {
    SystemBrowserStatusPayload.parse(rawPayload);
    return getBrowserStatus(deps);
  });
  handle("system:installBrowser", (rawPayload: unknown) => {
    SystemInstallBrowserPayload.parse(rawPayload);
    return installChromium(deps);
  });
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
