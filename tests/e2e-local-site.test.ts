import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import type { EmitRunEvent } from "../src/main/runner/seams.js";
import { SingleCaseRunner } from "../src/main/runner/single-runner.js";
import { playwrightLauncher } from "../src/main/runner/launcher.js";
import { SuiteRunner } from "../src/main/suite-runner/suite-runner.js";
import { getSuiteReport } from "../src/main/reports/data.js";
import { readSuiteHtmlReport } from "../src/main/reports/files.js";
import { caseRuns, stepRuns, suiteRuns } from "../src/main/schema.js";
import { createDatabase } from "../src/main/db.js";
import type { AppDatabase } from "../src/main/db.js";
import { createCase, updateCase } from "../src/main/ipc-cases.js";
import { createProject, updateProject } from "../src/main/ipc-projects.js";
import {
  listSteps,
  moveStep,
  reorderSteps,
  setTestData,
  upsertStep,
} from "../src/main/ipc-steps.js";
import { createSuite, setSuiteCases, updateSuite } from "../src/main/ipc-suites.js";
import type { TestSite } from "./fixtures/test-site.js";
import { startTestSite } from "./fixtures/test-site.js";

/**
 * End-to-end validation against a local fixture site (see
 * tests/fixtures/test-site.ts). Hermetic: no external network, the server is
 * spun up on an ephemeral port for the suite and closed afterwards.
 *
 * Opt-in: needs real Chromium, so it stays skipped under plain `npm test` /
 * `npm run verify`. Run it explicitly with:
 *
 *   PLAYTEST_E2E=1 npx vitest run tests/e2e-local-site.test.ts
 *
 * Covers the full product loop: project → suite → cases → steps → KV data →
 * single run → parallel suite run → failure video/trace → rerun-failed →
 * missing-key fail-fast → HTML reports.
 */
const describeE2E = describe.skipIf(!process.env.PLAYTEST_E2E);

const STEP_TIMEOUT = 20_000;

describeE2E("e2e against local fixture site", () => {
  let site: TestSite;
  let artifactsRoot: string;
  let db: AppDatabase;
  let closeDb: () => void;
  const events: Array<{ channel: string; payload: unknown }> = [];
  const emit: EmitRunEvent = (channel, payload) => {
    events.push({ channel, payload });
  };

  beforeAll(async () => {
    site = await startTestSite();
    artifactsRoot = mkdtempSync(join(tmpdir(), "e2e-local-site-"));
    const handle = createDatabase(":memory:");
    db = handle.db;
    closeDb = handle.close;
  });

  afterAll(async () => {
    closeDb();
    await site.close();
  });

  it("project -> suite -> cases -> runs -> reports -> rerun", async () => {
    // --- Project / suite / cases (CRUD) ---
    const project = createProject(db, { name: "TestMart local", baseUrl: site.baseUrl });
    expect(project.baseUrl).toBe(site.baseUrl);
    expect(updateProject(db, { id: project.id, name: "TestMart local" }).name).toBe(
      "TestMart local",
    );

    const suite = createSuite(db, { projectId: project.id, name: "Smoke" });
    expect(updateSuite(db, { id: suite.id, name: "Smoke" }).name).toBe("Smoke");

    // Shared KV: base URL + order data substituted into `{{key}}` placeholders.
    const sharedData = { base: site.baseUrl, customer: "Ada", colour: "green" };

    const navigate = createCase(db, {
      projectId: project.id,
      name: "Navigate home",
      url: site.baseUrl,
    });
    expect(updateCase(db, { id: navigate.id, description: "e2e validation" }).id).toBe(navigate.id);
    setTestData(db, { caseId: navigate.id, data: { base: site.baseUrl } });
    const navSteps: Array<{
      order: number;
      action: "goto" | "assert-visible" | "assert-text" | "click";
      selector?: string;
      value?: string;
    }> = [
      { order: 0, action: "goto", value: "{{base}}/" },
      { order: 1, action: "assert-visible", selector: "h1" },
      { order: 2, action: "assert-text", selector: "nav", value: "Form" },
      { order: 3, action: "click", selector: 'nav a[href="/form"]' },
      { order: 4, action: "assert-visible", selector: "form#order" },
    ];
    for (const s of navSteps) {
      upsertStep(db, { caseId: navigate.id, step: { ...s, timeoutMs: STEP_TIMEOUT } });
    }
    expect(listSteps(db, navigate.id).map((s) => s.order)).toEqual([0, 1, 2, 3, 4]);

    // Order flow: fill + select + check + submit, echoed on /result.
    const order = createCase(db, { projectId: project.id, name: "Place order" });
    setTestData(db, { caseId: order.id, data: sharedData });
    const orderSteps: Array<{
      order: number;
      action: "goto" | "fill" | "select" | "check" | "click" | "assert-text";
      selector?: string;
      value?: string;
    }> = [
      { order: 0, action: "goto", value: "{{base}}/form" },
      { order: 1, action: "fill", selector: "#name", value: "{{customer}}" },
      { order: 2, action: "select", selector: "#color", value: "{{colour}}" },
      { order: 3, action: "check", selector: "#terms" },
      { order: 4, action: "click", selector: 'button[type="submit"]' },
      { order: 5, action: "assert-text", selector: "#summary", value: "Ada" },
    ];
    for (const s of orderSteps) {
      upsertStep(db, { caseId: order.id, step: { ...s, timeoutMs: STEP_TIMEOUT } });
    }

    // Search flow: fill + Enter (press) submits the GET form.
    const search = createCase(db, { projectId: project.id, name: "Search products" });
    setTestData(db, { caseId: search.id, data: { base: site.baseUrl } });
    upsertStep(db, {
      caseId: search.id,
      step: { order: 0, action: "goto", value: "{{base}}/products", timeoutMs: STEP_TIMEOUT },
    });
    upsertStep(db, {
      caseId: search.id,
      step: { order: 1, action: "fill", selector: "#q", value: "an", timeoutMs: STEP_TIMEOUT },
    });
    upsertStep(db, {
      caseId: search.id,
      step: { order: 2, action: "press", selector: "#q", value: "Enter", timeoutMs: STEP_TIMEOUT },
    });
    upsertStep(db, {
      caseId: search.id,
      step: {
        order: 3,
        action: "assert-text",
        selector: "ul",
        value: "Banana",
        timeoutMs: STEP_TIMEOUT,
      },
    });

    // Step move/reorder API on a scratch case (keeps run cases untouched)
    const scratch = createCase(db, { projectId: project.id, name: "scratch" });
    const s0 = upsertStep(db, {
      caseId: scratch.id,
      step: { order: 0, action: "wait", value: "10" },
    });
    const s1 = upsertStep(db, {
      caseId: scratch.id,
      step: { order: 1, action: "wait", value: "10" },
    });
    moveStep(db, { caseId: scratch.id, id: s1.id, toOrder: 0 });
    expect(listSteps(db, scratch.id).map((s) => s.id)[0]).toBe(s1.id);
    reorderSteps(db, { caseId: scratch.id, orderedIds: [s0.id, s1.id] });
    expect(listSteps(db, scratch.id).map((s) => s.id)).toEqual([s0.id, s1.id]);

    setSuiteCases(db, suite.id, [navigate.id, order.id, search.id]);

    // --- Single-case run (unsupervised, headless, real Chromium) ---
    const single = new SingleCaseRunner(db, {
      launchBrowser: playwrightLauncher(),
      emit,
      artifactsRoot,
    });
    const started = single.runSingle({ caseId: navigate.id, mode: "unsupervised" });
    await started.done;
    const caseRow = db.select().from(caseRuns).where(eq(caseRuns.id, started.caseRunId)).all()[0];
    expect(caseRow?.status).toBe("passed");
    const stepRows = db
      .select()
      .from(stepRuns)
      .where(eq(stepRuns.caseRunId, started.caseRunId))
      .all();
    expect(stepRows.filter((r) => r.status === "pass").length).toBe(5);
    for (const r of stepRows) {
      expect(r.screenshotPath).not.toBeNull();
      expect(existsSync(r.screenshotPath as string)).toBe(true);
    }
    // Pass runs discard video
    expect(caseRow?.videoPath).toBeNull();
    const html = readSuiteHtmlReport(db, artifactsRoot, started.suiteRunId);
    expect(html).toContain("Navigate home");

    // --- Parallel suite run ---
    const suiteRunner = new SuiteRunner(db, {
      launchBrowser: playwrightLauncher(),
      emit,
      artifactsRoot,
    });
    const suiteStarted = suiteRunner.runSuite({
      suiteId: suite.id,
      caseIds: [navigate.id, order.id, search.id],
      mode: "unsupervised",
    });
    await suiteStarted.done;
    const report = getSuiteReport(db, suiteStarted.suiteRunId);
    expect(report.summary).toMatchObject({ total: 3, passed: 3, failed: 0 });
    const suiteHtml = readSuiteHtmlReport(db, artifactsRoot, suiteStarted.suiteRunId);
    expect(suiteHtml).toContain("Place order");
    expect(events.filter((e) => e.channel === "run:finished").length).toBeGreaterThanOrEqual(2);

    // --- Intentional failure: video retained, rerun-failed path ---
    const failing = createCase(db, { projectId: project.id, name: "Intentional failure" });
    setTestData(db, { caseId: failing.id, data: { base: site.baseUrl } });
    upsertStep(db, {
      caseId: failing.id,
      step: { order: 0, action: "goto", value: "{{base}}/", timeoutMs: STEP_TIMEOUT },
    });
    upsertStep(db, {
      caseId: failing.id,
      step: {
        order: 1,
        action: "assert-text",
        selector: "h1",
        value: "zzz-no-such-text-zzz",
        timeoutMs: 5000,
      },
    });
    const single2 = new SingleCaseRunner(db, {
      launchBrowser: playwrightLauncher(),
      emit,
      artifactsRoot,
    });
    const failStarted = single2.runSingle({ caseId: failing.id, mode: "unsupervised" });
    await failStarted.done;
    const failRow = db
      .select()
      .from(caseRuns)
      .where(eq(caseRuns.id, failStarted.caseRunId))
      .all()[0];
    expect(failRow?.status).toBe("failed");
    expect(failRow?.videoPath).not.toBeNull();
    expect(existsSync(failRow?.videoPath as string)).toBe(true);

    // The mixed run below passes explicit caseIds, so the failing case must be
    // a suite member (runSuite rejects non-members).
    setSuiteCases(db, suite.id, [navigate.id, failing.id]);

    const suiteRunner2 = new SuiteRunner(db, {
      launchBrowser: playwrightLauncher(),
      emit,
      artifactsRoot,
    });
    const mixed = suiteRunner2.runSuite({
      suiteId: suite.id,
      caseIds: [navigate.id, failing.id],
      mode: "unsupervised",
    });
    await mixed.done;
    const mixedReport = getSuiteReport(db, mixed.suiteRunId);
    expect(mixedReport.summary).toMatchObject({ total: 2, passed: 1, failed: 1 });

    const suiteRunner3 = new SuiteRunner(db, {
      launchBrowser: playwrightLauncher(),
      emit,
      artifactsRoot,
    });
    const retry = suiteRunner3.rerunFailed({ suiteRunId: mixed.suiteRunId });
    await retry.done;
    const retryReport = getSuiteReport(db, retry.suiteRunId);
    expect(retryReport.summary.total).toBe(1);
    expect(retryReport.summary.failed).toBe(1);

    // --- Missing KV key: fail-fast without browser ---
    const missing = createCase(db, { projectId: project.id, name: "Missing key" });
    upsertStep(db, {
      caseId: missing.id,
      step: { order: 0, action: "goto", value: "{{nosuchkey}}/x" },
    });
    const single3 = new SingleCaseRunner(db, {
      launchBrowser: playwrightLauncher(),
      emit,
      artifactsRoot,
    });
    const missStarted = single3.runSingle({ caseId: missing.id, mode: "unsupervised" });
    await missStarted.done;
    const missRow = db
      .select()
      .from(caseRuns)
      .where(eq(caseRuns.id, missStarted.caseRunId))
      .all()[0];
    expect(missRow?.status).toBe("failed");
    const missSteps = db
      .select()
      .from(stepRuns)
      .where(eq(stepRuns.caseRunId, missStarted.caseRunId))
      .all();
    expect(missSteps[0]?.error).toContain("missing test-data key: nosuchkey");

    // Evidence listing (printed for the human log)
    const runs = db.select().from(suiteRuns).all();
    console.log(
      JSON.stringify(
        {
          artifactsRoot,
          suiteRuns: runs.length,
          events: events.length,
          files: existsSync(artifactsRoot) ? readdirSync(artifactsRoot).length : 0,
        },
        null,
        2,
      ),
    );
  }, 300_000);
});
