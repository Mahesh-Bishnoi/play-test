import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import type { AppDatabase } from "../db.js";
import { suiteRuns, testSuites } from "../schema.js";
import { SuiteRunNotFoundError, getSuiteReport, resolveReportProjectId } from "./data.js";
import { defaultReadFile, renderSuiteHtml } from "./html.js";

/** Report file paths: `<root>/<projectId>/<suiteRunId>/report.html`. */
export function suiteReportPaths(
  root: string,
  projectId: string,
  suiteRunId: string,
): { htmlPath: string; dir: string } {
  const dir = join(root, projectId, suiteRunId);
  return { htmlPath: join(dir, "report.html"), dir };
}

/**
 * Render + write `report.html` for a suite run and persist the path.
 * Returns the absolute html path. Never throws for missing screenshots —
 * only for a missing suite run or an unwritable disk.
 */
export function writeSuiteHtmlReport(db: AppDatabase, root: string, suiteRunId: string): string {
  const report = getSuiteReport(db, suiteRunId, root);
  const projectId = resolveReportProjectId(db, suiteRunId);
  const { htmlPath, dir } = suiteReportPaths(root, projectId, suiteRunId);
  mkdirSync(dir, { recursive: true });
  const html = renderSuiteHtml(report, defaultReadFile, dir);
  writeFileSync(htmlPath, html, "utf-8");
  db.update(suiteRuns).set({ reportHtmlPath: htmlPath }).where(eq(suiteRuns.id, suiteRunId)).run();
  return htmlPath;
}

/**
 * Read a written report (regenerating it when absent). `force` rewrites the
 * file even when it exists — used while a run is still active, so the in-app
 * Refresh button sees current statuses instead of the first mid-run snapshot.
 */
export function readSuiteHtmlReport(
  db: AppDatabase,
  root: string,
  suiteRunId: string,
  opts: { force?: boolean } = {},
): string {
  return readFileSync(ensureSuiteHtmlPath(db, root, suiteRunId, opts), "utf-8");
}

/** Absolute html path for a run, regenerating it when absent (or forced). */
export function ensureSuiteHtmlPath(
  db: AppDatabase,
  root: string,
  suiteRunId: string,
  opts: { force?: boolean } = {},
): string {
  const existing = db.select().from(suiteRuns).where(eq(suiteRuns.id, suiteRunId)).all()[0];
  if (existing === undefined) {
    throw new SuiteRunNotFoundError(suiteRunId);
  }
  if (
    opts.force !== true &&
    existing.reportHtmlPath !== null &&
    existsSync(existing.reportHtmlPath)
  ) {
    return existing.reportHtmlPath;
  }
  return writeSuiteHtmlReport(db, root, suiteRunId);
}

/** Slug for a save-dialog filename: lowercase, hyphen-separated, bounded. */
function fileSlug(base: string, fallback: string): string {
  return (
    base
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || fallback
  );
}

/**
 * Suggested filename for the native save dialog. The suite name makes the
 * file recognizable; the short run id keeps exports from different runs apart.
 * Both parts are slugified so a renderer-supplied run id can never inject a
 * path separator into the suggestion.
 */
export function suggestedPdfFileName(db: AppDatabase, suiteRunId: string): string {
  const suiteRow = db.select().from(suiteRuns).where(eq(suiteRuns.id, suiteRunId)).all()[0];
  if (suiteRow === undefined) {
    throw new SuiteRunNotFoundError(suiteRunId);
  }
  let suiteName: string | null = null;
  if (suiteRow.suiteId !== null) {
    suiteName =
      db.select().from(testSuites).where(eq(testSuites.id, suiteRow.suiteId)).all()[0]?.name ??
      null;
  }
  const base = fileSlug(suiteName ?? "run-report", "run-report");
  const runId = fileSlug(suiteRunId, "run").slice(0, 12);
  return `${base}-${runId}.pdf`;
}

/**
 * Persist pre-rendered PDF bytes at the path the user picked in the save
 * dialog and record it on the run. Rendering stays in main.ts (Electron
 * printToPDF); this is just the write.
 */
export function writeSuitePdfReport(
  db: AppDatabase,
  suiteRunId: string,
  destinationPath: string,
  pdfBytes: Uint8Array,
): string {
  const suiteRow = db.select().from(suiteRuns).where(eq(suiteRuns.id, suiteRunId)).all()[0];
  if (suiteRow === undefined) {
    throw new SuiteRunNotFoundError(suiteRunId);
  }
  writeFileSync(destinationPath, pdfBytes);
  db.update(suiteRuns)
    .set({ reportPdfPath: destinationPath })
    .where(eq(suiteRuns.id, suiteRunId))
    .run();
  return destinationPath;
}

/** Best-effort report write after a run settles — evidence, never verdict. */
export function tryWriteSuiteHtmlReport(
  db: AppDatabase,
  root: string,
  suiteRunId: string,
  onWarn: (msg: string) => void,
): string | null {
  try {
    return writeSuiteHtmlReport(db, root, suiteRunId);
  } catch (err) {
    onWarn(
      `report write failed for ${suiteRunId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** True when the file at `path` exists (lets callers skip directory reads). */
export function reportFileExists(path: string | null): boolean {
  if (path === null) {
    return false;
  }
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
