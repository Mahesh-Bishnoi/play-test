import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/main/db.js";
import type { DatabaseHandle } from "../src/main/db.js";
import { createCase } from "../src/main/ipc-cases.js";
import { createProject } from "../src/main/ipc-projects.js";
import { upsertStep } from "../src/main/ipc-steps.js";
import { createSuite } from "../src/main/ipc-suites.js";
import { caseRuns, stepRuns, suiteRuns } from "../src/main/schema.js";
import {
  SuiteRunNotFoundError,
  getSuiteReport,
  resolveReportProjectId,
} from "../src/main/reports/data.js";
import { escapeHtml, formatStepDetail, renderSuiteHtml } from "../src/main/reports/html.js";
import {
  ensureSuiteHtmlPath,
  readSuiteHtmlReport,
  reportFileExists,
  suggestedPdfFileName,
  suiteReportPaths,
  tryWriteSuiteHtmlReport,
  writeSuiteHtmlReport,
  writeSuitePdfReport,
} from "../src/main/reports/files.js";

let openHandles: DatabaseHandle[] = [];
afterEach(() => {
  for (const handle of openHandles) {
    handle.close();
  }
  openHandles = [];
});

function mkRoot(): string {
  const root = join(
    tmpdir(),
    `playtest-reports-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  return root;
}

/** One suite with two cases; caseRuns/stepRuns inserted directly for control. */
function seed() {
  const dbHandle = createDatabase(":memory:");
  openHandles.push(dbHandle);
  const db = dbHandle.db;
  const project = createProject(db, { name: "P" });
  const suite = createSuite(db, { projectId: project.id, name: "S" });
  const c0 = createCase(db, { projectId: project.id, name: "Login <flow>" });
  const c1 = createCase(db, { projectId: project.id, name: "Checkout" });
  const s00 = upsertStep(db, {
    caseId: c0.id,
    step: { order: 0, action: "goto", value: "https://x.test" },
  });
  upsertStep(db, { caseId: c0.id, step: { order: 1, action: "click", selector: "#go" } });
  db.insert(suiteRuns)
    .values({
      id: "run-1",
      suiteId: suite.id,
      mode: "unsupervised",
      status: "failed",
      startedAt: 1000,
      endedAt: 2000,
    })
    .run();
  db.insert(caseRuns)
    .values([
      {
        id: "cr-0",
        suiteRunId: "run-1",
        caseId: c0.id,
        status: "failed",
        durationMs: 500,
        videoPath: "/v/failed.webm",
      },
      { id: "cr-1", suiteRunId: "run-1", caseId: c1.id, status: "cancelled", durationMs: 10 },
    ])
    .run();
  db.insert(stepRuns)
    .values([
      { id: "sr-0", caseRunId: "cr-0", stepId: s00.id, order: 0, status: "pass", durationMs: 100 },
      {
        id: "sr-1",
        caseRunId: "cr-0",
        stepId: "missing-step",
        order: 1,
        status: "fail",
        error: '<boom> & "quoted"',
      },
    ])
    .run();
  return { db, project, suite, c0, c1 };
}

describe("escapeHtml", () => {
  it("escapes markup-significant characters", () => {
    expect(escapeHtml(`<a href="x">&'y'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;y&#39;&lt;/a&gt;",
    );
  });
});

describe("getSuiteReport", () => {
  it("aggregates cases with action labels and a skipped bucket incl. cancelled", () => {
    const { db } = seed();
    const report = getSuiteReport(db, "run-1");
    expect(report.suiteName).toBe("S");
    expect(report.summary).toEqual({ total: 2, passed: 0, failed: 1, skipped: 1 });
    const failed = report.cases.find((c) => c.caseRunId === "cr-0");
    expect(failed?.caseName).toBe("Login <flow>");
    expect(failed?.steps.map((s) => s.action)).toEqual(["goto", "step"]);
    expect(failed?.steps[0]).toMatchObject({ value: "https://x.test", selector: null });
    expect(failed?.videoPath).toBe("/v/failed.webm");
  });

  it("throws for unknown runs", () => {
    const { db } = seed();
    expect(() => getSuiteReport(db, "ghost")).toThrow(SuiteRunNotFoundError);
  });
});

describe("formatStepDetail", () => {
  it("describes what the step did instead of its id", () => {
    expect(formatStepDetail("goto", null, "https://x.test")).toBe("https://x.test");
    expect(formatStepDetail("click", "#go", null)).toBe("#go");
    expect(formatStepDetail("click", "#go", "dblclick")).toBe("#go (double-click)");
    expect(formatStepDetail("fill", "#name", "Ada")).toBe("#name → Ada");
    expect(formatStepDetail("press", null, "Enter")).toBe("Enter");
    expect(formatStepDetail("wait", null, "500")).toBe("500 ms");
    expect(formatStepDetail("step", null, null)).toBe("");
  });
});

describe("renderSuiteHtml", () => {
  it("renders a self-contained page with escaped content and embedded thumbs", () => {
    const { db } = seed();
    const root = mkRoot();
    const shot = join(root, "step-00.png");
    writeFileSync(shot, Buffer.from("png-bytes"));
    const report = getSuiteReport(db, "run-1");
    report.cases[0]!.steps[0]!.screenshotPath = shot;
    const html = renderSuiteHtml(report, undefined, root);
    expect(html).toContain("<style>");
    expect(html).not.toContain("cdn");
    expect(html).toContain("Login &lt;flow&gt;");
    expect(html).toContain("&lt;boom&gt; &amp; &quot;quoted&quot;");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("goto — https://x.test");
    expect(html).not.toContain("missing-step");
  });

  it("links large screenshots instead of embedding them", () => {
    const { db } = seed();
    const report = getSuiteReport(db, "run-1");
    const big = Buffer.alloc(600_000, 1);
    const html = renderSuiteHtml(report, () => big, undefined);
    expect(html).not.toContain("data:image/png;base64,");
  });

  it("renders queued/cancelled statuses with matching styles (M21)", () => {
    const { db } = seed();
    const report = getSuiteReport(db, "run-1");
    report.cases[0]!.status = "pending";
    report.cases[1]!.status = "cancelled";
    const html = renderSuiteHtml(report);
    expect(html).toContain('<span class="pending">pending</span>');
    expect(html).toContain('<span class="cancelled">cancelled</span>');
    expect(html).toContain(".pending{color:");
    expect(html).toContain(".cancelled{color:");
  });
});

describe("report persistence", () => {
  it("writes, reads back, and reuses the html path; pdf write records its path", () => {
    const { db, project } = seed();
    const root = mkRoot();
    const htmlPath = writeSuiteHtmlReport(db, root, "run-1");
    expect(htmlPath.endsWith("report.html")).toBe(true);
    expect(existsSync(htmlPath)).toBe(true);
    const again = ensureSuiteHtmlPath(db, root, "run-1");
    expect(again).toBe(htmlPath);
    expect(readSuiteHtmlReport(db, root, "run-1")).toContain("Checkout");
    // A live run forces a fresh render instead of serving the cached snapshot.
    writeFileSync(htmlPath, "stale", "utf-8");
    expect(readSuiteHtmlReport(db, root, "run-1", { force: true })).toContain("Checkout");
    expect(reportFileExists(htmlPath)).toBe(true);
    expect(reportFileExists(null)).toBe(false);
    expect(reportFileExists(join(root, "nope.png"))).toBe(false);
    expect(resolveReportProjectId(db, "run-1")).toBe(project.id);
    expect(suiteReportPaths(root, "proj", "run-1").dir).toBe(join(root, "proj", "run-1"));

    const destination = join(root, "chosen-export.pdf");
    const pdfPath = writeSuitePdfReport(db, "run-1", destination, new Uint8Array([1, 2, 3]));
    expect(pdfPath).toBe(destination);
    expect(existsSync(destination)).toBe(true);
    expect(readFileSync(destination)).toEqual(Buffer.from([1, 2, 3]));
    const suiteRow = db
      .select()
      .from(suiteRuns)
      .all()
      .find((row) => row.id === "run-1");
    expect(suiteRow?.reportPdfPath).toBe(destination);
    // Export writes only the chosen destination — no internal report.pdf.
    expect(existsSync(join(suiteReportPaths(root, project.id, "run-1").dir, "report.pdf"))).toBe(
      false,
    );
  });

  it("suggests a suite-named PDF filename and slugifies the run id", () => {
    const { db } = seed();
    expect(suggestedPdfFileName(db, "run-1")).toBe("s-run-1.pdf");

    db.insert(suiteRuns)
      .values({
        id: "solo/run",
        suiteId: null,
        mode: "supervised",
        status: "passed",
        startedAt: 1000,
        endedAt: 2000,
      })
      .run();
    expect(suggestedPdfFileName(db, "solo/run")).toBe("run-report-solo-run.pdf");
    expect(() => suggestedPdfFileName(db, "ghost")).toThrow(SuiteRunNotFoundError);
  });

  it("tryWrite returns null and warns when the disk write fails", () => {
    const { db } = seed();
    const fileAsRoot = join(mkRoot(), "file");
    writeFileSync(fileAsRoot, "x");
    const warnings: string[] = [];
    expect(tryWriteSuiteHtmlReport(db, fileAsRoot, "run-1", (m) => warnings.push(m))).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(() => ensureSuiteHtmlPath(db, fileAsRoot, "ghost")).toThrow(SuiteRunNotFoundError);
  });
});
