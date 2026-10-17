import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import type { BrowserLauncher, RunContext, RunPage, RunEventChannel } from "../src/main/runner.js";
import {
  captureStepScreenshot,
  ContextClosedError,
  RunAlreadyActiveError,
  SingleCaseRunner,
  StepExecutionError,
  executeStep,
  formatStepError,
  parseAssertMatcher,
  parseClickValue,
  parseSelectValue,
  parseStringList,
  stepTraceLabel,
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
  args: unknown[];
}

class FakePage implements RunPage {
  calls: RecordedCall[] = [];
  screenshots: string[] = [];
  failWhen: ((method: string) => boolean) | null = null;
  failMessage = "boom";
  /** Number of upcoming `screenshot` calls to fail (navigation-race simulation). */
  screenshotFailuresRemaining = 0;
  gate: Promise<void> | null = null;
  private gated = false;

  private async enter(method: string, args: unknown[]): Promise<void> {
    this.calls.push({ method, args: args as (string | number | undefined)[] });
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
  async click(selector: string, timeoutMs?: number, options?: unknown): Promise<void> {
    await this.enter("click", [selector, timeoutMs, options]);
  }
  async dblclick(selector: string, timeoutMs?: number): Promise<void> {
    await this.enter("dblclick", [selector, timeoutMs]);
  }
  async fill(selector: string, value: string, timeoutMs?: number): Promise<void> {
    await this.enter("fill", [selector, value, timeoutMs]);
  }
  async type(selector: string, value: string, timeoutMs?: number): Promise<void> {
    await this.enter("type", [selector, value, timeoutMs]);
  }
  async selectOption(
    selector: string,
    value: string | string[],
    timeoutMs?: number,
  ): Promise<void> {
    await this.enter("selectOption", [selector, value, timeoutMs]);
  }
  async check(selector: string, timeoutMs?: number): Promise<void> {
    await this.enter("check", [selector, timeoutMs]);
  }
  async uncheck(selector: string, timeoutMs?: number): Promise<void> {
    await this.enter("uncheck", [selector, timeoutMs]);
  }
  async hover(selector: string, timeoutMs?: number): Promise<void> {
    await this.enter("hover", [selector, timeoutMs]);
  }
  async focus(selector: string, timeoutMs?: number): Promise<void> {
    await this.enter("focus", [selector, timeoutMs]);
  }
  async press(selector: string | undefined, key: string, timeoutMs?: number): Promise<void> {
    await this.enter("press", [selector, key, timeoutMs]);
  }
  async assertVisible(selector: string, timeoutMs?: number): Promise<void> {
    await this.enter("assertVisible", [selector, timeoutMs]);
  }
  async assertHidden(selector: string, timeoutMs?: number): Promise<void> {
    await this.enter("assertHidden", [selector, timeoutMs]);
  }
  async assertText(selector: string, value: string, timeoutMs?: number): Promise<void> {
    await this.enter("assertText", [selector, value, timeoutMs]);
  }
  async assertValue(selector: string, value: string, timeoutMs?: number): Promise<void> {
    await this.enter("assertValue", [selector, value, timeoutMs]);
  }
  async assertChecked(selector: string, timeoutMs?: number): Promise<void> {
    await this.enter("assertChecked", [selector, timeoutMs]);
  }
  async assertUnchecked(selector: string, timeoutMs?: number): Promise<void> {
    await this.enter("assertUnchecked", [selector, timeoutMs]);
  }
  async assertEnabled(selector: string, timeoutMs?: number): Promise<void> {
    await this.enter("assertEnabled", [selector, timeoutMs]);
  }
  async assertDisabled(selector: string, timeoutMs?: number): Promise<void> {
    await this.enter("assertDisabled", [selector, timeoutMs]);
  }
  async assertEditable(selector: string, timeoutMs?: number): Promise<void> {
    await this.enter("assertEditable", [selector, timeoutMs]);
  }
  async assertFocused(selector: string, timeoutMs?: number): Promise<void> {
    await this.enter("assertFocused", [selector, timeoutMs]);
  }
  async assertCount(selector: string, expected: number, timeoutMs?: number): Promise<void> {
    await this.enter("assertCount", [selector, expected, timeoutMs]);
  }
  async assertUrl(value: string, timeoutMs?: number): Promise<void> {
    await this.enter("assertUrl", [value, timeoutMs]);
  }
  async assertTitle(value: string, timeoutMs?: number): Promise<void> {
    await this.enter("assertTitle", [value, timeoutMs]);
  }
  async waitForTimeout(ms: number): Promise<void> {
    await this.enter("waitForTimeout", [ms, undefined]);
  }
  async screenshot(path: string): Promise<void> {
    await this.enter("screenshot", [path, undefined]);
    if (this.screenshotFailuresRemaining > 0) {
      this.screenshotFailuresRemaining -= 1;
      throw new Error("Unable to capture screenshot");
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fake-png");
    this.screenshots.push(path);
  }
}

class FakeContext implements RunContext {
  page: FakePage = new FakePage();
  closed = false;
  tracePath: string | null = null;
  traceChunkPaths: string[] = [];
  traceGroups: string[] = [];
  traceGroupEnds = 0;
  /** Raw recording assigned at launch (null = not recording). */
  videoFile: string | null = null;
  /** Destination passed to `saveVideo` when a failure kept the recording. */
  savedVideoPath: string | null = null;
  /** True once `discardVideo` dropped a passing/cancelled recording. */
  videoDiscarded = false;

  async close(): Promise<void> {
    this.closed = true;
  }
  async saveVideo(dest: string): Promise<void> {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, this.videoFile === null ? "" : "fake-video");
    this.savedVideoPath = dest;
  }
  async discardVideo(): Promise<void> {
    this.videoDiscarded = true;
    if (this.videoFile !== null) {
      try {
        unlinkSync(this.videoFile);
      } catch {
        // Already gone — a leftover recording is harmless.
      }
    }
  }
  async saveTrace(path: string | null): Promise<void> {
    this.tracePath = path;
  }
  async saveTraceChunk(path: string): Promise<void> {
    this.traceChunkPaths.push(path);
  }
  async group(name: string): Promise<void> {
    this.traceGroups.push(name);
  }
  async groupEnd(): Promise<void> {
    this.traceGroupEnds += 1;
  }
}

class FakeLauncher implements BrowserLauncher {
  headlessSeen: boolean[] = [];
  titlesSeen: string[] = [];
  contexts: FakeContext[] = [];
  launchFail: string | null = null;
  videoContent = "fake-video";

  async launch(headless: boolean, _videoDir: string, title = ""): Promise<RunContext> {
    if (this.launchFail !== null) {
      throw new Error(this.launchFail);
    }
    this.headlessSeen.push(headless);
    this.titlesSeen.push(title);
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

  it("drives new input actions with the right page calls", async () => {
    const page = new FakePage();
    await executeStep(page, { order: 0, action: "dblclick", selector: "#b" });
    await executeStep(page, { order: 1, action: "uncheck", selector: "#c" });
    await executeStep(page, { order: 2, action: "hover", selector: "#h" });
    await executeStep(page, { order: 3, action: "focus", selector: "#f" });
    await executeStep(page, { order: 4, action: "type", selector: "#t", value: "hi" });
    await executeStep(page, {
      order: 5,
      action: "select",
      selector: "#s",
      value: '["a", "b"]',
    });
    expect(page.calls.map((c) => c.method)).toEqual([
      "dblclick",
      "uncheck",
      "hover",
      "focus",
      "type",
      "selectOption",
    ]);
    expect(page.calls[4]).toMatchObject({ args: ["#t", "hi", undefined] });
    expect(page.calls[5]).toMatchObject({ args: ["#s", ["a", "b"], undefined] });
  });

  it("encodes click variants in value without schema changes", async () => {
    const page = new FakePage();
    await executeStep(page, { order: 0, action: "click", selector: "#r", value: "right" });
    await executeStep(page, { order: 1, action: "click", selector: "#f", value: "force" });
    await executeStep(page, { order: 2, action: "click", selector: "#m", value: "shift-click" });
    expect(page.calls.map((c) => c.method)).toEqual(["click", "click", "click"]);
    expect(page.calls[0]?.args[2]).toMatchObject({ button: "right" });
    expect(page.calls[1]?.args[2]).toMatchObject({ force: true });
    expect(page.calls[2]?.args[2]).toMatchObject({ modifiers: ["Shift"] });
  });

  it("parses click values and select values", () => {
    expect(parseClickValue(undefined)).toEqual({ double: false, options: {} });
    expect(parseClickValue("dblclick").double).toBe(true);
    expect(parseClickValue("right").options).toMatchObject({ button: "right" });
    expect(parseClickValue('{"button":"right"}')).toEqual({
      double: false,
      options: { button: "right" },
    });
    expect(parseSelectValue('["a", "b"]')).toEqual(["a", "b"]);
    expect(parseSelectValue("2025-26")).toBe("2025-26");
  });

  it("encodes string lists as JSON arrays only when every element is a string", () => {
    expect(parseStringList('["a", "b"]')).toEqual(["a", "b"]);
    expect(parseStringList("2025-26")).toBe("2025-26");
    // Surrounding whitespace is ignored for the array form…
    expect(parseStringList('  ["a"]  ')).toEqual(["a"]);
    // …but a JSON array of non-strings is not a value list — keep the raw text.
    expect(parseStringList("[1, 2]")).toBe("[1, 2]");
    // Malformed JSON falls back to the raw string.
    expect(parseStringList("[unterminated")).toBe("[unterminated");
  });

  it("parses url/title asserts as /regex/flags, else an exact string", () => {
    // Plain strings (even a leading-slash path) match exactly, never as regex.
    expect(parseAssertMatcher("/dashboard")).toBe("/dashboard");
    expect(parseAssertMatcher("https://example.test/")).toBe("https://example.test/");

    const regex = parseAssertMatcher("/\\/login$/");
    expect(regex).toBeInstanceOf(RegExp);
    expect((regex as RegExp).test("https://example.test/login")).toBe(true);
    expect((regex as RegExp).test("https://example.test/dashboard")).toBe(false);

    // Flags after the final slash are honoured.
    const flagged = parseAssertMatcher("/login/i");
    expect((flagged as RegExp).flags).toBe("i");
    expect((flagged as RegExp).test("LOGIN")).toBe(true);

    // The last slash delimits flags, so a pattern containing slashes still parses.
    expect((parseAssertMatcher("/a/b/") as RegExp).test("x/a/b")).toBe(true);

    // An invalid pattern source falls back to the literal string.
    expect(parseAssertMatcher("/a(/")).toBe("/a(/");
  });

  it("keeps the full Playwright error text, trimming trailing whitespace and capping length", () => {
    // Playwright assertion failures end with the call log plus a trailing newline.
    const playwrightError = new Error(
      "expect(locator).toBeVisible() failed\n\nExpected: visible\nReceived: <element(s) not found>\n\nCall log:\n  - expect.toBeVisible with timeout 30000ms\n",
    );
    expect(formatStepError(playwrightError)).toBe(
      "expect(locator).toBeVisible() failed\n\nExpected: visible\nReceived: <element(s) not found>\n\nCall log:\n  - expect.toBeVisible with timeout 30000ms",
    );
    // Non-Error throwables still produce a message.
    expect(formatStepError("plain string")).toBe("plain string");
    // Oversized messages are capped before they reach the DB.
    expect(formatStepError(new Error("x".repeat(9_000)))).toHaveLength(8_000);
  });

  it("labels a step for the trace viewer: Step N · action — detail", () => {
    // Selector wins when present; value is the fallback for selector-less steps.
    expect(stepTraceLabel({ order: 2, action: "click", selector: "#go", value: "right" })).toBe(
      "Step 2 · click — #go",
    );
    expect(stepTraceLabel({ order: 0, action: "goto", value: "https://x.test" })).toBe(
      "Step 0 · goto — https://x.test",
    );
    expect(stepTraceLabel({ order: 1, action: "press", value: "Enter" })).toBe(
      "Step 1 · press — Enter",
    );
    // No detail at all omits the suffix.
    expect(stepTraceLabel({ order: 3, action: "assert-visible", selector: "" })).toBe(
      "Step 3 · assert-visible",
    );
  });

  it("drives new assertion actions with the right page calls", async () => {
    const page = new FakePage();
    await executeStep(page, { order: 0, action: "assert-hidden", selector: "#h" });
    await executeStep(page, { order: 1, action: "assert-enabled", selector: "#e" });
    await executeStep(page, { order: 2, action: "assert-disabled", selector: "#d" });
    await executeStep(page, { order: 3, action: "assert-editable", selector: "#ed" });
    await executeStep(page, { order: 4, action: "assert-focused", selector: "#f" });
    await executeStep(page, { order: 5, action: "assert-checked", selector: "#c" });
    await executeStep(page, { order: 6, action: "assert-unchecked", selector: "#u" });
    await executeStep(page, { order: 7, action: "assert-value", selector: "#v", value: "x" });
    await executeStep(page, { order: 8, action: "assert-count", selector: ".row", value: "3" });
    await executeStep(page, { order: 9, action: "assert-url", value: "/dashboard" });
    await executeStep(page, { order: 10, action: "assert-title", value: "Dashboard" });
    expect(page.calls.map((c) => c.method)).toEqual([
      "assertHidden",
      "assertEnabled",
      "assertDisabled",
      "assertEditable",
      "assertFocused",
      "assertChecked",
      "assertUnchecked",
      "assertValue",
      "assertCount",
      "assertUrl",
      "assertTitle",
    ]);
    expect(page.calls[7]).toMatchObject({ args: ["#v", "x", undefined] });
    expect(page.calls[8]).toMatchObject({ args: [".row", 3, undefined] });
  });

  it("rejects new actions with missing fields and bad counts", async () => {
    const page = new FakePage();
    await expect(executeStep(page, { order: 0, action: "uncheck" })).rejects.toThrow(/selector/);
    await expect(executeStep(page, { order: 1, action: "type", selector: "#t" })).rejects.toThrow(
      /value/,
    );
    await expect(
      executeStep(page, { order: 2, action: "assert-value", selector: "#v" }),
    ).rejects.toThrow(/value/);
    await expect(
      executeStep(page, { order: 3, action: "assert-count", selector: ".r", value: "many" }),
    ).rejects.toThrow(/count/);
    await expect(executeStep(page, { order: 4, action: "assert-url" })).rejects.toThrow(/URL/);
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
    expect(fx.launcher.contexts[0]?.videoDiscarded).toBe(true);
    expect(fx.launcher.contexts[0]?.savedVideoPath).toBeNull();
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
      context.page.failMessage =
        "expect(locator).toBeVisible() failed\nExpected: visible\nReceived: <element(s) not found>\nCall log:\n  - waiting for locator('#go')\n";
      context.videoFile = fx.launcher.primeVideo(fx.root);
      return context;
    };
    const started = fx.runner.runSingle({ caseId: fx.caseId, mode: "unsupervised" });
    await started.done;

    expect(fx.launcher.headlessSeen).toEqual([true]);
    expect(fx.launcher.contexts[0]?.closed).toBe(true);
    const rows = stepRows(fx, started.caseRunId);
    expect(rows.map((r) => r.status)).toEqual(["pass", "fail", "skipped"]);
    expect(rows[1]?.error).toContain("Call log:");
    // Trailing whitespace from Playwright's call log is trimmed.
    expect(rows[1]?.error).not.toMatch(/\s$/);
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
    expect(fx.launcher.contexts[0]?.savedVideoPath).toBe(caseRow?.videoPath);
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

  it("saves a trace chunk at the supervised pause so evidence survives a resume", async () => {
    const fx = track(failingFixture());
    const originalLaunch = fx.launcher.launch.bind(fx.launcher);
    fx.launcher.launch = async (headless, videoDir, title) => {
      const context = (await originalLaunch(headless, videoDir, title)) as FakeContext;
      context.page.failWhen = (method) => method === "fill";
      context.page.failMessage = "selector unresolved";
      return context;
    };
    const started = fx.runner.runSingle({ caseId: fx.caseId, mode: "supervised" });
    await started.done;

    // The trace is titled with the case name; each executed step is one group.
    expect(fx.launcher.titlesSeen[0]).toBe("C");
    const live = fx.launcher.contexts[0]!;
    expect(live.traceChunkPaths).toHaveLength(1);
    expect(live.traceChunkPaths[0]?.endsWith("trace.zip")).toBe(true);
    expect(live.traceGroups).toEqual(["Step 0 · goto — https://x.test", "Step 1 · fill — #name"]);
    expect(live.traceGroupEnds).toBe(2);
    // Still paused: context open, nothing discarded yet.
    expect(live.closed).toBe(false);
    expect(live.tracePath).toBeNull();

    // Resume to green: the resumed chunk is discarded, the failure chunk stays.
    live.page.failWhen = null;
    const resumed = fx.runner.resumeFromStep({ caseRunId: started.caseRunId, fromOrder: 1 });
    await resumed.done;
    expect(live.closed).toBe(true);
    expect(live.tracePath).toBeNull();
    expect(live.traceChunkPaths).toHaveLength(1);
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

// --- Supervised speed control (actionDelayMs) ------------------------------------

describe("supervised speed control (actionDelayMs)", () => {
  it("defaults omitted delay to 0 and rejects out-of-range values", async () => {
    const { RunnerRunSinglePayload } = await import("../src/shared/ipc-contract.js");
    expect(
      RunnerRunSinglePayload.parse({ caseId: "c", mode: "supervised" }).actionDelayMs,
    ).toBeUndefined();
    expect(() =>
      RunnerRunSinglePayload.parse({ caseId: "c", mode: "supervised", actionDelayMs: -1 }),
    ).toThrow();
    expect(() =>
      RunnerRunSinglePayload.parse({ caseId: "c", mode: "supervised", actionDelayMs: 10001 }),
    ).toThrow();
    expect(() =>
      RunnerRunSinglePayload.parse({ caseId: "c", mode: "supervised", actionDelayMs: 600 }),
    ).not.toThrow();
  });

  it("waits the configured delay between steps (N steps → N-1 waits)", async () => {
    const dbHandle = createDatabase(":memory:");
    openHandles.push(dbHandle);
    const root = join(
      tmpdir(),
      `playtest-speed-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(root, { recursive: true });
    const launcher = new FakeLauncher();
    const delays: number[] = [];
    const runner = new SingleCaseRunner(dbHandle.db, {
      launchBrowser: launcher,
      emit: () => undefined,
      artifactsRoot: root,
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    const { caseId } = seedCase(dbHandle.db, [
      { action: "goto", value: "https://x.test" },
      { action: "click", selector: "#a" },
      { action: "click", selector: "#b" },
    ]);
    const started = runner.runSingle({ caseId, mode: "supervised", actionDelayMs: 600 });
    await started.done;
    expect(delays).toEqual([600, 600]);
  });

  it("skips delays when omitted (previous instant behavior)", async () => {
    const dbHandle = createDatabase(":memory:");
    openHandles.push(dbHandle);
    const root = join(
      tmpdir(),
      `playtest-speed-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(root, { recursive: true });
    const launcher = new FakeLauncher();
    let delayCalls = 0;
    const runner = new SingleCaseRunner(dbHandle.db, {
      launchBrowser: launcher,
      emit: () => undefined,
      artifactsRoot: root,
      delay: () => {
        delayCalls++;
        return Promise.resolve();
      },
    });
    const { caseId } = seedCase(dbHandle.db, [
      { action: "goto", value: "https://x.test" },
      { action: "click", selector: "#a" },
    ]);
    const started = runner.runSingle({ caseId, mode: "supervised" });
    await started.done;
    expect(delayCalls).toBe(0);
  });

  it("keeps pacing across supervised pause/resume", async () => {
    const dbHandle = createDatabase(":memory:");
    openHandles.push(dbHandle);
    const root = join(
      tmpdir(),
      `playtest-speed-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(root, { recursive: true });
    const launcher = new FakeLauncher();
    const delays: number[] = [];
    const runner = new SingleCaseRunner(dbHandle.db, {
      launchBrowser: launcher,
      emit: () => undefined,
      artifactsRoot: root,
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    const { caseId } = seedCase(dbHandle.db, [
      { action: "goto", value: "https://x.test" },
      { action: "fill", selector: "#name", value: "ada" },
      { action: "click", selector: "#go" },
    ]);
    const originalLaunch = launcher.launch.bind(launcher);
    launcher.launch = async (headless, videoDir) => {
      const context = (await originalLaunch(headless, videoDir)) as FakeContext;
      context.page.failWhen = (method) => method === "fill";
      return context;
    };
    const started = runner.runSingle({ caseId, mode: "supervised", actionDelayMs: 500 });
    await started.done;
    expect(delays).toEqual([500]);
    launcher.contexts[0]!.page.failWhen = null;
    delays.length = 0;
    const resumed = runner.resumeFromStep({ caseRunId: started.caseRunId, fromOrder: 1 });
    await resumed.done;
    expect(delays).toEqual([500]);
  });
});

// --- Screenshots -----------------------------------------------------------------

describe("captureStepScreenshot (M13: bounded navigation-race retry)", () => {
  const shotPath = (): string =>
    join(tmpdir(), `playtest-shot-${Math.random().toString(36).slice(2)}`, "step-00.png");

  it("retries a racing capture up to twice, 250 ms apart, then succeeds silently", async () => {
    const page = new FakePage();
    page.screenshotFailuresRemaining = 2;
    const warnings: string[] = [];
    await captureStepScreenshot(page, shotPath(), (message) => warnings.push(message));
    expect(page.calls.filter((c) => c.method === "screenshot")).toHaveLength(3);
    expect(page.calls.filter((c) => c.method === "waitForTimeout").map((c) => c.args[0])).toEqual([
      250, 250,
    ]);
    expect(warnings).toEqual([]);
  });

  it("warns once after the last of three failed attempts (never throws)", async () => {
    const page = new FakePage();
    page.screenshotFailuresRemaining = 3;
    const path = shotPath();
    const warnings: string[] = [];
    await captureStepScreenshot(page, path, (message) => warnings.push(message));
    expect(page.calls.filter((c) => c.method === "screenshot")).toHaveLength(3);
    expect(warnings).toEqual([`screenshot failed for ${path}`]);
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
