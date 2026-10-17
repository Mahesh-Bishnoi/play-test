import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import type { EmitRunEvent } from "../src/main/runner.js";
import { SingleCaseRunner, playwrightLauncher } from "../src/main/runner.js";
import { createDatabase } from "../src/main/db.js";
import type { AppDatabase } from "../src/main/db.js";
import { createCase } from "../src/main/ipc-cases.js";
import { authStateDir, setCaseProfile } from "../src/main/ipc-profiles.js";
import { createProject } from "../src/main/ipc-projects.js";
import { upsertStep } from "../src/main/ipc-steps.js";
import { caseRuns, stepRuns } from "../src/main/schema.js";
import type { TestStep } from "../src/shared/step-types.js";
import type { TestSite } from "./fixtures/test-site.js";
import { startTestSite } from "./fixtures/test-site.js";

/**
 * End-to-end validation of the M17 additions (real Chromium, local fixture
 * site, hermetic). Opt-in like the other e2e legs:
 *
 *   PLAYTEST_E2E=1 npx vitest run tests/e2e-wait-url.test.ts
 *
 * Covers: `wait-url` settling a click-triggered navigation via a glob, the
 * `scroll-into-view` step reaching the bottom of a tall page, and a profile
 * `sessionState` file seeding `sessionStorage` before the first script runs.
 */
const describeE2E = describe.skipIf(!process.env.PLAYTEST_E2E);

/** Generous budget for a step that is expected to pass. */
const STEP_TIMEOUT = 20_000;
/** Each test launches a real browser and may burn one assertion timeout. */
const TEST_TIMEOUT = 120_000;

describeE2E("e2e: wait-url, scroll-into-view and sessionState (M17)", () => {
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
    artifactsRoot = mkdtempSync(join(tmpdir(), "e2e-wait-url-"));
    const handle = createDatabase(":memory:");
    db = handle.db;
    closeDb = handle.close;
    projectId = createProject(db, { name: "M17", baseUrl: site.baseUrl }).id;
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

  function startRun(caseId: string) {
    const runner = new SingleCaseRunner(db, {
      launchBrowser: playwrightLauncher(),
      emit,
      artifactsRoot,
    });
    return { runner, started: runner.runSingle({ caseId, mode: "unsupervised" }) };
  }

  function stepRowsOf(caseRunId: string) {
    return db
      .select()
      .from(stepRuns)
      .where(eq(stepRuns.caseRunId, caseRunId))
      .all()
      .sort((a, b) => a.order - b.order);
  }

  function caseRowOf(caseRunId: string) {
    return db.select().from(caseRuns).where(eq(caseRuns.id, caseRunId)).all()[0];
  }

  it(
    "waits for the click's navigation with a URL glob, then scrolls a tall page into view",
    async () => {
      const caseId = seedCase("Nav glob + scroll", [
        { order: 0, action: "goto", value: site.baseUrl, timeoutMs: STEP_TIMEOUT },
        { order: 1, action: "click", selector: "a.cta", timeoutMs: STEP_TIMEOUT },
        { order: 2, action: "wait-url", value: "**/form", timeoutMs: STEP_TIMEOUT },
        {
          order: 3,
          action: "assert-text",
          selector: "h1",
          value: "Order form",
          timeoutMs: STEP_TIMEOUT,
        },
        { order: 4, action: "goto", value: `${site.baseUrl}/session`, timeoutMs: STEP_TIMEOUT },
        { order: 5, action: "scroll-into-view", selector: "#footer", timeoutMs: STEP_TIMEOUT },
      ]);

      const run = startRun(caseId);
      await run.started.done;

      const rows = stepRowsOf(run.started.caseRunId);
      expect(rows.map((r) => r.status)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass"]);
      expect(caseRowOf(run.started.caseRunId)?.status).toBe("passed");
    },
    TEST_TIMEOUT,
  );

  it(
    "seeds sessionStorage from the profile's sessionState file (and leaves it empty otherwise)",
    async () => {
      const authDir = authStateDir(artifactsRoot, projectId);
      mkdirSync(authDir, { recursive: true });
      writeFileSync(join(authDir, "session.json"), JSON.stringify({ token: "seeded-token" }));

      const seeded = seedCase("Session seed", [
        { order: 0, action: "goto", value: `${site.baseUrl}/session`, timeoutMs: STEP_TIMEOUT },
        {
          order: 1,
          action: "assert-text",
          selector: "#sess",
          value: "seeded-token",
          timeoutMs: STEP_TIMEOUT,
        },
      ]);
      setCaseProfile(db, seeded, { sessionState: "session.json" });
      const seededRun = startRun(seeded);
      await seededRun.started.done;
      expect(stepRowsOf(seededRun.started.caseRunId).map((r) => r.status)).toEqual([
        "pass",
        "pass",
      ]);

      // Same page, no profile: the page reports an empty sessionStorage.
      const control = seedCase("Session control", [
        { order: 0, action: "goto", value: `${site.baseUrl}/session`, timeoutMs: STEP_TIMEOUT },
        {
          order: 1,
          action: "assert-text",
          selector: "#sess",
          value: "none",
          timeoutMs: STEP_TIMEOUT,
        },
      ]);
      const controlRun = startRun(control);
      await controlRun.started.done;
      expect(stepRowsOf(controlRun.started.caseRunId).map((r) => r.status)).toEqual([
        "pass",
        "pass",
      ]);
    },
    TEST_TIMEOUT,
  );
});
