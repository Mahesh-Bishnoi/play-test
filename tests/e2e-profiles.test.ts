import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { devices } from "playwright";
import { eq } from "drizzle-orm";

import type { EmitRunEvent } from "../src/main/runner/seams.js";
import { SingleCaseRunner } from "../src/main/runner/single-runner.js";
import { playwrightLauncher } from "../src/main/runner/launcher.js";
import { stepScreenshotPath } from "../src/main/artifacts.js";
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
 * End-to-end validation of the M14 case profile applied at run time (real
 * Chromium, local fixture site, hermetic). Opt-in like the other e2e legs:
 *
 *   PLAYTEST_E2E=1 npx vitest run tests/e2e-profiles.test.ts
 *
 * Covers: the profile's `storageState` being loaded into the context (a
 * cookie-gated page only passes with it), and a device profile changing the
 * run viewport (and therefore the screenshot dimensions).
 */
const describeE2E = describe.skipIf(!process.env.PLAYTEST_E2E);

/** Generous budget for a step that is expected to pass. */
const STEP_TIMEOUT = 20_000;
/** Short budget so an intentional failure settles fast. */
const FAIL_STEP_TIMEOUT = 3_000;
/** Each test launches a real browser and may burn one assertion timeout. */
const TEST_TIMEOUT = 120_000;

/** Read a PNG's dimensions from its IHDR chunk (no image dependency). */
function pngSize(path: string): { width: number; height: number } {
  const buf = readFileSync(path);
  // 8-byte signature, 4-byte chunk length, "IHDR", then width/height (BE u32).
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Playwright storageState storing a `session=ok` cookie for the fixture host. */
function storageStateFor(baseUrl: string): string {
  const host = new URL(baseUrl).hostname;
  return JSON.stringify({
    cookies: [
      {
        name: "session",
        value: "ok",
        domain: host,
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ],
    origins: [],
  });
}

describeE2E("e2e: case profiles at run time (M14)", () => {
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
    artifactsRoot = mkdtempSync(join(tmpdir(), "e2e-profiles-"));
    const handle = createDatabase(":memory:");
    db = handle.db;
    closeDb = handle.close;
    projectId = createProject(db, { name: "Profiles", baseUrl: site.baseUrl }).id;
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

  const gatedSteps = (assertTimeout: number): TestStep[] => [
    { order: 0, action: "goto", value: `${site.baseUrl}/secure`, timeoutMs: STEP_TIMEOUT },
    {
      order: 1,
      action: "assert-text",
      selector: "#welcome",
      value: "Welcome back",
      timeoutMs: assertTimeout,
    },
  ];

  it(
    "loads the profile's storageState so a cookie-gated page passes (and fails without it)",
    async () => {
      const authDir = authStateDir(artifactsRoot, projectId);
      mkdirSync(authDir, { recursive: true });
      writeFileSync(join(authDir, "login.json"), storageStateFor(site.baseUrl));

      const withState = seedCase("Gated (with state)", gatedSteps(STEP_TIMEOUT));
      setCaseProfile(db, withState, { storageState: "login.json" });
      const authed = startRun(withState);
      await authed.started.done;
      expect(stepRowsOf(authed.started.caseRunId).map((r) => r.status)).toEqual(["pass", "pass"]);
      expect(caseRowOf(authed.started.caseRunId)?.status).toBe("passed");

      // Same flow, no profile: the gate renders the sign-in page instead.
      const anonymous = seedCase("Gated (anonymous)", gatedSteps(FAIL_STEP_TIMEOUT));
      const anon = startRun(anonymous);
      await anon.started.done;
      const rows = stepRowsOf(anon.started.caseRunId);
      expect(rows.map((r) => r.status)).toEqual(["pass", "fail"]);
      expect(rows[1]?.error).toContain("toContainText");
      expect(caseRowOf(anon.started.caseRunId)?.status).toBe("failed");
    },
    TEST_TIMEOUT,
  );

  it(
    "applies a device profile to the run (screenshot dimensions change)",
    async () => {
      const control = seedCase("Control viewport", [
        { order: 0, action: "goto", value: `${site.baseUrl}/`, timeoutMs: STEP_TIMEOUT },
      ]);
      const controlRun = startRun(control);
      await controlRun.started.done;
      const controlShot = stepScreenshotPath(
        artifactsRoot,
        projectId,
        controlRun.started.suiteRunId,
        control,
        0,
      );
      expect(pngSize(controlShot)).toEqual({ width: 1280, height: 720 });

      const deviceCase = seedCase("IPhone viewport", [
        { order: 0, action: "goto", value: `${site.baseUrl}/`, timeoutMs: STEP_TIMEOUT },
      ]);
      setCaseProfile(db, deviceCase, { device: "iPhone 11" });
      const deviceRun = startRun(deviceCase);
      await deviceRun.started.done;
      const deviceShot = stepScreenshotPath(
        artifactsRoot,
        projectId,
        deviceRun.started.suiteRunId,
        deviceCase,
        0,
      );

      const descriptor = devices["iPhone 11"]!;
      const cssSize = {
        width: descriptor.viewport.width,
        height: descriptor.viewport.height,
      };
      const devicePixelSize = {
        width: Math.round(descriptor.viewport.width * descriptor.deviceScaleFactor),
        height: Math.round(descriptor.viewport.height * descriptor.deviceScaleFactor),
      };
      // Accept either screenshot scale; the point is that the device preset —
      // not the 1280x720 default — drove the context.
      expect([cssSize, devicePixelSize]).toContainEqual(pngSize(deviceShot));
      expect(pngSize(deviceShot)).not.toEqual({ width: 1280, height: 720 });
    },
    TEST_TIMEOUT,
  );
});
