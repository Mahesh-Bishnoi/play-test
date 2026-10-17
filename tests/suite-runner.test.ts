import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import type { BrowserLauncher, RunContext, RunPage } from "../src/main/runner.js";
import type { RunEventChannel } from "../src/main/runner.js";
import { RunAlreadyActiveError, SingleCaseRunner } from "../src/main/runner.js";
import {
  NoFailedCasesError,
  SuiteRunner,
  defaultWorkerCount,
  selectLastFailedCaseIds,
} from "../src/main/suite-runner.js";
import { registerReportHandlers, registerRunnerHandlers } from "../src/main/ipc-register.js";
import type { IpcHandleFn } from "../src/main/ipc-register.js";
import { createDatabase } from "../src/main/db.js";
import type { AppDatabase, DatabaseHandle } from "../src/main/db.js";
import { createCase } from "../src/main/ipc-cases.js";
import { createProject } from "../src/main/ipc-projects.js";
import { setTestData, upsertStep } from "../src/main/ipc-steps.js";
import { createSuite, setSuiteCases } from "../src/main/ipc-suites.js";
import { caseRuns, stepRuns, suiteRuns } from "../src/main/schema.js";

// --- Fakes (mirror tests/runner.test.ts; suite-local so files stay independent) --

type StepDef = { action: "goto" | "click" | "fill" | "wait"; selector?: string; value?: string };

class FakePage implements RunPage {
  calls: string[] = [];
  gate: Promise<void> | null = null;
  failClicks = false;
  private gated = false;

  private async enter(method: string): Promise<void> {
    this.calls.push(method);
    if (this.gate !== null && !this.gated) {
      this.gated = true;
      await this.gate;
    }
    if (this.failClicks && method === "click") {
      throw new Error("locator('#go'): element is not visible");
    }
  }

  async goto(): Promise<void> {
    await this.enter("goto");
  }
  async click(): Promise<void> {
    await this.enter("click");
  }
  async dblclick(): Promise<void> {
    await this.enter("dblclick");
  }
  async fill(): Promise<void> {
    await this.enter("fill");
  }
  async type(): Promise<void> {
    await this.enter("type");
  }
  async selectOption(): Promise<void> {
    await this.enter("selectOption");
  }
  async check(): Promise<void> {
    await this.enter("check");
  }
  async uncheck(): Promise<void> {
    await this.enter("uncheck");
  }
  async hover(): Promise<void> {
    await this.enter("hover");
  }
  async focus(): Promise<void> {
    await this.enter("focus");
  }
  async press(): Promise<void> {
    await this.enter("press");
  }
  async assertVisible(): Promise<void> {
    await this.enter("assertVisible");
  }
  async assertHidden(): Promise<void> {
    await this.enter("assertHidden");
  }
  async assertText(): Promise<void> {
    await this.enter("assertText");
  }
  async assertValue(): Promise<void> {
    await this.enter("assertValue");
  }
  async assertChecked(): Promise<void> {
    await this.enter("assertChecked");
  }
  async assertUnchecked(): Promise<void> {
    await this.enter("assertUnchecked");
  }
  async assertEnabled(): Promise<void> {
    await this.enter("assertEnabled");
  }
  async assertDisabled(): Promise<void> {
    await this.enter("assertDisabled");
  }
  async assertEditable(): Promise<void> {
    await this.enter("assertEditable");
  }
  async assertFocused(): Promise<void> {
    await this.enter("assertFocused");
  }
  async assertCount(): Promise<void> {
    await this.enter("assertCount");
  }
  async assertUrl(): Promise<void> {
    await this.enter("assertUrl");
  }
  async assertTitle(): Promise<void> {
    await this.enter("assertTitle");
  }
  async waitForTimeout(): Promise<void> {
    await this.enter("waitForTimeout");
  }
  async screenshot(path: string): Promise<void> {
    await this.enter("screenshot");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "fake-png");
  }
}

class FakeContext implements RunContext {
  page: FakePage = new FakePage();
  closed = false;
  tracePath: string | null = null;
  videoFile: string | null = null;

  async close(): Promise<void> {
    this.closed = true;
  }
  async recordedVideoPath(): Promise<string | null> {
    return this.videoFile;
  }
  async saveTrace(path: string | null): Promise<void> {
    this.tracePath = path;
  }
}

class FakeLauncher implements BrowserLauncher {
  contexts: FakeContext[] = [];
  launchFail: string | null = null;
  /** Applied to the first launched context only (deterministic gating). */
  gateFirst: Promise<void> | null = null;
  failClicks = false;
  private primed = 0;

  async launch(_headless: boolean, videoDir: string): Promise<RunContext> {
    if (this.launchFail !== null) {
      throw new Error(this.launchFail);
    }
    const context = new FakeContext();
    if (this.contexts.length === 0 && this.gateFirst !== null) {
      context.page.gate = this.gateFirst;
    }
    context.page.failClicks = this.failClicks;
    this.contexts.push(context);
    void videoDir;
    return context;
  }

  primeVideo(root: string): string {
    // Own counter, not contexts.length: parallel launches all push before
    // primed names resolve, so length-based names collide across contexts.
    const path = join(root, `raw-${this.primed}.webm`);
    this.primed += 1;
    mkdirSync(root, { recursive: true });
    writeFileSync(path, "fake-video");
    return path;
  }
}

interface Fixture {
  dbHandle: DatabaseHandle;
  db: AppDatabase;
  launcher: FakeLauncher;
  events: { channel: RunEventChannel; payload: unknown }[];
  suite: SuiteRunner;
  root: string;
  projectId: string;
  suiteId: string;
  caseIds: string[];
  caseRunIdsOf: (suiteRunId: string) => { caseId: string; caseRunId: string; status: string }[];
}

function mkRoot(): string {
  const root = join(
    tmpdir(),
    `playtest-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  return root;
}

function makeFixture(
  cases: { steps: StepDef[]; data?: Record<string, string>; video?: boolean }[],
  opts?: {
    workerCount?: (n: number) => number;
    isSingleActive?: () => boolean;
    now?: () => number;
  },
): Fixture {
  const dbHandle = createDatabase(":memory:");
  const root = mkRoot();
  const launcher = new FakeLauncher();
  const events: Fixture["events"] = [];
  const suite = new SuiteRunner(dbHandle.db, {
    launchBrowser: launcher,
    emit: (channel, payload) => {
      events.push({ channel, payload });
    },
    artifactsRoot: root,
    workerCount: opts?.workerCount,
    isSingleActive: opts?.isSingleActive,
    now: opts?.now,
  });
  const project = createProject(dbHandle.db, { name: "P" });
  const suiteRow = createSuite(dbHandle.db, { projectId: project.id, name: "S" });
  const caseIds = cases.map((c, i) => {
    const testCase = createCase(dbHandle.db, { projectId: project.id, name: `C${i}` });
    c.steps.forEach((step, order) => {
      upsertStep(dbHandle.db, { caseId: testCase.id, step: { order, ...step } });
    });
    if (c.data !== undefined) {
      setTestData(dbHandle.db, { caseId: testCase.id, data: c.data });
    }
    if (c.video === true) {
      launcher.primeVideo(root);
    }
    return testCase.id;
  });
  setSuiteCases(dbHandle.db, suiteRow.id, caseIds);
  return {
    dbHandle,
    db: dbHandle.db,
    launcher,
    events,
    suite,
    root,
    projectId: project.id,
    suiteId: suiteRow.id,
    caseIds,
    caseRunIdsOf: (suiteRunId: string) =>
      dbHandle.db
        .select({ caseId: caseRuns.caseId, caseRunId: caseRuns.id, status: caseRuns.status })
        .from(caseRuns)
        .where(eq(caseRuns.suiteRunId, suiteRunId))
        .all(),
  };
}

let openHandles: DatabaseHandle[] = [];
afterEach(() => {
  for (const handle of openHandles) {
    handle.close();
  }
  openHandles = [];
});

function track(fx: Fixture): Fixture {
  openHandles.push(fx.dbHandle);
  return fx;
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

function finishedSummary(fx: Fixture, suiteRunId: string): unknown {
  const found = fx.events.filter(
    (e) =>
      e.channel === "run:finished" &&
      (e.payload as { suiteRunId: string }).suiteRunId === suiteRunId,
  );
  expect(found).toHaveLength(1);
  const finished = found[0];
  if (!finished) throw new Error("run:finished event missing");
  return (finished.payload as { summary: unknown }).summary;
}

// --- Parallel execution ---------------------------------------------------------

describe("runSuite (M6)", () => {
  it("passes two cases in parallel, headless, with a report on disk", async () => {
    const fx = track(
      makeFixture(
        [
          {
            steps: [
              { action: "goto", value: "https://x.test" },
              { action: "click", selector: "#go" },
            ],
          },
          { steps: [{ action: "goto", value: "https://y.test" }] },
        ],
        { workerCount: () => 2 },
      ),
    );
    const started = fx.suite.runSuite({
      suiteId: fx.suiteId,
      caseIds: fx.caseIds,
      mode: "unsupervised",
    });
    await started.done;

    expect(finishedSummary(fx, started.suiteRunId)).toEqual({
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
    });
    expect(fx.launcher.contexts).toHaveLength(2);
    expect(fx.launcher.contexts.every((c) => c.closed)).toBe(true);
    const rows = fx.caseRunIdsOf(started.suiteRunId);
    expect(rows.map((r) => r.status).sort()).toEqual(["passed", "passed"]);
    // Screenshots exist for every executed step of both cases.
    for (const row of fx.db.select().from(stepRuns).all()) {
      if (row.status !== "skipped") {
        expect(existsSync(row.screenshotPath ?? "")).toBe(true);
      }
    }
    // Step events carry distinct caseRunIds so the UI can split the streams.
    const updates = fx.events.filter((e) => e.channel === "run:step-update");
    expect(new Set(updates.map((e) => (e.payload as { caseRunId: string }).caseRunId)).size).toBe(
      2,
    );
    const suiteRow = fx.db
      .select()
      .from(suiteRuns)
      .where(eq(suiteRuns.id, started.suiteRunId))
      .all()[0];
    expect(suiteRow?.status).toBe("passed");
    expect(suiteRow?.reportHtmlPath?.endsWith("report.html")).toBe(true);
    expect(existsSync(suiteRow?.reportHtmlPath ?? "")).toBe(true);
  });

  it("overlaps cases with 2 workers but serializes with 1", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const fx = track(
        makeFixture(
          [
            { steps: [{ action: "goto", value: "https://a.test" }] },
            { steps: [{ action: "goto", value: "https://b.test" }] },
          ],
          { workerCount: () => 2 },
        ),
      );
      fx.launcher.gateFirst = gate;
      const started = fx.suite.runSuite({
        suiteId: fx.suiteId,
        caseIds: fx.caseIds,
        mode: "unsupervised",
      });
      // The ungated case settles while the gated one is still blocked → parallel.
      await waitFor(
        () =>
          fx
            .caseRunIdsOf(started.suiteRunId)
            .some((r) => r.caseId === fx.caseIds[1] && r.status === "passed"),
        "second case to pass while first is gated",
      );
      expect(fx.launcher.contexts).toHaveLength(2);
      release();
      await started.done;
      expect(finishedSummary(fx, started.suiteRunId)).toEqual({
        total: 2,
        passed: 2,
        failed: 0,
        skipped: 0,
      });
    } finally {
      release();
    }
  });

  it("runs serially with a single worker", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const fx = track(
        makeFixture(
          [
            { steps: [{ action: "goto", value: "https://a.test" }] },
            { steps: [{ action: "goto", value: "https://b.test" }] },
          ],
          { workerCount: () => 1 },
        ),
      );
      fx.launcher.gateFirst = gate;
      const started = fx.suite.runSuite({
        suiteId: fx.suiteId,
        caseIds: fx.caseIds,
        mode: "unsupervised",
      });
      await waitFor(() => fx.launcher.contexts.length === 1, "first context to launch");
      await new Promise((r) => setTimeout(r, 50));
      // Single worker: the second browser never launches while the first is gated.
      expect(fx.launcher.contexts).toHaveLength(1);
      release();
      await started.done;
      expect(finishedSummary(fx, started.suiteRunId)).toEqual({
        total: 2,
        passed: 2,
        failed: 0,
        skipped: 0,
      });
    } finally {
      release();
    }
  });

  it("isolates failures: failed case keeps video+trace, others pass", async () => {
    const fx = track(
      makeFixture([
        {
          steps: [
            { action: "goto", value: "https://x.test" },
            { action: "click", selector: "#go" },
            { action: "click", selector: "#next" },
          ],
        },
        { steps: [{ action: "goto", value: "https://y.test" }] },
      ]),
    );
    fx.launcher.failClicks = true;
    const originalLaunch = fx.launcher.launch.bind(fx.launcher);
    fx.launcher.launch = async (headless, videoDir) => {
      const context = (await originalLaunch(headless, videoDir)) as FakeContext;
      // One recording per context (like production) — parallel cases must
      // not share a raw file: the passer's discard would unlink it before
      // the failer's retain (renameSync) runs.
      context.videoFile = fx.launcher.primeVideo(fx.root);
      return context;
    };
    const started = fx.suite.runSuite({
      suiteId: fx.suiteId,
      caseIds: fx.caseIds,
      mode: "unsupervised",
    });
    await started.done;

    expect(finishedSummary(fx, started.suiteRunId)).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
    });
    const rows = fx.caseRunIdsOf(started.suiteRunId);
    const failed = rows.find((r) => r.caseId === fx.caseIds[0]);
    const passed = rows.find((r) => r.caseId === fx.caseIds[1]);
    expect(failed?.status).toBe("failed");
    expect(passed?.status).toBe("passed");
    const failedCase = fx.db
      .select()
      .from(caseRuns)
      .where(eq(caseRuns.id, failed?.caseRunId ?? ""))
      .all()[0];
    expect(failedCase?.videoPath?.endsWith("failed.webm")).toBe(true);
    expect(existsSync(failedCase?.videoPath ?? "")).toBe(true);
    const failedSteps = fx.db
      .select()
      .from(stepRuns)
      .where(eq(stepRuns.caseRunId, failed?.caseRunId ?? ""))
      .all()
      .sort((a, b) => a.order - b.order);
    expect(failedSteps.map((s) => s.status)).toEqual(["pass", "fail", "skipped"]);
    expect(failedSteps[2]?.screenshotPath).toBeNull();
    const passedCase = fx.db
      .select()
      .from(caseRuns)
      .where(eq(caseRuns.id, passed?.caseRunId ?? ""))
      .all()[0];
    expect(passedCase?.videoPath).toBeNull();
  });

  it("fails fast without launching when a test-data key is missing", async () => {
    const fx = track(
      makeFixture([{ steps: [{ action: "goto", value: "https://{{host}}/login" }] }]),
    );
    const started = fx.suite.runSuite({
      suiteId: fx.suiteId,
      caseIds: fx.caseIds,
      mode: "unsupervised",
    });
    await started.done;
    expect(fx.launcher.contexts).toHaveLength(0);
    expect(finishedSummary(fx, started.suiteRunId)).toEqual({
      total: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
    });
  });

  it("passes an empty case without launching a browser", async () => {
    const fx = track(makeFixture([{ steps: [] }]));
    const started = fx.suite.runSuite({
      suiteId: fx.suiteId,
      caseIds: fx.caseIds,
      mode: "unsupervised",
    });
    await started.done;
    expect(fx.launcher.contexts).toHaveLength(0);
    expect(finishedSummary(fx, started.suiteRunId)).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
  });

  it("marks the case failed when the browser cannot launch", async () => {
    const fx = track(makeFixture([{ steps: [{ action: "click", selector: "#a" }] }]));
    fx.launcher.launchFail = "chromium missing";
    const started = fx.suite.runSuite({
      suiteId: fx.suiteId,
      caseIds: fx.caseIds,
      mode: "unsupervised",
    });
    await started.done;
    expect(finishedSummary(fx, started.suiteRunId)).toEqual({
      total: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
    });
    expect(
      fx.events.some(
        (e) => e.channel === "run:log" && JSON.stringify(e.payload).includes("chromium missing"),
      ),
    ).toBe(true);
  });

  it("rejects unknown suites/cases and invalid payloads before touching the db", () => {
    const fx = track(makeFixture([{ steps: [{ action: "click", selector: "#a" }] }]));
    expect(() =>
      fx.suite.runSuite({ suiteId: "ghost", caseIds: fx.caseIds, mode: "unsupervised" }),
    ).toThrow(/suite not found/);
    expect(() =>
      fx.suite.runSuite({ suiteId: fx.suiteId, caseIds: ["ghost"], mode: "unsupervised" }),
    ).toThrow(/case not found/);
    expect(() =>
      fx.suite.runSuite({ suiteId: fx.suiteId, caseIds: [], mode: "unsupervised" }),
    ).toThrow();
    expect(() =>
      fx.suite.runSuite({
        suiteId: fx.suiteId,
        caseIds: fx.caseIds,
        mode: "supervised" as "unsupervised",
      }),
    ).toThrow();
    expect(fx.db.select().from(suiteRuns).all()).toHaveLength(0);
  });

  it("rejects a second run while one is active, and yields to a live single run", () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const fx = track(makeFixture([{ steps: [{ action: "goto", value: "https://a.test" }] }]));
      fx.launcher.gateFirst = gate;
      const started = fx.suite.runSuite({
        suiteId: fx.suiteId,
        caseIds: fx.caseIds,
        mode: "unsupervised",
      });
      expect(() =>
        fx.suite.runSuite({ suiteId: fx.suiteId, caseIds: fx.caseIds, mode: "unsupervised" }),
      ).toThrow(RunAlreadyActiveError);
      release();
      return started.done;
    } finally {
      release();
    }
  });

  it("refuses to start while a single-case run is live", () => {
    const fx = track(
      makeFixture([{ steps: [{ action: "click", selector: "#a" }] }], {
        isSingleActive: () => true,
      }),
    );
    expect(() =>
      fx.suite.runSuite({ suiteId: fx.suiteId, caseIds: fx.caseIds, mode: "unsupervised" }),
    ).toThrow(RunAlreadyActiveError);
  });

  it("single runs refuse to start while a suite owns the browsers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const dbHandle = createDatabase(":memory:");
      openHandles.push(dbHandle);
      const root = mkRoot();
      const launcher = new FakeLauncher();
      launcher.gateFirst = gate;
      const events: Fixture["events"] = [];
      const emit = (channel: RunEventChannel, payload: unknown): void => {
        events.push({ channel, payload });
      };
      const single = new SingleCaseRunner(dbHandle.db, {
        launchBrowser: launcher,
        emit,
        artifactsRoot: root,
        isSuiteActive: () => suite.hasActiveRun(),
      });
      const suite = new SuiteRunner(dbHandle.db, {
        launchBrowser: launcher,
        emit,
        artifactsRoot: root,
      });
      const project = createProject(dbHandle.db, { name: "P" });
      const testCase = createCase(dbHandle.db, { projectId: project.id, name: "C" });
      upsertStep(dbHandle.db, {
        caseId: testCase.id,
        step: { order: 0, action: "goto", value: "https://x.test" },
      });
      const suiteRow = createSuite(dbHandle.db, { projectId: project.id, name: "S" });
      setSuiteCases(dbHandle.db, suiteRow.id, [testCase.id]);
      const started = suite.runSuite({
        suiteId: suiteRow.id,
        caseIds: [testCase.id],
        mode: "unsupervised",
      });
      await waitFor(() => launcher.contexts.length === 1, "suite to launch");
      expect(() => single.runSingle({ caseId: testCase.id, mode: "supervised" })).toThrow(
        RunAlreadyActiveError,
      );
      release();
      await started.done;
    } finally {
      release();
    }
  });
});

// --- Cancel ---------------------------------------------------------------------

describe("cancelRun (suite)", () => {
  it("cancels a gated run: case cancelled, suite cancelled, skipped bucket", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const fx = track(
        makeFixture(
          [
            {
              steps: [
                { action: "goto", value: "https://a.test" },
                { action: "click", selector: "#a" },
              ],
            },
          ],
          { workerCount: () => 1 },
        ),
      );
      fx.launcher.gateFirst = gate;
      const started = fx.suite.runSuite({
        suiteId: fx.suiteId,
        caseIds: fx.caseIds,
        mode: "unsupervised",
      });
      await waitFor(() => fx.launcher.contexts.length === 1, "case to launch");
      await fx.suite.cancelRun({ suiteRunId: started.suiteRunId });
      release();
      await started.done;
      expect(fx.caseRunIdsOf(started.suiteRunId).map((r) => r.status)).toEqual(["cancelled"]);
      expect(finishedSummary(fx, started.suiteRunId)).toEqual({
        total: 1,
        passed: 0,
        failed: 0,
        skipped: 1,
      });
      const suiteRow = fx.db
        .select()
        .from(suiteRuns)
        .where(eq(suiteRuns.id, started.suiteRunId))
        .all()[0];
      expect(suiteRow?.status).toBe("cancelled");
    } finally {
      release();
    }
  });

  it("is a no-op for unknown suite runs", async () => {
    const fx = track(makeFixture([{ steps: [{ action: "click", selector: "#a" }] }]));
    await expect(fx.suite.cancelRun({ suiteRunId: "ghost" })).resolves.toBeNull();
  });
});

// --- Rerun failed -----------------------------------------------------------------

describe("rerunFailed (M6)", () => {
  it("retries only failed cases as a new suite run", async () => {
    const fx = track(
      makeFixture(
        [
          {
            steps: [
              { action: "goto", value: "https://x.test" },
              { action: "click", selector: "#go" },
            ],
          },
          { steps: [{ action: "goto", value: "https://y.test" }] },
        ],
        { workerCount: () => 2 },
      ),
    );
    fx.launcher.failClicks = true;
    const first = fx.suite.runSuite({
      suiteId: fx.suiteId,
      caseIds: fx.caseIds,
      mode: "unsupervised",
    });
    await first.done;
    expect(finishedSummary(fx, first.suiteRunId)).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
    });

    fx.launcher.failClicks = false;
    const retry = fx.suite.rerunFailed({ suiteRunId: first.suiteRunId });
    await retry.done;
    expect(retry.suiteRunId).not.toBe(first.suiteRunId);
    expect(finishedSummary(fx, retry.suiteRunId)).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
    expect(fx.caseRunIdsOf(retry.suiteRunId).map((r) => r.caseId)).toEqual([fx.caseIds[0]]);
    // History is immutable — the original run still shows its failure.
    expect(finishedSummary(fx, first.suiteRunId)).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
    });
  });

  it("throws when nothing failed or the run is unknown", async () => {
    const fx = track(makeFixture([{ steps: [{ action: "goto", value: "https://x.test" }] }]));
    const passed = fx.suite.runSuite({
      suiteId: fx.suiteId,
      caseIds: fx.caseIds,
      mode: "unsupervised",
    });
    await passed.done;
    expect(() => fx.suite.rerunFailed({ suiteRunId: passed.suiteRunId })).toThrow(
      NoFailedCasesError,
    );
    expect(() => fx.suite.rerunFailed({ suiteRunId: "ghost" })).toThrow(/suite run not found/);
  });
});

// --- Re-run last failed ----------------------------------------------------------

describe("rerunLastFailed (M12)", () => {
  function failingFixture(): Fixture {
    return track(
      makeFixture(
        [
          {
            steps: [
              { action: "goto", value: "https://x.test" },
              { action: "click", selector: "#go" },
            ],
          },
          { steps: [{ action: "goto", value: "https://y.test" }] },
        ],
        { workerCount: () => 2 },
      ),
    );
  }

  it("retries the failed set of the latest finished run as a new run", async () => {
    const fx = failingFixture();
    fx.launcher.failClicks = true;
    const first = fx.suite.runSuite({
      suiteId: fx.suiteId,
      caseIds: fx.caseIds,
      mode: "unsupervised",
    });
    await first.done;
    expect(finishedSummary(fx, first.suiteRunId)).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
    });

    fx.launcher.failClicks = false;
    const retry = fx.suite.rerunLastFailed({ suiteId: fx.suiteId });
    await retry.done;
    expect(retry.suiteRunId).not.toBe(first.suiteRunId);
    expect(finishedSummary(fx, retry.suiteRunId)).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
    expect(fx.caseRunIdsOf(retry.suiteRunId).map((r) => r.caseId)).toEqual([fx.caseIds[0]]);
    // History is immutable — the original run still shows its failure.
    expect(finishedSummary(fx, first.suiteRunId)).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
    });
  });

  it("reads the latest finished run, not an older one", async () => {
    const fx = failingFixture();
    fx.launcher.failClicks = true;
    const first = fx.suite.runSuite({
      suiteId: fx.suiteId,
      caseIds: fx.caseIds,
      mode: "unsupervised",
    });
    await first.done;
    fx.launcher.failClicks = false;
    const second = fx.suite.runSuite({
      suiteId: fx.suiteId,
      caseIds: fx.caseIds,
      mode: "unsupervised",
    });
    await second.done;
    expect(finishedSummary(fx, second.suiteRunId)).toEqual({
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
    });
    // The latest finished run is clean, so there is nothing to retry even
    // though the older run has a failure.
    expect(() => fx.suite.rerunLastFailed({ suiteId: fx.suiteId })).toThrow(NoFailedCasesError);
  });

  it("skips still-running rows when selecting the latest finished run", async () => {
    const fx = failingFixture();
    fx.launcher.failClicks = true;
    const first = fx.suite.runSuite({
      suiteId: fx.suiteId,
      caseIds: fx.caseIds,
      mode: "unsupervised",
    });
    await first.done;
    // A live run row sorts newer but must never be read mid-flight.
    fx.db
      .insert(suiteRuns)
      .values({
        id: "live-run",
        suiteId: fx.suiteId,
        mode: "unsupervised",
        status: "running",
        startedAt: Date.now() + 60_000,
      })
      .run();
    const selection = selectLastFailedCaseIds(fx.db, fx.suiteId);
    expect(selection.suiteRunId).toBe(first.suiteRunId);
    expect(selection.mode).toBe("unsupervised");
    expect(selection.caseIds).toEqual([fx.caseIds[0]]);
  });

  it("throws for unknown suites and suites with no finished runs", () => {
    const fx = track(makeFixture([{ steps: [{ action: "goto", value: "https://x.test" }] }]));
    expect(() => fx.suite.rerunLastFailed({ suiteId: "ghost" })).toThrow(/suite not found/);
    expect(() => fx.suite.rerunLastFailed({ suiteId: fx.suiteId })).toThrow(/no finished run/);
  });
});

// --- IPC + report handlers ---------------------------------------------------------

describe("runner + report IPC (M6)", () => {
  function wired(
    steps: StepDef[],
  ): Fixture & { listeners: Map<string, (payload: unknown) => unknown> } {
    const fx = makeFixture([{ steps }]);
    openHandles.push(fx.dbHandle);
    const listeners = new Map<string, (payload: unknown) => unknown>();
    const handle: IpcHandleFn = (channel, listener) => {
      listeners.set(channel, listener);
    };
    const single = new SingleCaseRunner(fx.dbHandle.db, {
      launchBrowser: fx.launcher,
      emit: (channel, payload) => {
        fx.events.push({ channel, payload });
      },
      artifactsRoot: fx.root,
    });
    registerRunnerHandlers(handle, single, fx.suite);
    registerReportHandlers(handle, fx.db, {
      artifactsRoot: fx.root,
      renderPdf: (htmlPath: string) => {
        expect(htmlPath.endsWith("report.html")).toBe(true);
        return Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      },
    });
    return { ...fx, listeners };
  }

  it("runSuite → getHtml → exportPdf round-trips through IPC", async () => {
    const fx = wired([{ action: "goto", value: "https://x.test" }]);
    const runSuiteHandler = fx.listeners.get("runner:runSuite");
    if (!runSuiteHandler) throw new Error("runner:runSuite handler not wired");
    const { suiteRunId } = (await runSuiteHandler({
      suiteId: fx.suiteId,
      caseIds: fx.caseIds,
      mode: "unsupervised",
    })) as { suiteRunId: string };
    expect(typeof suiteRunId).toBe("string");
    // IPC run channels return as soon as the run starts (progress streams
    // over run:* events) — wait for settlement before asserting artifacts.
    await waitFor(
      () =>
        fx.events.some(
          (e) =>
            e.channel === "run:finished" &&
            (e.payload as { suiteRunId: string }).suiteRunId === suiteRunId,
        ),
      `run:finished for ${suiteRunId}`,
    );

    const html = (await fx.listeners.get("report:getHtml")?.({ suiteRunId })) as string;
    expect(html).toContain("C0");
    expect(html).toContain("passed");

    const pdfPath = (await fx.listeners.get("report:exportPdf")?.({ suiteRunId })) as string;
    expect(pdfPath.endsWith("report.pdf")).toBe(true);
    expect(existsSync(pdfPath)).toBe(true);
    // rerunFailed validates synchronously — it throws, not rejects.
    expect(() => fx.listeners.get("runner:rerunFailed")?.({ suiteRunId })).toThrow(
      NoFailedCasesError,
    );
    // rerunLastFailed rides the same delegation path (M12) — the passing run
    // above is the latest finished, so there is nothing to retry.
    expect(() => fx.listeners.get("runner:rerunLastFailed")?.({ suiteId: fx.suiteId })).toThrow(
      NoFailedCasesError,
    );
    expect(() => fx.listeners.get("runner:rerunLastFailed")?.({})).toThrow();
    await expect(
      fx.listeners.get("runner:cancel")?.({ suiteRunId }) as Promise<null>,
    ).resolves.toBeNull();
  });

  it("report channels validate payloads and miss on unknown runs", async () => {
    const fx = wired([{ action: "click", selector: "#a" }]);
    expect(() => fx.listeners.get("report:getHtml")?.({})).toThrow();
    // getHtml is synchronous (readFileSync) — it throws, not rejects.
    expect(() => fx.listeners.get("report:getHtml")?.({ suiteRunId: "ghost" })).toThrow(
      /suite run not found/,
    );
    await expect(fx.listeners.get("report:exportPdf")?.({ suiteRunId: "ghost" })).rejects.toThrow(
      /suite run not found/,
    );
  });
});

// --- Worker count -------------------------------------------------------------------

describe("defaultWorkerCount (PLAN §2)", () => {
  it("stays within [1, cases]", () => {
    expect(defaultWorkerCount(1)).toBeGreaterThanOrEqual(1);
    expect(defaultWorkerCount(1)).toBeLessThanOrEqual(1);
    expect(defaultWorkerCount(64)).toBeGreaterThanOrEqual(1);
    expect(defaultWorkerCount(64)).toBeLessThanOrEqual(64);
  });
});
