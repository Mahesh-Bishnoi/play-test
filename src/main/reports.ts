import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { eq } from "drizzle-orm";

import type { AppDatabase } from "./db.js";
import { caseRuns, stepRuns, suiteRuns, testCases, testSteps, testSuites } from "./schema.js";

/**
 * Suite reports (WS6, PLAN §9). Electron-free so vitest covers it directly:
 * aggregate run rows from the db, render a single self-contained HTML file
 * (inline CSS, no CDN), and persist html/pdf paths back to `suite_runs`.
 * PDF *rendering* (HTML → bytes) lives in main.ts (hidden BrowserWindow);
 * this module only writes the bytes to disk.
 */

export interface ReportStep {
  order: number;
  /** Test-step id (stable reference even when the step was deleted since). */
  stepId: string;
  action: string;
  selector: string | null;
  value: string | null;
  status: "pass" | "fail" | "skipped" | "running";
  error: string | null;
  screenshotPath: string | null;
  durationMs: number | null;
}

export interface ReportCase {
  caseRunId: string;
  caseId: string;
  caseName: string;
  status: string;
  durationMs: number | null;
  videoPath: string | null;
  steps: ReportStep[];
}

export interface ReportSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface SuiteReport {
  suiteRunId: string;
  suiteName: string | null;
  mode: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  summary: ReportSummary;
  cases: ReportCase[];
}

/** Thrown when a suite-run id has no row. */
export class SuiteRunNotFoundError extends Error {
  constructor(suiteRunId: string) {
    super(`suite run not found: ${suiteRunId}`);
    this.name = "SuiteRunNotFoundError";
  }
}

/** Aggregate one suite run (single-case or parallel) into a report model. */
export function getSuiteReport(db: AppDatabase, suiteRunId: string): SuiteReport {
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
  const caseRows = db.select().from(caseRuns).where(eq(caseRuns.suiteRunId, suiteRunId)).all();
  const stepById = new Map(
    db
      .select()
      .from(testSteps)
      .all()
      .map((s) => [s.id, s] as const),
  );
  const cases: ReportCase[] = caseRows.map((cr) => {
    const testCase = db.select().from(testCases).where(eq(testCases.id, cr.caseId)).all()[0];
    const stepRows = db
      .select()
      .from(stepRuns)
      .where(eq(stepRuns.caseRunId, cr.id))
      .all()
      .sort((a, b) => a.order - b.order);
    return {
      caseRunId: cr.id,
      caseId: cr.caseId,
      caseName: testCase?.name ?? cr.caseId,
      status: cr.status,
      durationMs: cr.durationMs,
      videoPath: cr.videoPath,
      steps: stepRows.map((s) => {
        const step = stepById.get(s.stepId);
        return {
          order: s.order,
          stepId: s.stepId,
          action: step?.action ?? "step",
          selector: step?.selector ?? null,
          value: step?.value ?? null,
          status: s.status as ReportStep["status"],
          error: s.error,
          screenshotPath: s.screenshotPath,
          durationMs: s.durationMs,
        };
      }),
    };
  });
  const passed = cases.filter((c) => c.status === "passed").length;
  const failed = cases.filter((c) => c.status === "failed").length;
  // Contract summary has no cancelled bucket — cancellation counts as skipped.
  const skipped = cases.length - passed - failed;
  return {
    suiteRunId,
    suiteName,
    mode: suiteRow.mode,
    status: suiteRow.status,
    startedAt: suiteRow.startedAt,
    endedAt: suiteRow.endedAt,
    summary: { total: cases.length, passed, failed, skipped },
    cases,
  };
}

/** Escape user-controlled text (case names, errors, selectors) for HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const INLINE_CSS = [
  "body{font-family:system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#111}",
  "table{border-collapse:collapse;width:100%;margin:12px 0}",
  "th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;font-size:14px}",
  "th{background:#f4f4f5}",
  ".pass{color:#15803d;font-weight:600}.fail{color:#b91c1c;font-weight:600}",
  ".skipped{color:#6b7280}.running{color:#1d4ed8}",
  ".thumb{max-width:320px;border:1px solid #ddd}",
  ".err{white-space:pre-wrap;background:#fef2f2;border:1px solid #fecaca;padding:8px;font-size:12px}",
  ".muted{color:#6b7280;font-size:13px}",
].join("\n");

/**
 * Human-readable step detail for the report `step` column: what the step
 * did (selector / value), not the internal step id. Mirrors the workflow
 * subtitle convention (selector preferred, else value) but shows both when
 * the action needs them (fill/select/assert-text/press).
 */
export function formatStepDetail(
  action: string,
  selector: string | null,
  value: string | null,
): string {
  const sel = (selector ?? "").trim();
  const val = (value ?? "").trim();
  switch (action) {
    case "goto":
      return val;
    case "click":
      if (sel !== "" && val !== "") {
        return val === "dblclick" ? `${sel} (double-click)` : `${sel} + ${val}`;
      }
      return sel !== "" ? sel : val;
    case "fill":
    case "type":
    case "select":
    case "assert-text":
    case "assert-value":
    case "assert-count":
      if (sel !== "" && val !== "") {
        return `${sel} → ${val}`;
      }
      return sel !== "" ? sel : val;
    case "press":
      if (sel !== "" && val !== "") {
        return `${sel} + ${val}`;
      }
      return sel !== "" ? sel : val;
    case "wait":
      return val !== "" ? `${val} ms` : "";
    default:
      if (sel !== "" && val !== "") {
        return `${sel} · ${val}`;
      }
      return sel !== "" ? sel : val;
  }
}

/**
 * Render the self-contained HTML report. Screenshots embed as base64 thumbs
 * (when the file exists and fits) and always link by relative path so the
 * file stays useful even when moved alongside its artifacts dir.
 */
export function renderSuiteHtml(
  report: SuiteReport,
  readFile: (path: string) => Buffer | null = defaultReadFile,
  htmlDir?: string,
): string {
  const title = report.suiteName !== null ? `Suite report — ${report.suiteName}` : "Run report";
  const caseTables = report.cases
    .map((c) => {
      const stepRows = c.steps
        .map((s) => {
          const shot = screenshotCell(s.screenshotPath, readFile, htmlDir);
          const err =
            s.error !== null
              ? `<div class="err">${escapeHtml(s.error)}</div>`
              : '<span class="muted">—</span>';
          const dur = s.durationMs !== null ? `${s.durationMs} ms` : "—";
          const detail = formatStepDetail(s.action, s.selector, s.value);
          const step =
            detail !== ""
              ? `${escapeHtml(s.action)} — ${escapeHtml(detail)}`
              : escapeHtml(s.action);
          return `<tr><td>${s.order}</td><td class="${s.status}">${s.status}</td><td>${step}</td><td>${dur}</td><td>${shot}</td><td>${err}</td></tr>`;
        })
        .join("\n");
      const video =
        c.videoPath !== null
          ? `<a href="${escapeHtml(rel(c.videoPath, htmlDir))}">failed.webm</a>`
          : '<span class="muted">—</span>';
      return [
        `<h3>${escapeHtml(c.caseName)} — <span class="${c.status}">${escapeHtml(c.status)}</span></h3>`,
        `<p class="muted">caseRun ${escapeHtml(c.caseRunId)} · video: ${video}</p>`,
        `<table><thead><tr><th>#</th><th>status</th><th>step</th><th>duration</th><th>screenshot</th><th>error</th></tr></thead><tbody>${stepRows}</tbody></table>`,
      ].join("\n");
    })
    .join("\n");
  const ended =
    report.endedAt !== null
      ? new Date(report.endedAt).toISOString()
      : '<span class="muted">—</span>';
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${INLINE_CSS}</style></head><body>`,
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="muted">suiteRun ${escapeHtml(report.suiteRunId)} · mode ${escapeHtml(report.mode)} · status ${escapeHtml(report.status)}</p>`,
    `<p>Started ${escapeHtml(new Date(report.startedAt).toISOString())} · Ended ${ended}</p>`,
    `<table><thead><tr><th>total</th><th>passed</th><th>failed</th><th>skipped</th></tr></thead>`,
    `<tbody><tr><td>${report.summary.total}</td><td class="pass">${report.summary.passed}</td><td class="fail">${report.summary.failed}</td><td class="skipped">${report.summary.skipped}</td></tr></tbody></table>`,
    caseTables === "" ? "<p>No cases in this run.</p>" : caseTables,
    "</body></html>",
  ].join("\n");
}

function defaultReadFile(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** Base64 thumb when small enough, relative link always. */
function screenshotCell(
  screenshotPath: string | null,
  readFile: (path: string) => Buffer | null,
  htmlDir?: string,
): string {
  if (screenshotPath === null) {
    return '<span class="muted">—</span>';
  }
  const href = escapeHtml(rel(screenshotPath, htmlDir));
  const label = escapeHtml(screenshotPath.split(/[/\\]/).pop() ?? screenshotPath);
  let img: string;
  try {
    const bytes = readFile(screenshotPath);
    if (bytes !== null && bytes.length <= 500_000) {
      img = `<img class="thumb" alt="${label}" src="data:image/png;base64,${bytes.toString("base64")}">`;
    } else {
      img = `<span class="muted">${label} (see file)</span>`;
    }
  } catch {
    img = `<span class="muted">${label} (missing)</span>`;
  }
  return `<a href="${href}">${img}<br>${label}</a>`;
}

function rel(target: string, htmlDir?: string): string {
  if (htmlDir === undefined) {
    return target;
  }
  const r = relative(htmlDir, target);
  return r === "" ? target : r;
}

/** Project id owning a suite run — for report placement under its artifacts dir. */
export function resolveReportProjectId(db: AppDatabase, suiteRunId: string): string {
  const suiteRow = db.select().from(suiteRuns).where(eq(suiteRuns.id, suiteRunId)).all()[0];
  if (suiteRow === undefined) {
    throw new SuiteRunNotFoundError(suiteRunId);
  }
  if (suiteRow.suiteId !== null) {
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
  const report = getSuiteReport(db, suiteRunId);
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
    return existsSync(path) && !dirname(path).includes("\0");
  } catch {
    return false;
  }
}
