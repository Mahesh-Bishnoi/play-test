import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import type { EmitRunEvent } from "../src/main/runner/seams.js";
import type { StepAction } from "../src/shared/step-types.js";
import { SingleCaseRunner } from "../src/main/runner/single-runner.js";
import { playwrightLauncher } from "../src/main/runner/launcher.js";
import { SuiteRunner } from "../src/main/suite-runner/suite-runner.js";
import { getSuiteReport } from "../src/main/reports/data.js";
import { readSuiteHtmlReport } from "../src/main/reports/files.js";
import { caseRuns, stepRuns } from "../src/main/schema.js";
import type { AppDatabase } from "../src/main/db.js";
import { createDatabase } from "../src/main/db.js";
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

/**
 * Exhaustive end-to-end coverage of the product against DummyTax
 * (dummy-tax-site/server.js) — the fake income-tax portal.
 *
 * Opt-in: needs real Chromium, so it stays skipped under plain `npm test` /
 * `npm run verify`. Run it explicitly with:
 *
 *   PLAYTEST_E2E=1 npx vitest run tests/e2e-dummy-tax-site.test.ts
 *   npm run test:e2e   (both e2e files)
 *
 * The server is spawned as a real child process on an ephemeral port
 * (`--port 0`, same CLI the user runs) and killed afterwards; in-memory
 * site state is reset via /__reset wherever a test needs a clean slate.
 *
 * Product surface covered:
 * - every step action: goto, click (+dblclick branch excluded — flaky on
 *   navigations), fill, select, check, press, assert-visible, assert-text, wait
 * - CSS, text-engine, and recorder-style getBy* selectors
 * - KV substitution ({{key}}) on every value-bearing action + missing-key fail-fast
 * - single runs (screenshots per step, video discarded on pass / retained on fail)
 * - parallel suite runs, mixed results, rerun-failed, HTML reports
 * - project/suite/case/step CRUD + step move/reorder (no browser)
 */
const describeE2E = describe.skipIf(!process.env.PLAYTEST_E2E);

const STEP_TIMEOUT = 20_000;

interface StepDef {
  order: number;
  action: StepAction;
  selector?: string;
  value?: string;
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function spawnDummyTaxSite(): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const child: ChildProcess = spawn(process.execPath, ["dummy-tax-site/server.js", "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(
      () => reject(new Error(`dummy tax site did not boot: ${out}`)),
      15_000,
    );
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`dummy tax site exited early with code ${String(code)}: ${out}`));
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const url = /DummyTax portal: (http:\/\/127\.0\.0\.1:\d+)/.exec(out)?.[1];
      if (url) {
        clearTimeout(timer);
        resolve(url);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) break;
    } catch {
      // Not up yet — retry below.
    }
    await sleep(100);
  }
  const health = await fetch(`${baseUrl}/health`);
  if (!health.ok) throw new Error(`dummy tax site unhealthy at ${baseUrl}`);
  return {
    baseUrl,
    stop: () =>
      new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
        child.kill();
        setTimeout(() => resolve(), 5000);
      }),
  };
}

describeE2E("e2e against dummy income-tax site", () => {
  let baseUrl = "";
  let stopSite: () => Promise<void> = () => Promise.resolve();
  let artifactsRoot = "";
  let db: AppDatabase;
  let closeDb: () => void = () => {};
  let projectId = "";
  let suiteId = "";
  const events: Array<{ channel: string; payload: unknown }> = [];
  const emit: EmitRunEvent = (channel, payload) => {
    events.push({ channel, payload });
  };

  /** Shared KV data — substituted into {{key}} placeholders at run time. */
  const kv = {
    base: "",
    email: "test@example.com",
    password: "password123",
    name: "Aarav Sharma",
    newName: "Tax Payer One",
    phone: "9998887776",
    address: "14 Residency Road, Bengaluru 560025",
    year: "2025-26",
    pan: "ABCDE1234F",
    salary: "950000",
    other: "60000",
    c80: "150000",
    bank: "XXXX-XXXX-9911",
    reply: "Bank statements for FY 2023-24 attached for verification.",
  };

  async function resetSite(): Promise<void> {
    const res = await fetch(`${baseUrl}/__reset`);
    expect(res.ok).toBe(true);
  }

  function defineCase(name: string, data: Record<string, string>, steps: StepDef[]): string {
    const c = createCase(db, { projectId, name });
    setTestData(db, { caseId: c.id, data });
    for (const s of steps) {
      upsertStep(db, { caseId: c.id, step: { ...s, timeoutMs: s.timeoutMs ?? STEP_TIMEOUT } });
    }
    return c.id;
  }

  async function runSingle(caseId: string): Promise<{ suiteRunId: string; caseRunId: string }> {
    const runner = new SingleCaseRunner(db, {
      launchBrowser: playwrightLauncher(),
      emit,
      artifactsRoot,
    });
    const started = runner.runSingle({ caseId, mode: "unsupervised" });
    await started.done;
    return started;
  }

  function caseStatus(caseRunId: string): string | null {
    const row = db.select().from(caseRuns).where(eq(caseRuns.id, caseRunId)).all()[0];
    return row?.status ?? null;
  }

  function stepStatuses(caseRunId: string): Array<{ status: string; error: string | null }> {
    return db
      .select({ status: stepRuns.status, error: stepRuns.error })
      .from(stepRuns)
      .where(eq(stepRuns.caseRunId, caseRunId))
      .all();
  }

  function expectScreenshots(caseRunId: string, count: number): void {
    const rows = db
      .select({ screenshotPath: stepRuns.screenshotPath })
      .from(stepRuns)
      .where(eq(stepRuns.caseRunId, caseRunId))
      .all();
    expect(rows.length).toBe(count);
    for (const r of rows) {
      expect(r.screenshotPath).not.toBeNull();
      expect(existsSync(r.screenshotPath as string)).toBe(true);
    }
  }

  beforeAll(async () => {
    const site = await spawnDummyTaxSite();
    baseUrl = site.baseUrl;
    stopSite = site.stop;
    kv.base = baseUrl;
    artifactsRoot = mkdtempSync(join(tmpdir(), "e2e-dummy-tax-"));
    const handle = createDatabase(":memory:");
    db = handle.db;
    closeDb = handle.close;

    const project = createProject(db, { name: "DummyTax portal", baseUrl });
    expect(updateProject(db, { id: project.id, name: "DummyTax portal" }).id).toBe(project.id);
    projectId = project.id;
    const suite = createSuite(db, { projectId, name: "Tax flows" });
    expect(updateSuite(db, { id: suite.id, name: "Tax flows" }).id).toBe(suite.id);
    suiteId = suite.id;
  }, 60_000);

  afterAll(async () => {
    closeDb();
    await stopSite();
  });

  it("survives a malformed cookie header (review counted #8)", async () => {
    const bad = await fetch(`${baseUrl}/login`, {
      headers: { cookie: "tax_session=%E0%A4%A" },
    });
    expect(bad.status).toBe(200);
    // The process is still serving after the malformed decode.
    const after = await fetch(`${baseUrl}/login`);
    expect(after.status).toBe(200);
  });

  it("login happy path: goto + fill + click + assert-text with KV data", async () => {
    await resetSite();
    const caseId = defineCase("Tax login", kv, [
      { order: 0, action: "goto", value: "{{base}}/login" },
      { order: 1, action: "fill", selector: "#email", value: "{{email}}" },
      { order: 2, action: "fill", selector: "#password", value: "{{password}}" },
      { order: 3, action: "click", selector: '[data-testid="login-submit"]' },
      { order: 4, action: "assert-text", selector: "#welcome", value: "{{name}}" },
    ]);
    setSuiteCases(db, suiteId, [caseId]);
    const started = await runSingle(caseId);
    expect(caseStatus(started.caseRunId)).toBe("passed");
    expect(stepStatuses(started.caseRunId).every((s) => s.status === "pass")).toBe(true);
    expectScreenshots(started.caseRunId, 5);
    // Passing runs discard video.
    const row = db.select().from(caseRuns).where(eq(caseRuns.id, started.caseRunId)).all()[0];
    expect(row?.videoPath).toBeNull();
  }, 120_000);

  it("login validation: wrong password shows #login-error", async () => {
    await resetSite();
    const caseId = defineCase("Tax login rejected", kv, [
      { order: 0, action: "goto", value: "{{base}}/login" },
      { order: 1, action: "fill", selector: "#email", value: "{{email}}" },
      { order: 2, action: "fill", selector: "#password", value: "wrong-password" },
      { order: 3, action: "click", selector: "#login-form button[type='submit']" },
      { order: 4, action: "assert-visible", selector: "#login-error" },
      { order: 5, action: "assert-text", selector: "#login-error", value: "Invalid email" },
    ]);
    const started = await runSingle(caseId);
    expect(caseStatus(started.caseRunId)).toBe("passed");
    expectScreenshots(started.caseRunId, 6);
  }, 120_000);

  it("auth guard: unauthenticated dashboard redirects to login", async () => {
    await resetSite();
    const caseId = defineCase("Tax auth guard", kv, [
      { order: 0, action: "goto", value: "{{base}}/dashboard" },
      { order: 1, action: "assert-visible", selector: "#login-form" },
    ]);
    const started = await runSingle(caseId);
    expect(caseStatus(started.caseRunId)).toBe("passed");
  }, 120_000);

  it("keyboard login: fill + press Enter submits the form", async () => {
    await resetSite();
    const caseId = defineCase("Tax keyboard login", kv, [
      { order: 0, action: "goto", value: "{{base}}/login" },
      { order: 1, action: "fill", selector: "#email", value: "{{email}}" },
      { order: 2, action: "fill", selector: "#password", value: "{{password}}" },
      { order: 3, action: "press", selector: "#password", value: "Enter" },
      { order: 4, action: "assert-visible", selector: "#welcome" },
    ]);
    const started = await runSingle(caseId);
    expect(caseStatus(started.caseRunId)).toBe("passed");
  }, 120_000);

  it("recorder-style selectors: getByTestId / getByRole / getByLabel chains", async () => {
    await resetSite();
    const caseId = defineCase("Tax locator chains", kv, [
      { order: 0, action: "goto", value: "{{base}}/" },
      { order: 1, action: "click", selector: "getByTestId('cta-login')" },
      { order: 2, action: "fill", selector: "getByLabel('Email')", value: "{{email}}" },
      { order: 3, action: "fill", selector: "getByLabel('Password')", value: "{{password}}" },
      {
        order: 4,
        action: "click",
        selector: "getByRole('button', { name: 'Sign in' })",
      },
      { order: 5, action: "assert-text", selector: "getByTestId('welcome')", value: "{{email}}" },
    ]);
    const started = await runSingle(caseId);
    expect(caseStatus(started.caseRunId)).toBe("passed");
    expectScreenshots(started.caseRunId, 6);
  }, 120_000);

  it("profile update: fill KV fields + save + cross-page assert", async () => {
    await resetSite();
    const caseId = defineCase("Tax profile update", kv, [
      { order: 0, action: "goto", value: "{{base}}/login" },
      { order: 1, action: "fill", selector: "#email", value: "{{email}}" },
      { order: 2, action: "fill", selector: "#password", value: "{{password}}" },
      { order: 3, action: "click", selector: '[data-testid="login-submit"]' },
      { order: 4, action: "goto", value: "{{base}}/profile" },
      { order: 5, action: "fill", selector: "#fullName", value: "{{newName}}" },
      { order: 6, action: "fill", selector: "#phone", value: "{{phone}}" },
      { order: 7, action: "fill", selector: "#address", value: "{{address}}" },
      { order: 8, action: "click", selector: '[data-testid="profile-save"]' },
      { order: 9, action: "assert-visible", selector: "#profile-saved" },
      { order: 10, action: "goto", value: "{{base}}/dashboard" },
      { order: 11, action: "assert-text", selector: "#welcome", value: "{{newName}}" },
    ]);
    const started = await runSingle(caseId);
    expect(caseStatus(started.caseRunId)).toBe("passed");
    expectScreenshots(started.caseRunId, 12);
  }, 180_000);

  it("file return: select + fill + check + submit + history", async () => {
    await resetSite();
    const caseId = defineCase("Tax file return", kv, [
      { order: 0, action: "goto", value: "{{base}}/login" },
      { order: 1, action: "fill", selector: "#email", value: "{{email}}" },
      { order: 2, action: "fill", selector: "#password", value: "{{password}}" },
      { order: 3, action: "click", selector: '[data-testid="login-submit"]' },
      { order: 4, action: "goto", value: "{{base}}/file-return" },
      { order: 5, action: "select", selector: "#assessmentYear", value: "{{year}}" },
      { order: 6, action: "fill", selector: "#pan", value: "{{pan}}" },
      { order: 7, action: "fill", selector: "#incomeSalary", value: "{{salary}}" },
      { order: 8, action: "fill", selector: "#incomeOther", value: "{{other}}" },
      { order: 9, action: "fill", selector: "#deductions80C", value: "{{c80}}" },
      { order: 10, action: "fill", selector: "#bankAccount", value: "{{bank}}" },
      { order: 11, action: "check", selector: "#verify" },
      { order: 12, action: "click", selector: '[data-testid="itr-submit"]' },
      { order: 13, action: "assert-visible", selector: "#acknowledgement" },
      {
        order: 14,
        action: "assert-text",
        selector: "#acknowledgement",
        value: "Acknowledgement no",
      },
      { order: 15, action: "assert-text", selector: "#filing-summary", value: "{{year}}" },
      { order: 16, action: "click", selector: '[data-testid="back-filings"]' },
      { order: 17, action: "assert-visible", selector: '[data-testid="filings-table"]' },
      {
        order: 18,
        action: "assert-text",
        selector: '[data-testid="filings-table"]',
        value: "{{year}}",
      },
    ]);
    const started = await runSingle(caseId);
    expect(caseStatus(started.caseRunId)).toBe("passed");
    expectScreenshots(started.caseRunId, 19);
  }, 180_000);

  it("file return validation: missing checkbox + bad PAN show #form-error", async () => {
    await resetSite();
    const caseId = defineCase("Tax filing validation", kv, [
      { order: 0, action: "goto", value: "{{base}}/login" },
      { order: 1, action: "fill", selector: "#email", value: "{{email}}" },
      { order: 2, action: "fill", selector: "#password", value: "{{password}}" },
      { order: 3, action: "click", selector: '[data-testid="login-submit"]' },
      { order: 4, action: "goto", value: "{{base}}/file-return" },
      { order: 5, action: "click", selector: '[data-testid="itr-submit"]' },
      { order: 6, action: "assert-text", selector: "#form-error", value: "verification checkbox" },
      { order: 7, action: "fill", selector: "#pan", value: "BADPAN1" },
      { order: 8, action: "check", selector: "#verify" },
      { order: 9, action: "click", selector: '[data-testid="itr-submit"]' },
      { order: 10, action: "assert-text", selector: "#form-error", value: "PAN must look like" },
    ]);
    const started = await runSingle(caseId);
    expect(caseStatus(started.caseRunId)).toBe("passed");
  }, 180_000);

  it("notices: filter + open + respond + wait", async () => {
    await resetSite();
    const caseId = defineCase("Tax notice response", kv, [
      { order: 0, action: "goto", value: "{{base}}/login" },
      { order: 1, action: "fill", selector: "#email", value: "{{email}}" },
      { order: 2, action: "fill", selector: "#password", value: "{{password}}" },
      { order: 3, action: "click", selector: '[data-testid="login-submit"]' },
      { order: 4, action: "goto", value: "{{base}}/notices" },
      { order: 5, action: "assert-visible", selector: '[data-testid="notices-table"]' },
      { order: 6, action: "select", selector: "#status", value: "Open" },
      { order: 7, action: "click", selector: '[data-testid="notice-filter-submit"]' },
      {
        order: 8,
        action: "assert-text",
        selector: '[data-testid="notices-table"]',
        value: "ITR-2024-001",
      },
      { order: 9, action: "click", selector: '[data-testid="notice-link-ITR-2024-001"]' },
      {
        order: 10,
        action: "assert-text",
        selector: '[data-testid="notice-title"]',
        value: "Defective return",
      },
      { order: 11, action: "fill", selector: "#response", value: "{{reply}}" },
      { order: 12, action: "click", selector: '[data-testid="notice-respond-submit"]' },
      { order: 13, action: "assert-visible", selector: "#response-saved" },
      {
        order: 14,
        action: "assert-text",
        selector: '[data-testid="notice-response"]',
        value: "Bank statements",
      },
      { order: 15, action: "wait", value: "500" },
    ]);
    const started = await runSingle(caseId);
    expect(caseStatus(started.caseRunId)).toBe("passed");
    expectScreenshots(started.caseRunId, 16);
  }, 180_000);

  it("step CRUD without browser: move + reorder", async () => {
    const scratch = createCase(db, { projectId, name: "tax scratch" });
    expect(updateCase(db, { id: scratch.id, description: "scratch" }).id).toBe(scratch.id);
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
  });

  it("parallel suite: independent tax cases pass together + HTML report", async () => {
    await resetSite();
    const login = defineCase("Suite tax login", kv, [
      { order: 0, action: "goto", value: "{{base}}/login" },
      { order: 1, action: "fill", selector: "#email", value: "{{email}}" },
      { order: 2, action: "fill", selector: "#password", value: "{{password}}" },
      { order: 3, action: "click", selector: '[data-testid="login-submit"]' },
      { order: 4, action: "assert-text", selector: "#welcome", value: "{{email}}" },
    ]);
    const browse = defineCase("Suite browse notices", kv, [
      { order: 0, action: "goto", value: "{{base}}/login" },
      { order: 1, action: "fill", selector: "#email", value: "{{email}}" },
      { order: 2, action: "fill", selector: "#password", value: "{{password}}" },
      { order: 3, action: "click", selector: '[data-testid="login-submit"]' },
      { order: 4, action: "goto", value: "{{base}}/notices?status=Closed" },
      {
        order: 5,
        action: "assert-text",
        selector: '[data-testid="notices-table"]',
        value: "ITR-2024-002",
      },
    ]);
    const dashboard = defineCase("Suite dashboard", kv, [
      { order: 0, action: "goto", value: "{{base}}/login" },
      { order: 1, action: "fill", selector: "#email", value: "{{email}}" },
      { order: 2, action: "fill", selector: "#password", value: "{{password}}" },
      { order: 3, action: "click", selector: '[data-testid="login-submit"]' },
      { order: 4, action: "assert-visible", selector: '[data-testid="notice-count"]' },
      { order: 5, action: "assert-text", selector: '[data-testid="filing-count"]', value: "0" },
    ]);
    setSuiteCases(db, suiteId, [login, browse, dashboard]);
    const runner = new SuiteRunner(db, {
      launchBrowser: playwrightLauncher(),
      emit,
      artifactsRoot,
    });
    const started = runner.runSuite({
      suiteId,
      caseIds: [login, browse, dashboard],
      mode: "unsupervised",
    });
    await started.done;
    const report = getSuiteReport(db, started.suiteRunId);
    expect(report.summary).toMatchObject({ total: 3, passed: 3, failed: 0 });
    const html = readSuiteHtmlReport(db, artifactsRoot, started.suiteRunId);
    expect(html).toContain("Suite tax login");
    expect(html).toContain("Suite browse notices");
    expect(html).toContain("Suite dashboard");
    expect(events.filter((e) => e.channel === "run:finished").length).toBeGreaterThanOrEqual(1);
  }, 240_000);

  it("failure video + mixed suite + rerun-failed", async () => {
    await resetSite();
    const login = defineCase("Retry tax login", kv, [
      { order: 0, action: "goto", value: "{{base}}/login" },
      { order: 1, action: "fill", selector: "#email", value: "{{email}}" },
      { order: 2, action: "fill", selector: "#password", value: "{{password}}" },
      { order: 3, action: "click", selector: '[data-testid="login-submit"]' },
      { order: 4, action: "assert-visible", selector: "#welcome" },
    ]);
    const failing = defineCase("Retry tax failure", kv, [
      { order: 0, action: "goto", value: "{{base}}/dashboard" },
      // No session in a fresh context: the guard redirects to /login, so the
      // dashboard welcome text is never present. Short timeout — this must fail.
      {
        order: 1,
        action: "assert-text",
        selector: "#welcome",
        value: "zzz-no-such-text-zzz",
        timeoutMs: 5000,
      },
    ]);

    const single = new SingleCaseRunner(db, {
      launchBrowser: playwrightLauncher(),
      emit,
      artifactsRoot,
    });
    const failStarted = single.runSingle({ caseId: failing, mode: "unsupervised" });
    await failStarted.done;
    expect(caseStatus(failStarted.caseRunId)).toBe("failed");
    const failRow = db
      .select()
      .from(caseRuns)
      .where(eq(caseRuns.id, failStarted.caseRunId))
      .all()[0];
    expect(failRow?.videoPath).not.toBeNull();
    expect(existsSync(failRow?.videoPath as string)).toBe(true);

    // The mixed run below passes explicit caseIds, so the failing case must be
    // a suite member (runSuite rejects non-members).
    setSuiteCases(db, suiteId, [login, failing]);

    const suiteRunner = new SuiteRunner(db, {
      launchBrowser: playwrightLauncher(),
      emit,
      artifactsRoot,
    });
    const mixed = suiteRunner.runSuite({
      suiteId,
      caseIds: [login, failing],
      mode: "unsupervised",
    });
    await mixed.done;
    expect(getSuiteReport(db, mixed.suiteRunId).summary).toMatchObject({
      total: 2,
      passed: 1,
      failed: 1,
    });

    const retryRunner = new SuiteRunner(db, {
      launchBrowser: playwrightLauncher(),
      emit,
      artifactsRoot,
    });
    const retry = retryRunner.rerunFailed({ suiteRunId: mixed.suiteRunId });
    await retry.done;
    const retryReport = getSuiteReport(db, retry.suiteRunId);
    expect(retryReport.summary.total).toBe(1);
    expect(retryReport.summary.failed).toBe(1);
    expect(readSuiteHtmlReport(db, artifactsRoot, retry.suiteRunId)).toContain("Retry tax failure");
  }, 240_000);

  it("input parity: type + focus + hover + value/editable/enabled/count/title/url", async () => {
    await resetSite();
    const caseId = defineCase("Tax input parity", kv, [
      { order: 0, action: "goto", value: "{{base}}/login" },
      { order: 1, action: "assert-title", value: "/Login/" },
      { order: 2, action: "assert-url", value: "/\\/login$/" },
      { order: 3, action: "type", selector: "#email", value: "{{email}}" },
      { order: 4, action: "assert-value", selector: "#email", value: "{{email}}" },
      { order: 5, action: "assert-editable", selector: "#email" },
      { order: 6, action: "focus", selector: "#password" },
      { order: 7, action: "assert-focused", selector: "#password" },
      { order: 8, action: "fill", selector: "#password", value: "{{password}}" },
      { order: 9, action: "hover", selector: '[data-testid="login-submit"]' },
      { order: 10, action: "assert-enabled", selector: '[data-testid="login-submit"]' },
      { order: 11, action: "assert-count", selector: "#login-form input", value: "2" },
      { order: 12, action: "click", selector: '[data-testid="login-submit"]' },
      { order: 13, action: "assert-text", selector: "#welcome", value: "{{name}}" },
    ]);
    const started = await runSingle(caseId);
    expect(caseStatus(started.caseRunId)).toBe("passed");
    expectScreenshots(started.caseRunId, 14);
  }, 120_000);

  it("checkbox + hidden asserts + dblclick navigation", async () => {
    await resetSite();
    const caseId = defineCase("Tax checkbox parity", kv, [
      { order: 0, action: "goto", value: "{{base}}/" },
      { order: 1, action: "dblclick", selector: "getByTestId('cta-login')" },
      { order: 2, action: "assert-url", value: "/\\/login$/" },
      { order: 3, action: "fill", selector: "#email", value: "{{email}}" },
      { order: 4, action: "fill", selector: "#password", value: "{{password}}" },
      { order: 5, action: "click", selector: '[data-testid="login-submit"]' },
      { order: 6, action: "goto", value: "{{base}}/file-return" },
      { order: 7, action: "check", selector: "#verify" },
      { order: 8, action: "assert-checked", selector: "#verify" },
      { order: 9, action: "uncheck", selector: "#verify" },
      { order: 10, action: "assert-unchecked", selector: "#verify" },
      // Authed users hitting /login land on the dashboard: the login form
      // is gone (assert-hidden) and the URL proves the redirect.
      { order: 11, action: "goto", value: "{{base}}/login" },
      { order: 12, action: "assert-hidden", selector: "#login-form" },
      { order: 13, action: "assert-url", value: "/\\/dashboard$/" },
    ]);
    const started = await runSingle(caseId);
    expect(caseStatus(started.caseRunId)).toBe("passed");
    expectScreenshots(started.caseRunId, 14);
  }, 120_000);

  it("missing KV key fails fast with a clear error", async () => {
    const caseId = defineCase("Tax missing key", {}, [
      { order: 0, action: "goto", value: "{{nosuchkey}}/login" },
    ]);
    const started = await runSingle(caseId);
    expect(caseStatus(started.caseRunId)).toBe("failed");
    expect(stepStatuses(started.caseRunId)[0]?.error).toContain("missing test-data key: nosuchkey");
  }, 60_000);
});
