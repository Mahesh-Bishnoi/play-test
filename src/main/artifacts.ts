import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Artifact path builders (WS5, PLAN §4). Layout:
 * `<root>/<projectId>/<suiteRunId>/<caseId>/step-<NN>.png, failed.webm, trace.zip`
 * Pure string building except `ensureDir` / `artifactsRoot` (homedir).
 * `root` is injectable so tests use a tmp dir and prod uses ~/PlayTestData.
 */

/** Runtime user data lives outside the repo (PLAN §3). */
export function defaultArtifactsRoot(): string {
  return join(homedir(), "PlayTestData");
}

export function caseArtifactsDir(
  root: string,
  projectId: string,
  suiteRunId: string,
  caseId: string,
): string {
  return join(root, projectId, suiteRunId, caseId);
}

/** Per-step screenshot, taken after every step (pass or fail). `step-03.png`. */
export function stepScreenshotPath(
  root: string,
  projectId: string,
  suiteRunId: string,
  caseId: string,
  order: number,
): string {
  return join(
    caseArtifactsDir(root, projectId, suiteRunId, caseId),
    `step-${String(order).padStart(2, "0")}.png`,
  );
}

/** Video kept only on failure (PLAN §2: `retain-on-failure`). */
export function caseVideoPath(
  root: string,
  projectId: string,
  suiteRunId: string,
  caseId: string,
): string {
  return join(caseArtifactsDir(root, projectId, suiteRunId, caseId), "failed.webm");
}

/** Trace kept only on failure (PLAN §2: `retain-on-failure`). */
export function caseTracePath(
  root: string,
  projectId: string,
  suiteRunId: string,
  caseId: string,
): string {
  return join(caseArtifactsDir(root, projectId, suiteRunId, caseId), "trace.zip");
}

/** Create the per-case dir (screenshots need it before the first step). */
export function ensureCaseDir(
  root: string,
  projectId: string,
  suiteRunId: string,
  caseId: string,
): string {
  const dir = caseArtifactsDir(root, projectId, suiteRunId, caseId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Remove a project's whole artifact tree (`<root>/<projectId>`).
 * Contained to `root` by construction (join, no `..` segments from ids —
 * project ids are nanoid alphanumerics). Never throws: deleteProject must
 * succeed at the DB level even when the disk tree is already gone.
 */
export function removeProjectArtifacts(root: string, projectId: string): void {
  try {
    rmSync(join(root, projectId), { recursive: true, force: true });
  } catch {
    // Best-effort — orphaned media is wasteful, not corrupt.
  }
}
