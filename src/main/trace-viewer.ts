import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

import { eq } from "drizzle-orm";

import type { AppDatabase } from "./db.js";
import { caseTracePath } from "./artifacts.js";
import { caseRuns, suiteRuns, testCases, testSuites } from "./schema.js";

/**
 * Trace viewer launch (WS5+WS6 / M8, PLAN §18.1). `trace.zip` is saved
 * retain-on-failure by both runners but nothing opened it — this module
 * spawns `playwright show-trace <trace.zip>` detached.
 *
 * Stateless functions over an injected `TraceViewerDeps` seam (mirrors
 * browser-setup.ts): production resolves the real Playwright CLI and spawns
 * detached; tests inject fakes so no GUI ever launches. No DB migration:
 * trace paths derive from the artifacts layout
 * (`<root>/<projectId>/<suiteRunId>/<caseId>/trace.zip`), never stored.
 */

export class TraceViewerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceViewerError";
  }
}

export class CaseRunNotFoundError extends Error {
  constructor(caseRunId: string) {
    super(`case run not found: ${caseRunId}`);
    this.name = "CaseRunNotFoundError";
  }
}

export interface TraceViewerDeps {
  artifactsRoot: string;
  pathExists: (path: string) => boolean;
  /** Launches the viewer detached; must not block or throw for GUI absence. */
  spawnShowTrace: (tracePath: string) => void;
}

export function defaultTraceViewerDeps(artifactsRoot: string): TraceViewerDeps {
  return {
    artifactsRoot,
    pathExists: (path) => existsSync(path),
    spawnShowTrace: defaultSpawnShowTrace,
  };
}

/**
 * Spawn `playwright show-trace` detached via Electron's Node
 * (same CLI resolution as browser-setup.ts — no `npx` on PATH required).
 * Throws `TraceViewerError` with a manual fallback when the CLI is missing
 * or the spawn itself fails.
 */
export function defaultSpawnShowTrace(tracePath: string): void {
  let cliPath: string;
  try {
    const anchor = typeof __filename === "string" ? __filename : process.cwd();
    cliPath = createRequire(anchor).resolve("playwright/cli.js");
  } catch {
    throw new TraceViewerError(
      `Cannot locate the Playwright CLI from the packaged app. ` +
        `Run \`npx playwright show-trace "${tracePath}"\` manually.`,
    );
  }
  try {
    const child = spawn(process.execPath, [cliPath, "show-trace", tracePath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (err) {
    throw new TraceViewerError(
      `Trace viewer failed to start (${err instanceof Error ? err.message : String(err)}). ` +
        `Run \`npx playwright show-trace "${tracePath}"\` manually.`,
    );
  }
}

/**
 * Validate a trace path: must resolve inside the artifacts root, must end
 * in `.zip`, and must exist. Returns the absolute path. Throws
 * `TraceViewerError` (message carries the manual `show-trace` fallback).
 */
export function resolveTracePath(deps: TraceViewerDeps, tracePath: string): string {
  const trimmed = tracePath.trim();
  if (trimmed === "") {
    throw new TraceViewerError("trace path is empty.");
  }
  const abs = isAbsolute(trimmed) ? normalize(trimmed) : resolve(deps.artifactsRoot, trimmed);
  const rel = relative(resolve(deps.artifactsRoot), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new TraceViewerError(
      `trace path escapes the artifacts dir: ${tracePath}. ` +
        `Run \`npx playwright show-trace "<trace.zip>"\` manually inside ~/PlayTestData.`,
    );
  }
  if (!abs.endsWith(".zip")) {
    throw new TraceViewerError(
      `not a trace archive: ${tracePath} (expected *.zip). ` +
        `Run \`npx playwright show-trace "${abs}"\` manually.`,
    );
  }
  if (!deps.pathExists(abs)) {
    throw new TraceViewerError(
      `trace file not found: ${abs} (passing runs discard it — retain-on-failure only). ` +
        `Run \`npx playwright show-trace "${abs}"\` manually once the file exists.`,
    );
  }
  return abs;
}

/** Validate + launch the viewer for an explicit path. */
export function openTrace(deps: TraceViewerDeps, tracePath: string): { opened: true } {
  const abs = resolveTracePath(deps, tracePath);
  try {
    deps.spawnShowTrace(abs);
  } catch (err) {
    throw new TraceViewerError(
      `Trace viewer failed to start (${err instanceof Error ? err.message : String(err)}). ` +
        `Run \`npx playwright show-trace "${abs}"\` manually.`,
    );
  }
  return { opened: true as const };
}

/**
 * Launch the viewer for a case run: derive its `trace.zip` from the
 * artifacts layout (project → suite-run → case) and delegate to `openTrace`.
 * Throws `CaseRunNotFoundError` for unknown ids, `TraceViewerError` when the
 * file is missing (e.g. the case passed — traces are retain-on-failure).
 */
export function openTraceForCase(
  db: AppDatabase,
  deps: TraceViewerDeps,
  caseRunId: string,
): { opened: true } {
  const caseRun = db.select().from(caseRuns).where(eq(caseRuns.id, caseRunId)).all()[0];
  if (caseRun === undefined) {
    throw new CaseRunNotFoundError(caseRunId);
  }
  const testCase = db.select().from(testCases).where(eq(testCases.id, caseRun.caseId)).all()[0];
  const projectId = testCase?.projectId ?? resolveOwningProject(db, caseRun.suiteRunId);
  const tracePath = caseTracePath(
    deps.artifactsRoot,
    projectId,
    caseRun.suiteRunId,
    caseRun.caseId,
  );
  return openTrace(deps, tracePath);
}

/** Owning project for orphan cases (deleted since the run) — mirrors reports.ts. */
function resolveOwningProject(db: AppDatabase, suiteRunId: string): string {
  const suiteRow = db.select().from(suiteRuns).where(eq(suiteRuns.id, suiteRunId)).all()[0];
  if (suiteRow?.suiteId != null) {
    const suite = db.select().from(testSuites).where(eq(testSuites.id, suiteRow.suiteId)).all()[0];
    if (suite !== undefined) {
      return suite.projectId;
    }
  }
  const firstCase = db.select().from(caseRuns).where(eq(caseRuns.suiteRunId, suiteRunId)).all()[0];
  if (firstCase !== undefined) {
    const testCase = db.select().from(testCases).where(eq(testCases.id, firstCase.caseId)).all()[0];
    if (testCase !== undefined) {
      return testCase.projectId;
    }
  }
  return "unknown";
}

/** Join helper (tests assert the exact on-disk layout without touching fs). */
export function expectedCaseTracePath(
  root: string,
  projectId: string,
  suiteRunId: string,
  caseId: string,
): string {
  return join(root, projectId, suiteRunId, caseId, "trace.zip");
}
