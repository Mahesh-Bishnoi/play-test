import { z } from "zod";

import { existsSync, mkdirSync } from "node:fs";

import type { AppDatabase } from "../db.js";
import {
  RecorderStartPayload,
  RecorderStopPayload,
  RecorderUnsupportedSchema,
} from "../../shared/ipc-contract.js";
import type { RecorderStartOptions } from "../../shared/ipc-contract.js";
import { TestStepSchema } from "../../shared/step-types.js";
import { sharedRecorder } from "../recorder/codegen-shell.js";
import type { CodegenRecorder } from "../recorder/codegen-shell.js";
import { getCase } from "../ipc-cases.js";
import {
  authStateDir,
  getCaseProfile,
  MissingAuthStateError,
  resolveAuthStatePath,
} from "../ipc-profiles.js";
import { getProject } from "../ipc-projects.js";
import type { IpcHandleFn } from "./handle.js";

const RECORDER_CHANNELS = ["recorder:start", "recorder:stop"] as const;

/**
 * Resolve `recorder:start({caseId})` into the codegen argv options the
 * `CodegenRecorder` consumes (M14, SPECS §2/§5). The recorder no longer takes
 * emulation/auth fields from the renderer: main reads the case profile and the
 * start URL and maps them onto `RecorderStartOptions` — one dialect, and
 * absolute auth-state paths only main can compute.
 *
 * The start URL is the case's own `url` when set (the persisted per-case "Case
 * URL" field is the source of truth), otherwise the project `baseUrl`. Throws
 * before any spawn when both are empty or the profile names an auth-state file
 * that is not on disk (recording against a missing login state would silently
 * produce a broken flow).
 */
export function resolveRecorderStartOptions(
  db: AppDatabase,
  artifactsRoot: string,
  caseId: string,
): { baseUrl: string; options: RecorderStartOptions } {
  const testCase = getCase(db, caseId);
  const project = getProject(db, testCase.projectId);
  const baseUrl = (testCase.url?.trim() ?? "") || (project.baseUrl?.trim() ?? "");
  if (baseUrl === "") {
    throw new Error("case has no URL and the project has no base URL — set one before recording");
  }
  const profile = getCaseProfile(db, caseId);
  const options: RecorderStartOptions = {};
  if (profile !== null) {
    // Only a complete viewport maps — a half-filled pair is treated as unset
    // (Playwright needs both dimensions).
    if (profile.viewportW !== undefined && profile.viewportH !== undefined) {
      options.viewport = { width: profile.viewportW, height: profile.viewportH };
    }
    if (profile.device !== undefined) {
      options.device = profile.device;
    }
    if (profile.colorScheme !== undefined) {
      options.colorScheme = profile.colorScheme;
    }
    if (profile.locale !== undefined) {
      options.locale = profile.locale;
    }
    if (profile.timezone !== undefined) {
      options.timezone = profile.timezone;
    }
    if (profile.storageState !== undefined) {
      const loadPath = resolveAuthStatePath(
        artifactsRoot,
        testCase.projectId,
        profile.storageState,
      );
      if (!existsSync(loadPath)) {
        throw new MissingAuthStateError(profile.storageState);
      }
      options.storageStatePath = loadPath;
    }
    if (profile.saveStorageState !== undefined) {
      // Create the auth dir up front so codegen's --save-storage can write it.
      mkdirSync(authStateDir(artifactsRoot, testCase.projectId), { recursive: true });
      options.saveStoragePath = resolveAuthStatePath(
        artifactsRoot,
        testCase.projectId,
        profile.saveStorageState,
      );
    }
  }
  return { baseUrl, options };
}

/**
 * Recorder channels (WS4, PLAN §7; M15 item 5 makes `start` async). The
 * recorder is process-wide (one codegen window per app), so handlers take it
 * as a param — default the shared instance in prod, inject a fake in tests.
 * `artifactsRoot` locates the per-project auth-state directory the profile's
 * storage filenames resolve under (M14). `recorder:start` returns the
 * recorder's promise (Electron's `ipcMain.handle` awaits it) so a launch
 * failure rejects the renderer call; `recorder:stop` also carries the
 * `unsupported` codegen lines (M15).
 */
export function registerRecorderHandlers(
  handle: IpcHandleFn,
  db: AppDatabase,
  deps: { artifactsRoot: string; recorder?: CodegenRecorder },
): void {
  const recorder = deps.recorder ?? sharedRecorder;
  for (const channel of RECORDER_CHANNELS) {
    handle(channel, (rawPayload: unknown) => {
      switch (channel) {
        case "recorder:start": {
          const payload = RecorderStartPayload.parse(rawPayload);
          const { baseUrl, options } = resolveRecorderStartOptions(
            db,
            deps.artifactsRoot,
            payload.caseId,
          );
          return recorder.start(baseUrl, options);
        }
        case "recorder:stop": {
          RecorderStopPayload.parse(rawPayload);
          // `stop` waits for codegen's graceful exit so --save-storage and the
          // output file are flushed before parsing (M18).
          return recorder.stop().then((result) => ({
            // Re-validate parsed steps + unsupported entries at the trust boundary.
            steps: z.array(TestStepSchema).parse(result.steps),
            unsupported: z.array(RecorderUnsupportedSchema).parse(result.unsupported),
            raw: result.raw,
          }));
        }
      }
    });
  }
}
