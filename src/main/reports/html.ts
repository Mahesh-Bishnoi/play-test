import { readFileSync } from "node:fs";
import { relative } from "node:path";

import type { SuiteReport } from "./data.js";

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
      const traceHref = c.tracePath !== null ? rel(c.tracePath, htmlDir) : null;
      const trace =
        traceHref !== null
          ? `<a href="${escapeHtml(traceHref)}">trace.zip</a>`
          : '<span class="muted">—</span>';
      const traceAttr = traceHref !== null ? ` data-trace="${escapeHtml(traceHref)}"` : "";
      return [
        `<h3>${escapeHtml(c.caseName)} — <span class="${c.status}">${escapeHtml(c.status)}</span></h3>`,
        `<p class="muted" data-caserun="${escapeHtml(c.caseRunId)}"${traceAttr}>caseRun ${escapeHtml(c.caseRunId)} · video: ${video} · trace: ${trace}</p>`,
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

export function defaultReadFile(path: string): Buffer | null {
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
