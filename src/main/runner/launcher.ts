/**
 * Case profile → launch options, and the production launcher entry point.
 *
 * The profile is resolved once per case (M14): a named auth/session file that
 * is not on disk fails *before* the caller launches anything, so a stale login
 * never starts a silently-wrong run.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";

import type { CaseProfile } from "../../shared/schema.js";
import { StepExecutionError } from "./errors.js";
import { MissingAuthStateError, resolveAuthStatePath } from "../ipc-profiles.js";
import { PlaywrightBrowserHandle } from "./playwright-context.js";
import type { BrowserHandle, BrowserLauncher, ContextLaunchOptions, RunLogLevel } from "./seams.js";

/**
 * Build the `ContextLaunchOptions` for one case (M14): profile emulation +
 * auth-state file (absolute path) + the project's `baseUrl`. A named auth-state
 * file that is not on disk throws `MissingAuthStateError` *before* the caller
 * launches anything, so a stale login never starts a silently-wrong run.
 */
export function contextLaunchOptionsFromProfile(input: {
  artifactsRoot: string;
  projectId: string;
  caseName: string;
  projectBaseUrl?: string;
  profile: CaseProfile | null;
  videoDir: string;
  onLog: (level: RunLogLevel, message: string) => void;
}): ContextLaunchOptions {
  const options: ContextLaunchOptions = {
    videoDir: input.videoDir,
    title: input.caseName,
    downloadsDir: join(input.videoDir, "downloads"),
    onLog: input.onLog,
  };
  if (input.projectBaseUrl !== undefined && input.projectBaseUrl !== "") {
    options.baseURL = input.projectBaseUrl;
  }
  const profile = input.profile;
  if (profile !== null) {
    // An explicit viewport wins over the device preset; only a complete pair
    // counts (Playwright needs both dimensions).
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
      options.timezoneId = profile.timezone;
    }
    if (profile.dialogPolicy !== undefined) {
      options.dialogPolicy = profile.dialogPolicy;
    }
    if (profile.storageState !== undefined) {
      const storagePath = resolveAuthStatePath(
        input.artifactsRoot,
        input.projectId,
        profile.storageState,
      );
      if (!existsSync(storagePath)) {
        throw new MissingAuthStateError(profile.storageState);
      }
      options.storageState = storagePath;
    }
    if (profile.sessionState !== undefined) {
      const sessionPath = resolveAuthStatePath(
        input.artifactsRoot,
        input.projectId,
        profile.sessionState,
      );
      if (!existsSync(sessionPath)) {
        throw new MissingAuthStateError(profile.sessionState);
      }
      options.sessionState = {
        origin: originOf(input.projectBaseUrl),
        entries: readSessionStateFile(sessionPath, profile.sessionState),
      };
    }
  }
  return options;
}

/** The origin of a URL, or `null` (apply everywhere) when it cannot be parsed. */
function originOf(url: string | undefined): string | null {
  if (url === undefined || url === "") {
    return null;
  }
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Read a sessionStorage seed file (M17): a JSON object of string → string. A
 * file in any other shape is a user error and fails loudly, naming the file.
 */
function readSessionStateFile(path: string, filename: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new StepExecutionError(
      `session state file ${filename} is not valid JSON — expected {"key":"value"}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StepExecutionError(
      `session state file ${filename} must be a JSON object of string values`,
    );
  }
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new StepExecutionError(
        `session state file ${filename} has a non-string value for "${key}"`,
      );
    }
    entries[key] = value;
  }
  return entries;
}

/** Production launcher: Chromium only (MVP locked decision). */
export function playwrightLauncher(): BrowserLauncher {
  return {
    async launchBrowser(headless: boolean): Promise<BrowserHandle> {
      const browser = await chromium.launch({ headless });
      return new PlaywrightBrowserHandle(browser);
    },
  };
}
