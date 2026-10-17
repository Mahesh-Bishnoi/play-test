import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import type { EmitRunEvent } from "../src/main/runner.js";
import { SingleCaseRunner, playwrightLauncher } from "../src/main/runner.js";
import { createDatabase } from "../src/main/db.js";
import type { AppDatabase } from "../src/main/db.js";
import { createCase } from "../src/main/ipc-cases.js";
import { createProject } from "../src/main/ipc-projects.js";
import { upsertStep } from "../src/main/ipc-steps.js";
import { stepRuns } from "../src/main/schema.js";
import type { TestStep } from "../src/shared/step-types.js";
import type { TestSite } from "./fixtures/test-site.js";
import { startTestSite } from "./fixtures/test-site.js";

/**
 * End-to-end validation of the M16 runtime parity tokens against real
 * Chromium (local fixture site, hermetic). Opt-in like the other e2e legs:
 *
 *   PLAYTEST_E2E=1 npx vitest run tests/e2e-popup-download.test.ts
 *
 * Covers: `click` value `popup` adopting the tab opened by `target=_blank`
 * for subsequent steps, and `click` value `download` saving the attachment
 * under `<caseDir>/downloads/`.
 */
const describeE2E = describe.skipIf(!process.env.PLAYTEST_E2E);

/** Generous budget for a step that is expected to pass. */
const STEP_TIMEOUT = 20_000;
/** Each test launches a real browser and may wait out a popup/download. */
const TEST_TIMEOUT = 120_000;

describeE2E("e2e: popup adoption and download capture (M16)", () => {
  let site: TestSite;
  let artifactsRoot: string;
  let db: AppDatabase;
  let closeDb: () => void;
  let projectId: string;
  const emit: EmitRunEvent = () => {};

  beforeAll(async () => {
    site = await startTestSite();
    artifactsRoot = mkdtempSync(join(tmpdir(), "e2e-popup-download-"));
    const handle = createDatabase(":memory:");
    db = handle.db;
    closeDb = handle.close;
    projectId = createProject(db, { name: "Popup download", baseUrl: site.baseUrl }).id;
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
    return runner.runSingle({ caseId, mode: "unsupervised" });
  }

  function stepRowsOf(caseRunId: string) {
    return db.select().from(stepRuns).where(eq(stepRuns.caseRunId, caseRunId)).all();
  }

  it(
    "adopts the tab opened by a popup click for subsequent steps",
    async () => {
      const caseId = seedCase("Popup", [
        { order: 0, action: "goto", value: `${site.baseUrl}/`, timeoutMs: STEP_TIMEOUT },
        {
          order: 1,
          action: "click",
          selector: "#open-tab",
          value: "popup",
          timeoutMs: STEP_TIMEOUT,
        },
        // `#name` only exists on `/form`, so both assertions prove the runner
        // is driving the newly opened tab rather than the original home page.
        { order: 2, action: "assert-visible", selector: "#name", timeoutMs: STEP_TIMEOUT },
        { order: 3, action: "assert-url", value: "/\\/form$/", timeoutMs: STEP_TIMEOUT },
      ]);
      const started = startRun(caseId);
      await started.done;

      expect(stepRowsOf(started.caseRunId).map((r) => r.status)).toEqual([
        "pass",
        "pass",
        "pass",
        "pass",
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    "saves the file started by a download click under <caseDir>/downloads/",
    async () => {
      const caseId = seedCase("Download", [
        { order: 0, action: "goto", value: `${site.baseUrl}/`, timeoutMs: STEP_TIMEOUT },
        {
          order: 1,
          action: "click",
          selector: "#download-link",
          value: "download",
          timeoutMs: STEP_TIMEOUT,
        },
      ]);
      const started = startRun(caseId);
      await started.done;

      expect(stepRowsOf(started.caseRunId).map((r) => r.status)).toEqual(["pass", "pass"]);

      // The whole tree is unknown (project/suiteRun/case ids), so search for the
      // filename rather than reconstructing the path from the run id.
      const entries = readdirSync(artifactsRoot, { recursive: true, encoding: "utf8" });
      const downloaded = entries.find((entry) => entry.endsWith(join("downloads", "report.txt")));
      if (downloaded === undefined) {
        throw new Error(
          `no downloads/report.txt under ${artifactsRoot}: ${entries.join(", ") || "<empty>"}`,
        );
      }
      expect(readFileSync(join(artifactsRoot, downloaded), "utf8")).toBe("report-body");
    },
    TEST_TIMEOUT,
  );
});
