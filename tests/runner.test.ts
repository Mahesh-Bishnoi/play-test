import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import type { BrowserLauncher, RunContext, RunPage, RunEventChannel } from "../src/main/runner.js";
import {
  ContextClosedError,
  RunAlreadyActiveError,
  SingleCaseRunner,
  StepExecutionError,
  executeStep,
  substituteStepValue,
} from "../src/main/runner.js";
import { SuiteRunner } from "../src/main/suite-runner.js";
import { caseVideoPath, stepScreenshotPath } from "../src/main/artifacts.js";
import { createDatabase } from "../src/main/db.js";
import type { DatabaseHandle } from "../src/main/db.js";
import type { AppDatabase } from "../src/main/db.js";
import { registerRunnerHandlers } from "../src/main/ipc-register.js";
import type { IpcHandleFn } from "../src/main/ipc-register.js";
import { createCase } from "../src/main/ipc-cases.js";
import { createProject } from "../src/main/ipc-projects.js";
import { setTestData, upsertStep } from "../src/main/ipc-steps.js";
import { caseRuns, stepRuns, suiteRuns } from "../src/main/schema.js";
import { MissingTestDataKeyError } from "../src/shared/step-types.js";

// --- Fakes --------------------------------------------------------------------

interface RecordedCall {
  method: string;
  args: (string | number | undefined)[];
}

class FakePage implements RunPage {
  calls: RecordedCall[] = [];
  screenshots: string[] = [];
  failWhen: ((method: string) => boolean) | null = null;
  failMessage = "boom";
  gate: Promise<void> | null = null;
  private gated = false;

  private async enter(method: string, args: (string | number | undefined)[]): Promise<void> {
    this.calls.push({ method, args });
    if (this.gate !== null && !this.gated) {
      this.gated = true;
      await this.gate;
    }
    if (this.failWhen?.(method) === true) {
      throw new Error(this.failMessage);
    }
  }

  async goto(url: string, timeoutMs?: number): Promise<void> {
    await this.enter("goto", [url, timeoutMs]);
  }
  async click(selector: string, timeoutMs?: number): Promise<void> {
    await this.enter("click", [selector, timeoutMs]);
  }
  async dblclick(selector: string, timeoutMs?: number): Promise<void> {
    await this.enter("dblclick", [selector, timeoutMs]);
  }
  async fill(selector: string, value: string, timeoutMs?: number): Promise<void> {
    await this.enter("fill", [selector, value, timeoutMs]);
  }
  async selectOption(selector: string, value: string, timeoutMs?: number): Promise<void> {
    await this.enter("selectOption", [selector, value, timeoutMs]);
  }
  async check(selector: string, timeoutMs?: number): Promise<void> {
    await this.enter("check", [selector, timeoutMs]);
  }
  async press(selector: string | undefined, key: string, timeoutMs?: number): Promise<void> {
    await this.enter("press", [selector, key, timeoutMs]);
  }
  async assertVisible(selector: string, timeoutMs?: number): Promise<void> {
    await this.enter("assertVisible", [selector, timeoutMs]);
  }
  async assertText(selector: string, value: string, timeoutMs?: number): Promise<void> {
    await this.enter("assertText", [selector, value, timeoutMs]);
  }
  async waitForTimeout(ms: number): Promise<void> {
    await this.enter("waitForTimeout", [ms, undefined]);
  }
  async screenshot(path: string): Promise<void> {
    await this.enter("screenshot", [path, undefined]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fake-png");
    this.screenshots.push(path);
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
  headlessSeen: boolean[] = [];
  contexts: FakeContext[] = [];
  launchFail: string | null = null;
  videoContent = "fake-video";

  async launch(headless: boolean, _videoDir: string): Promise<RunContext> {
    if (this.launchFail !== null) {
      throw new Error(this.launchFail);
    }
    this.headlessSeen.push(headless);
    const context = new FakeContext();
    this.contexts.push(context);
    return context;
  }

  /** Give the next launched context a real video file to retain/discard. */
  primeVideo(root: string): string {
    const path = join(root, `raw-${this.contexts.length}.webm`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, this.videoContent);
    return path;
  }
}

interface Fixture {
  dbHandle: DatabaseHandle;
  db: AppDatabase;
  launcher: FakeLauncher;
  events: { channel: RunEventChannel; payload: unknown }[];
  runner: SingleCaseRunner;
  root: string;
  caseId: string;
  projectId: string;
}

function seedCase(
  db: AppDatabase,
  steps: { action: "goto" | "click" | "fill" | "wait"; selector?: string; value?: string }[],
  data?: Record<string, string>,
): { caseId: string; projectId: string } {
  const project = createProject(db, { name: "P" });
  const testCase = createCase(db, { projectId: project.id, name: "C" });
  steps.forEach((step, order) => {
    upsertStep(db, { caseId: testCase.id, step: { order, ...step } });
  });
  if (data !== undefined) {
    setTestData(db, { caseId: testCase.id, data });
  }
  return { caseId: testCase.id, projectId: project.id };
}

function makeFixture(
  steps: { action: "goto" | "click" | "fill" | "wait"; selector?: string; value?: string }[] = [
    { action: "goto", value: "https://x.test" },
    { action: "click", selector: "#go" },
  ],
  data?: Record<string, string>,
): Fixture {
  const dbHandle = createDatabase(":memory:");
  const root = join(
    tmpdir(),
    `playtest-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  const launcher = new FakeLauncher();
  const events: Fixture["events"] = [];
  const runner = new SingleCaseRunner(dbHandle.db, {
    launchBrowser: launcher,
    emit: (channel, payload) => {
      events.push({ channel, payload });
    },
    artifactsRoot: root,
  });
  const caseId = seedCase(dbHandle.db, steps, data);
  return { dbHandle, db: dbHandle.db, launcher, events, runner, root, ...caseId };
}

function finishedOf(fx: Fixture): { suiteRunId: string; summary: unknown } {
  const found = fx.events.filter((e) => e.channel === "run:finished");
  expect(found).toHaveLength(1);
  return found[0]?.payload as { suiteRunId: string; summary: unknown };
}

function stepRows(fx: Fixture, caseRunId: string) {
  return fx.db.select().from(stepRuns).where(eq(stepRuns.caseRunId, caseRunId)).all();
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

// --- Pure helpers ---------------------------------------------------------------

describe("substituteStepValue (PLAN §10)", () => {
  it("replaces {{key}} placeholders and passes through plain values", () => {
    expect(substituteStepValue("hi {{user}}!", { user: "ada" })).toBe("hi ada!");
    expect(substituteStepValue("plain", {})).toBe("plain");
    expect(substituteStepValue(undefined, {})).toBeUndefined();
  });

  it("throws MissingTestDataKeyError naming the absent key", () => {
    expect(() => substituteStepValue("hi {{ghost}}", {})).toThrow(MissingTestDataKeyError);
    expect(() => substituteStepValue("hi {{ghost}}", {})).toThrow(/ghost/);
  });
});

describe("executeStep mapping", () => {
  it("drives each action with the right page call", async () => {
    const page = new FakePage();
    await executeStep(page, { order: 0, action: "goto", value: "https://x.test" });
    await executeStep(page, { order: 1, action: "fill", selector: "#a", value: "hi" });
    await executeStep(page, { order: 2, action: "click", selector: "#b" });
    await executeStep(page, { order: 3, action: "wait", value: "500" });
    expect(page.calls.map((c) => c.method)).toEqual(["goto", "fill", "click", "waitForTimeout"]);
    expect(page.calls[1]).toMatchObject({ args: ["#a", "hi", undefined] });
    expect(page.calls[3]).toMatchObject({ args: [500, undefined] });
  });

  it("maps dblclick markers and selector-less press", async () => {
    const page = new FakePage();
    await executeStep(page, { order: 0, action: "click", selector: "#b", value: "dblclick" });
    await executeStep(page, { order: 1, action: "press", value: "Enter" });
    expect(page.calls.map((c) => c.method)).toEqual(["dblclick", "press"]);
    expect(page.calls[1]).toMatchObject({ args: [undefined, "Enter", undefined] });
  });

  it("rejects missing required fields with actionable errors", async () => {
    const page = new FakePage();
    await expect(executeStep(page, { order: 0, action: "goto" })).rejects.toThrow(
      StepExecutionError,
    );
    await expect(executeStep(page, { order: 1, action: "click" })).rejects.toThrow(/selector/);
    await expect(
      executeStep(page, { order: 2, action: "wait", value: "page.screenshot()" }),
    ).rejects.toThrow(/duration in ms/);
  });
});

// --- Full runs ------------------------------------------------------------------

describe("runSingle (M5)", () => {
  it("passes all steps headless when unsupervised, screenshotting every step", async () => {
    const fx = track(makeFixture());
    const rawVideo = fx.launcher.primeVideo(fx.root);
    const originalLaunch = fx.launcher.launch.bind(fx.launcher);
    fx.launcher.launch = async (headless, videoDir) => {
      const context = (await originalLaunch(headless, videoDir)) as FakeContext;
      context.videoFile = rawVideo;
      return context;
    };
    const started = fx.runner.runSingle({ caseId: fx.caseId, mode: "unsupervised" });
    await started.done;

    expect(fx.launcher.headlessSeen).toEqual([true]);
    const page = fx.launcher.contexts[0]?.page;
    expect(page?.calls.map((c) => c.method)).toEqual(["goto", "screenshot", "click", "screenshot"]);

    const caseRow = fx.db
      .select()
      .from(caseRuns)
      .where(eq(caseRuns.id, started.caseRunId))
      .all()[0];
    expect(caseRow?.status).toBe("passed");
    const suiteRow = fx.db
      .select()
      .from(suiteRuns)
      .where(eq(suiteRuns.id, started.suiteRunId))
      .all()[0];
    expect(suiteRow?.status).toBe("passed");

    const rows = stepRows(fx, started.caseRunId);
    expect(rows.map((r) => r.status)).toEqual(["pass", "pass"]);
    for (const row of rows) {
      expect(row.screenshotPath).toContain(`step-0${row.order}.png`);
      expect(existsSync(row.screenshotPath ?? "")).toBe(true);
    }
    const shot = stepScreenshotPath(fx.root, "P", started.suiteRunId, fx.caseId, 0);
    expect(shot.endsWith("step-00.png")).toBe(true);

    expect(finishedOf(fx).summary).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
    // Passing runs discard their recording (retain-on-failure, PLAN §2).
    expect(existsSync(rawVideo)).toBe(false);
    const caseRow0 = fx.db
      .select()
      .from(caseRuns)
      .where(eq(caseRuns.id, started.caseRunId))
      .all()[0];
    expect(caseRow0?.videoPath).toBeNull();
    const updates = fx.events.filter((e) => e.channel === "run:step-update");
    expect(updates.map((e) => (e.payload as { status: string }).status)).toEqual([
      "running",
      "pass",
      "running",
      "pass",
    ]);
  });

  it("substitutes {{key}} values from test data before executing", async () => {
    const fx = track(
      makeFixture([{ action: "fill", selector: "#name", value: "hi {{user}}" }], { user: "ada" }),
    );
    const started = fx.runner.runSingle({ caseId: fx.caseId, mode: "unsupervised" });
    await started.done;
    expect(fx.launcher.contexts[0]?.page.calls[0]).toMatchObject({
      args: ["#name", "hi ada", undefined],
    });
    expect(stepRows(fx, started.caseRunId).map((r) => r.status)).toEqual(["pass"]);
  });

  it("fails fast without launching a browser when a test-data key is missing", async () => {
    const fx = track(
      makeFixture([
        { action: "goto", value: "https://{{host}}/login" },
        { action: "click", selector: "#go" },
      ]),
    );
    const started = fx.runner.runSingle({ caseId: fx.caseId, mode: "supervised" });
    await started.done;

    expect(fx.launcher.contexts).toHaveLength(0);
    const rows = stepRows(fx, started.caseRunId);
    expect(rows.map((r) => r.status)).toEqual(["fail", "skipped"]);
    expect(rows[0]?.error).toContain("missing test-data key: host");
    const suiteRow = fx.db
      .select()
      .from(suiteRuns)
      .where(eq(suiteRuns.id, started.suiteRunId))
      .all()[0];
    expect(suiteRow?.status).toBe("failed");
    expect(finishedOf(fx).summary).toEqual({ total: 1, passed: 0, failed: 1, skipped: 0 });
  });

  it("unsupervised failure skips the rest, closes the context, keeps video+trace", async () => {
    const fx = track(
      makeFixture([
        { action: "goto", value: "https://x.test" },
        { action: "click", selector: "#go" },
        { action: "click", selector: "#next" },
      ]),
    );
    const originalLaunch = fx.launcher.launch.bind(fx.launcher);
    fx.launcher.launch = async (headless, videoDir) => {
      const context = (await originalLaunch(headless, videoDir)) as FakeContext;
      context.page.failWhen = (method) => method === "click";
      context.page.failMessage = "locator('#go'): element is not visible";
      context.videoFile = fx.launcher.primeVideo(fx.root);
      return context;
    };
    const started = fx.runner.runSingle({ caseId: fx.caseId, mode: "unsupervised" });
    await started.done;

    expect(fx.launcher.headlessSeen).toEqual([true]);
    expect(fx.launcher.contexts[0]?.closed).toBe(true);
    const rows = stepRows(fx, started.caseRunId);
    expect(rows.map((r) => r.status)).toEqual(["pass", "fail", "skipped"]);
    expect(rows[1]?.error).toContain("not visible");
    for (const row of rows) {
      if (row.status === "skipped") {
        expect(row.screenshotPath).toBeNull();
      } else {
        expect(existsSync(row.screenshotPath ?? "")).toBe(true);
      }
    }
    const caseRow = fx.db
      .select()
      .from(caseRuns)
      .where(eq(caseRuns.id, started.caseRunId))
      .all()[0];
    expect(caseRow?.status).toBe("failed");
    expect(caseRow?.videoPath).toBe(
      caseVideoPath(fx.root, fx.projectId, started.suiteRunId, fx.caseId),
    );
    expect(existsSync(caseRow?.videoPath ?? "")).toBe(true);
    expect(fx.launcher.contexts[0]?.tracePath?.endsWith("trace.zip")).toBe(true);
    expect(finishedOf(fx).summary).toEqual({ total: 1, passed: 0, failed: 1, skipped: 0 });
  });

  it("passes an empty case without launching a browser", async () => {
    const fx = track(makeFixture([]));
    const started = fx.runner.runSingle({ caseId: fx.caseId, mode: "unsupervised" });
    await started.done;
    expect(fx.launcher.contexts).toHaveLength(0);
    expect(finishedOf(fx).summary).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(fx.events.some((e) => e.channel === "run:log")).toBe(true);
  });

  it("marks the run failed when the browser cannot launch", async () => {
    const fx = track(makeFixture());
    fx.launcher.launchFail = "chromium missing — run playwright install chromium";
    const started = fx.runner.runSingle({ caseId: fx.caseId, mode: "unsupervised" });
    await started.done;
    expect(stepRows(fx, started.caseRunId).map((r) => r.status)).toEqual(["skipped", "skipped"]);
    const errors = fx.events.filter((e) => e.channel === "run:log");
    expect(errors.some((e) => JSON.stringify(e.payload).includes("chromium missing"))).toBe(true);
    expect(finishedOf(fx).summary).toEqual({ total: 1, passed: 0, failed: 1, skipped: 0 });
  });

  it("rejects unknown cases and invalid payloads before touching the db", () => {
    const fx = track(makeFixture());
    expect(() => fx.runner.runSingle({ caseId: "ghost", mode: "unsupervised" })).toThrow();
    expect(() =>
      fx.runner.runSingle({ caseId: fx.caseId, mode: "headed" as "supervised" }),
    ).toThrow();
    expect(fx.db.select().from(suiteRuns).all()).toHaveLength(0);
  });
});

// --- Supervised pause / resume / cancel ------------------------------------------

describe("supervised pause + resume (M5)", () => {
  function failingFixture(): Fixture {
    return makeFixture(
      [
        { action: "goto", value: "https://x.test" },
        { action: "fill", selector: "#name", value: "ada" },
        { action: "click", selector: "#go" },
      ],
      {},
    );
  }

  it("pauses with the context open and resumes edited steps to green", async () => {
    const fx = track(failingFixture());
    // Arm the fill failure before starting — runSingle launches synchronously.
    const originalLaunch = fx.launcher.launch.bind(fx.launcher);
    fx.launcher.launch = async (headless, videoDir) => {
      const context = (await originalLaunch(headless, videoDir)) as FakeContext;
      context.page.failWhen = (method) => method === "fill";
      context.page.failMessage = "selector unresolved";
      return context;
    };
    const started = fx.runner.runSingle({ caseId: fx.caseId, mode: "supervised" });
    await started.done;

    const live = fx.launcher.contexts[0];
    expect(live?.closed).toBe(false);
    expect(stepRows(fx, started.caseRunId).map((r) => r.status)).toEqual(["pass", "fail"]);
    expect(fx.events.filter((e) => e.channel === "run:finished")).toHaveLength(0);
    expect(
      fx.events.some(
        (e) => e.channel === "run:log" && JSON.stringify(e.payload).includes("paused"),
      ),
    ).toBe(true);

    // Edit the failed step while paused, then resume from it.
    const failing = stepRows(fx, started.caseRunId).find((r) => r.status === "fail");
    expect(failing).toBeDefined();
    upsertStep(fx.db, {
      caseId: fx.caseId,
      step: {
        id: failing?.stepId,
        order: 1,
        action: "fill",
        selector: "#name-fixed",
        value: "ada",
      },
    });
    live!.page.failWhen = null;
    const resumed = fx.runner.resumeFromStep({ caseRunId: started.caseRunId, fromOrder: 1 });
    await resumed.done;

    expect(resumed.suiteRunId).toBe(started.suiteRunId);
    expect(stepRows(fx, started.caseRunId).map((r) => r.status)).toEqual(["pass", "pass", "pass"]);
    expect(live?.closed).toBe(true);
    const suiteRow = fx.db
      .select()
      .from(suiteRuns)
      .where(eq(suiteRuns.id, started.suiteRunId))
      .all()[0];
    expect(suiteRow?.status).toBe("passed");
    expect(finishedOf(fx).summary).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
  });

  it("resume without a live session demands a full re-run", async () => {
    const fx = track(makeFixture([{ action: "click", selector: "#go" }]));
    fx.launcher.launch = async (headless, videoDir) => {
      const context = (await new FakeLauncher().launch(headless, videoDir)) as FakeContext;
      context.page.failWhen = () => true;
      fx.launcher.contexts.push(context);
      fx.launcher.headlessSeen.push(headless);
      return context;
    };
    const started = fx.runner.runSingle({ caseId: fx.caseId, mode: "unsupervised" });
    await started.done;
    expect(() => fx.runner.resumeFromStep({ caseRunId: started.caseRunId, fromOrder: 0 })).toThrow(
      ContextClosedError,
    );
    expect(() => fx.runner.resumeFromStep({ caseRunId: "ghost", fromOrder: 0 })).toThrow(
      ContextClosedError,
    );
  });

  it("cancel mid-run skips the rest and cancels the suite", async () => {
    const fx = track(
      makeFixture([
        { action: "goto", value: "https://x.test" },
        { action: "click", selector: "#a" },
        { action: "click", selector: "#b" },
      ]),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalLaunch = fx.launcher.launch.bind(fx.launcher);
    fx.launcher.launch = async (headless, videoDir) => {
      const context = (await originalLaunch(headless, videoDir)) as FakeContext;
      context.page.gate = gate;
      return context;
    };
    const started = fx.runner.runSingle({ caseId: fx.caseId, mode: "unsupervised" });
    // Wait until the first step is executing, then cancel.
    for (let i = 0; i < 1000 && fx.launcher.contexts[0]?.page.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    await fx.runner.cancelRun({ suiteRunId: started.suiteRunId });
    release();
    await started.done;

    expect(stepRows(fx, started.caseRunId).map((r) => r.status)).toEqual([
      "pass",
      "skipped",
      "skipped",
    ]);
    const caseRow = fx.db
      .select()
      .from(caseRuns)
      .where(eq(caseRuns.id, started.caseRunId))
      .all()[0];
    expect(caseRow?.status).toBe("cancelled");
    expect(finishedOf(fx).summary).toEqual({ total: 1, passed: 0, failed: 0, skipped: 1 });
    expect(fx.launcher.contexts[0]?.closed).toBe(true);
  });

  it("cancel is a no-op for unknown or finished runs", async () => {
    const fx = track(makeFixture([{ action: "click", selector: "#a" }]));
    await expect(fx.runner.cancelRun({ suiteRunId: "ghost" })).resolves.toBeNull();
    const started = fx.runner.runSingle({ caseId: fx.caseId, mode: "unsupervised" });
    await started.done;
    await expect(fx.runner.cancelRun({ suiteRunId: started.suiteRunId })).resolves.toBeNull();
    expect(fx.events.filter((e) => e.channel === "run:finished")).toHaveLength(1);
  });

  it("rejects a second run while one is active", async () => {
    const fx = track(makeFixture([{ action: "goto", value: "https://x.test" }]));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalLaunch = fx.launcher.launch.bind(fx.launcher);
    fx.launcher.launch = async (headless, videoDir) => {
      const context = (await originalLaunch(headless, videoDir)) as FakeContext;
      context.page.gate = gate;
      return context;
    };
    const started = fx.runner.runSingle({ caseId: fx.caseId, mode: "supervised" });
    for (let i = 0; i < 1000 && fx.launcher.contexts.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(() => fx.runner.runSingle({ caseId: fx.caseId, mode: "supervised" })).toThrow(
      RunAlreadyActiveError,
    );
    release();
    await started.done;
  });
});

// --- Suite delegation + IPC wiring -------------------------------------------------

describe("suite delegation (M6)", () => {
  it("routes suite channels to the SuiteRunner and fans cancel out to both", async () => {
    const fx = makeFixture([{ action: "click", selector: "#a" }]);
    openHandles.push(fx.dbHandle);
    const suite = new SuiteRunner(fx.dbHandle.db, {
      launchBrowser: fx.launcher,
      emit: (channel, payload) => {
        fx.events.push({ channel, payload });
      },
      artifactsRoot: fx.root,
    });
    const listeners = new Map<string, (payload: unknown) => unknown>();
    const handle: IpcHandleFn = (channel, listener) => {
      listeners.set(channel, listener);
    };
    registerRunnerHandlers(handle, fx.runner, suite);
    for (const channel of [
      "runner:runSingle",
      "runner:runSuite",
      "runner:resumeFromStep",
      "runner:rerunFailed",
      "runner:cancel",
    ]) {
      expect(listeners.has(channel)).toBe(true);
    }
    expect(() => listeners.get("runner:runSingle")?.({ caseId: fx.caseId })).toThrow();
    // No suite with id "s" exists — the call reaches the SuiteRunner (not a stub).
    expect(() =>
      listeners.get("runner:runSuite")?.({ suiteId: "s", caseIds: ["c"], mode: "unsupervised" }),
    ).toThrow(/suite not found/);
    expect(() => listeners.get("runner:rerunFailed")?.({ suiteRunId: "ghost" })).toThrow();

    const ids = listeners.get("runner:runSingle")?.({
      caseId: fx.caseId,
      mode: "unsupervised",
    }) as { suiteRunId: string; caseRunId: string };
    expect(typeof ids.suiteRunId).toBe("string");
    // Let the background run settle so the session clears (no cross-test leak).
    for (
      let i = 0;
      i < 1000 && fx.events.filter((e) => e.channel === "run:finished").length === 0;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(fx.events.filter((e) => e.channel === "run:finished")).toHaveLength(1);
    await expect(
      listeners.get("runner:cancel")?.({ suiteRunId: ids.suiteRunId }) as Promise<null>,
    ).resolves.toBeNull();
  });
});

// --- Artifacts --------------------------------------------------------------------

describe("artifacts layout (PLAN §4)", () => {
  it("builds the per-case layout with padded step names", () => {
    const shot = stepScreenshotPath("R", "proj", "run", "case", 3);
    expect(shot).toBe(join("R", "proj", "run", "case", "step-03.png"));
    const video = caseVideoPath("R", "proj", "run", "case");
    expect(video).toBe(join("R", "proj", "run", "case", "failed.webm"));
  });
});
