import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import type { EmitRunEvent } from "../src/main/runner/seams.js";
import { SingleCaseRunner } from "../src/main/runner/single-runner.js";
import { playwrightLauncher } from "../src/main/runner/launcher.js";
import { caseTracePath } from "../src/main/artifacts.js";
import { createDatabase } from "../src/main/db.js";
import type { AppDatabase } from "../src/main/db.js";
import { createCase } from "../src/main/ipc-cases.js";
import { createProject } from "../src/main/ipc-projects.js";
import { upsertStep } from "../src/main/ipc-steps.js";
import { caseRuns, stepRuns } from "../src/main/schema.js";
import type { TestStep } from "../src/shared/step-types.js";
import type { TestSite } from "./fixtures/test-site.js";
import { startTestSite } from "./fixtures/test-site.js";

/**
 * End-to-end validation of the M13 web-first assertions against real Chromium
 * (local fixture site, hermetic). Opt-in like the other e2e legs:
 *
 *   PLAYTEST_E2E=1 npx vitest run tests/e2e-assertions.test.ts
 *
 * Covers: strict-mode violations, `/regex/` vs exact URL/title values, the
 * Playwright call log surviving into `step_runs.error`, and a supervised
 * failure writing `trace.zip` before it pauses.
 */
const describeE2E = describe.skipIf(!process.env.PLAYTEST_E2E);

/** Generous budget for a step that is expected to pass. */
const STEP_TIMEOUT = 20_000;
/** Short budget so an intentional failure settles fast. */
const FAIL_STEP_TIMEOUT = 3_000;
/** Each test launches a real browser and may burn two assertion timeouts. */
const TEST_TIMEOUT = 120_000;

describeE2E("e2e: web-first assertions and failure diagnostics (M13)", () => {
  let site: TestSite;
  let artifactsRoot: string;
  let db: AppDatabase;
  let closeDb: () => void;
  let projectId: string;
  const events: Array<{ channel: string; payload: unknown }> = [];
  const emit: EmitRunEvent = (channel, payload) => {
    events.push({ channel, payload });
  };

  beforeAll(async () => {
    site = await startTestSite();
    artifactsRoot = mkdtempSync(join(tmpdir(), "e2e-assertions-"));
    const handle = createDatabase(":memory:");
    db = handle.db;
    closeDb = handle.close;
    projectId = createProject(db, { name: "Assertions", baseUrl: site.baseUrl }).id;
  });

  afterAll(async () => {
    closeDb();
    await site.close();
  });

  function seedCase(name: string, steps: TestStep[]): string {
    const testCase = createCase(db, { projectId, name, url: site.baseUrl });
    for (const step of steps) {
      upsertStep(db, { caseId: testCase.id, step });
    }
    return testCase.id;
  }

  function startRun(caseId: string, mode: "supervised" | "unsupervised" = "unsupervised") {
    const runner = new SingleCaseRunner(db, {
      launchBrowser: playwrightLauncher(),
      emit,
      artifactsRoot,
    });
    const started = runner.runSingle({ caseId, mode });
    return { runner, started };
  }

  function stepRowsOf(caseRunId: string) {
    return db.select().from(stepRuns).where(eq(stepRuns.caseRunId, caseRunId)).all();
  }

  function caseRowOf(caseRunId: string) {
    return db.select().from(caseRuns).where(eq(caseRuns.id, caseRunId)).all()[0];
  }

  it(
    "fails an assertion on a multi-element selector with the strict-mode error",
    async () => {
      const caseId = seedCase("Strict violation", [
        { order: 0, action: "goto", value: `${site.baseUrl}/`, timeoutMs: STEP_TIMEOUT },
        {
          order: 1,
          action: "assert-text",
          selector: "nav a",
          value: "Home",
          timeoutMs: FAIL_STEP_TIMEOUT,
        },
      ]);
      const { started } = startRun(caseId);
      await started.done;

      const rows = stepRowsOf(started.caseRunId);
      // The nav holds three links, so strict mode refuses to pick one.
      expect(rows.map((r) => r.status)).toEqual(["pass", "fail"]);
      expect(rows[1]?.error).toContain("resolved to 3 elements");
      expect(caseRowOf(started.caseRunId)?.status).toBe("failed");
    },
    TEST_TIMEOUT,
  );

  it(
    "patterns a dynamic URL with /regex/ while a plain string stays exact",
    async () => {
      const searchSteps: TestStep[] = [
        { order: 0, action: "goto", value: `${site.baseUrl}/products`, timeoutMs: STEP_TIMEOUT },
        { order: 1, action: "fill", selector: "#q", value: "an", timeoutMs: STEP_TIMEOUT },
        { order: 2, action: "press", selector: "#q", value: "Enter", timeoutMs: STEP_TIMEOUT },
      ];

      const regexCaseId = seedCase("URL regex", [
        ...searchSteps,
        {
          order: 3,
          action: "assert-url",
          value: "/\\/products\\?q=an$/",
          timeoutMs: FAIL_STEP_TIMEOUT,
        },
      ]);
      const passed = startRun(regexCaseId);
      await passed.started.done;
      expect(stepRowsOf(passed.started.caseRunId).map((r) => r.status)).toEqual([
        "pass",
        "pass",
        "pass",
        "pass",
      ]);

      // The very same navigation asserted with the bare URL (no query) fails:
      // plain values match exactly, never as a substring or a glob.
      const exactCaseId = seedCase("URL exact", [
        ...searchSteps,
        {
          order: 3,
          action: "assert-url",
          value: `${site.baseUrl}/products`,
          timeoutMs: FAIL_STEP_TIMEOUT,
        },
      ]);
      const failed = startRun(exactCaseId);
      await failed.started.done;
      const rows = stepRowsOf(failed.started.caseRunId);
      expect(rows.map((r) => r.status)).toEqual(["pass", "pass", "pass", "fail"]);
      expect(rows[3]?.error).toContain(`${site.baseUrl}/products`);
    },
    TEST_TIMEOUT,
  );

  it(
    "fails on title drift and keeps Playwright's call log in the step error",
    async () => {
      const caseId = seedCase("Title drift", [
        { order: 0, action: "goto", value: `${site.baseUrl}/products`, timeoutMs: STEP_TIMEOUT },
        { order: 1, action: "assert-title", value: "Products", timeoutMs: FAIL_STEP_TIMEOUT },
        { order: 2, action: "assert-title", value: "Products page", timeoutMs: FAIL_STEP_TIMEOUT },
      ]);
      const { started } = startRun(caseId);
      await started.done;

      const rows = stepRowsOf(started.caseRunId);
      // The exact title passes; the drifted one fails.
      expect(rows.map((r) => r.status)).toEqual(["pass", "pass", "fail"]);
      // Playwright's full detail survives into the stored error.
      expect(rows[2]?.error).toContain("toHaveTitle");
      expect(rows[2]?.error).toContain("Call log:");
    },
    TEST_TIMEOUT,
  );

  it(
    "writes trace.zip at a supervised failure before pausing",
    async () => {
      const caseId = seedCase("Supervised failure", [
        { order: 0, action: "goto", value: `${site.baseUrl}/`, timeoutMs: STEP_TIMEOUT },
        {
          order: 1,
          action: "assert-text",
          selector: "h1",
          value: "zzz-no-such-text-zzz",
          timeoutMs: FAIL_STEP_TIMEOUT,
        },
      ]);
      const { runner, started } = startRun(caseId, "supervised");
      await started.done;

      const rows = stepRowsOf(started.caseRunId);
      expect(rows.map((r) => r.status)).toEqual(["pass", "fail"]);
      // Paused: the live session (and its browser context) stays open, so the
      // failed run never reports a finished event.
      expect(runner.hasActiveSession()).toBe(true);
      const finished = events.filter(
        (e) =>
          e.channel === "run:finished" &&
          (e.payload as { suiteRunId: string }).suiteRunId === started.suiteRunId,
      );
      expect(finished).toHaveLength(0);

      // The failure evidence is on disk the moment the run pauses, so a later
      // edit-and-resume cannot lose it.
      const tracePath = caseTracePath(artifactsRoot, projectId, started.suiteRunId, caseId);
      expect(tracePath.endsWith("trace.zip")).toBe(true);
      expect(existsSync(tracePath)).toBe(true);

      // Settle the paused session so the browser does not leak.
      await runner.cancelRun({ suiteRunId: started.suiteRunId });
      expect(runner.hasActiveSession()).toBe(false);
    },
    TEST_TIMEOUT,
  );
});
