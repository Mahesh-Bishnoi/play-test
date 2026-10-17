import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import type { AppDatabase } from "../db.js";
import { suiteRuns } from "../schema.js";
import { SuiteRunNotFoundError, getSuiteReport, resolveReportProjectId } from "./data.js";
import { defaultReadFile, renderSuiteHtml } from "./html.js";

/** Report file paths: `<root>/<projectId>/<suiteRunId>/report.{html,pdf}`. */
export function suiteReportPaths(
  root: string,
  projectId: string,
  suiteRunId: string,
): { htmlPath: string; pdfPath: string; dir: string } {
  const dir = join(root, projectId, suiteRunId);
  return { htmlPath: join(dir, "report.html"), pdfPath: join(dir, "report.pdf"), dir };
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

/** Read a previously written report (regenerating it when absent). */
export function readSuiteHtmlReport(db: AppDatabase, root: string, suiteRunId: string): string {
  return readFileSync(ensureSuiteHtmlPath(db, root, suiteRunId), "utf-8");
}

/** Absolute html path for a run, regenerating the file when absent. */
export function ensureSuiteHtmlPath(db: AppDatabase, root: string, suiteRunId: string): string {
  const existing = db.select().from(suiteRuns).where(eq(suiteRuns.id, suiteRunId)).all()[0];
  if (existing === undefined) {
    throw new SuiteRunNotFoundError(suiteRunId);
  }
  if (existing.reportHtmlPath !== null && existsSync(existing.reportHtmlPath)) {
    return existing.reportHtmlPath;
  }
  return writeSuiteHtmlReport(db, root, suiteRunId);
}

/**
 * Persist pre-rendered PDF bytes as `report.pdf` and record the path.
 * Rendering stays in main.ts (Electron printToPDF); this is just the write.
 */
export function writeSuitePdfReport(
  db: AppDatabase,
  root: string,
  suiteRunId: string,
  pdfBytes: Uint8Array,
): string {
  const suiteRow = db.select().from(suiteRuns).where(eq(suiteRuns.id, suiteRunId)).all()[0];
  if (suiteRow === undefined) {
    throw new SuiteRunNotFoundError(suiteRunId);
  }
  const projectId = resolveReportProjectId(db, suiteRunId);
  const { pdfPath, dir } = suiteReportPaths(root, projectId, suiteRunId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(pdfPath, pdfBytes);
  // Ensure the html report exists alongside — the report page links both.
  if (suiteRow.reportHtmlPath === null || !existsSync(suiteRow.reportHtmlPath)) {
    writeSuiteHtmlReport(db, root, suiteRunId);
  }
  db.update(suiteRuns).set({ reportPdfPath: pdfPath }).where(eq(suiteRuns.id, suiteRunId)).run();
  return pdfPath;
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
