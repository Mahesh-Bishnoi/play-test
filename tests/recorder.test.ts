import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { CodegenChild, RecorderDeps } from "../src/main/recorder.js";
import type { RecorderStartOptions } from "../src/shared/ipc-contract.js";
import {
  CodegenRecorder,
  RecorderAlreadyRunningError,
  RecorderNotRunningError,
  RecorderStartError,
  buildCodegenArgs,
  parseCodegenOutput,
} from "../src/main/recorder.js";
import { UnknownRecorderDeviceError } from "../src/main/recorder.js";
import { createDatabase } from "../src/main/db.js";
import type { DatabaseHandle } from "../src/main/db.js";
import { createCase, updateCase } from "../src/main/ipc-cases.js";
import type { IpcHandleFn } from "../src/main/ipc-register.js";
import { MissingAuthStateError, authStateDir, setCaseProfile } from "../src/main/ipc-profiles.js";
import { createProject } from "../src/main/ipc-projects.js";

const SAMPLE = `
import { test, expect } from '@playwright/test';

test('login', async ({ page }) => {
  await page.goto('https://example.com/login');
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByLabel('Password').fill('s3cret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('#country').selectOption('IN');
  await page.locator('#remember').check();
  await page.locator('#search').press('Enter');
  await page.getByText('Welcome').waitFor();
  await expect(page.getByText('Welcome')).toBeVisible();
  await expect(page.getByText('Total: 3')).toContainText('Total: 3');
  await page.waitForTimeout(500);
});
`;

function fakeChild(log: string[], overrides: Partial<CodegenChild> = {}): CodegenChild {
  return {
    pid: 4242,
    kill: (signal) => {
      log.push(`kill:${signal ?? ""}`);
      return true;
    },
    hasExited: () => false,
    stderrTail: () => "",
    ...overrides,
  };
}

function fakeDeps(code: string, log: string[]): RecorderDeps {
  const child = fakeChild(log);
  return {
    spawnCodegen: (outputPath, baseUrl, options: RecorderStartOptions) => {
      log.push(`spawn:${baseUrl}:${outputPath}:${JSON.stringify(options)}`);
      return child;
    },
    readOutput: (outputPath) => {
      log.push(`read:${outputPath}`);
      return code;
    },
    discardOutput: (outputPath) => {
      log.push(`discard:${outputPath}`);
    },
    makeOutputPath: () => "/tmp/playtest-codegen-test.js",
    // Deterministic start: no real timer, and an immediate exit check.
    waitMs: () => Promise.resolve(),
    startGracePeriodMs: 0,
  };
}

describe("parseCodegenOutput (PLAN §7, M15)", () => {
  it("maps goto/fill/click/select/check/press/wait/asserts in file order", () => {
    const { steps, unsupported } = parseCodegenOutput(SAMPLE);
    const actions = steps.map((s) => s.action);
    expect(actions).toEqual([
      "goto",
      "fill",
      "fill",
      "click",
      "select",
      "check",
      "press",
      "assert-visible",
      "assert-visible",
      "assert-text",
      "wait",
    ]);
    steps.forEach((step, index) => {
      expect(step.order).toBe(index);
    });
    expect(steps[0]?.value).toBe("https://example.com/login");
    expect(steps[1]).toMatchObject({ selector: "getByLabel('Email')", value: "ada@example.com" });
    expect(steps[3]?.selector).toBe("getByRole('button', { name: 'Sign in' })");
    expect(steps[4]).toMatchObject({ selector: "locator('#country')", value: "IN" });
    expect(steps[6]).toMatchObject({ selector: "locator('#search')", value: "Enter" });
    expect(steps[10]).toMatchObject({ value: "500" });
    expect(unsupported).toEqual([]);
  });

  it("maps new inputs and assertions (uncheck/dblclick/type/hover/focus)", () => {
    const { steps, unsupported } = parseCodegenOutput(
      [
        "await page.locator('#c').uncheck();",
        "await page.locator('#c').setChecked(false);",
        "await page.locator('#c').setChecked(true);",
        "await page.locator('#b').dblclick();",
        "await page.locator('#t').pressSequentially('hi');",
        "await page.locator('#h').hover();",
        "await page.locator('#f').focus();",
        "await page.locator('#r').click({ button: 'right' });",
        "await expect(page.locator('#h')).toBeHidden();",
        "await expect(page.locator('#d')).toBeDisabled();",
        "await expect(page.locator('#n')).toHaveValue('Ada');",
        "await expect(page.locator('.row')).toHaveCount(3);",
        "await expect(page).toHaveURL('/dashboard');",
        "await expect(page).toHaveTitle('Dashboard');",
      ].join("\n"),
    );
    expect(steps.map((s) => s.action)).toEqual([
      "uncheck",
      "uncheck",
      "check",
      "dblclick",
      "type",
      "hover",
      "focus",
      "click",
      "assert-hidden",
      "assert-disabled",
      "assert-value",
      "assert-count",
      "assert-url",
      "assert-title",
    ]);
    // Click options now ride the JSON value the runner's `parseClickValue` reads.
    expect(steps[7]).toMatchObject({ value: '{"button":"right"}' });
    expect(steps[10]).toMatchObject({ value: "Ada" });
    expect(steps[11]).toMatchObject({ value: "3" });
    expect(unsupported).toEqual([]);
  });

  it("encodes click button/modifiers/force/clickCount and leaves a plain click value-less", () => {
    const { steps } = parseCodegenOutput(
      [
        "await page.locator('#a').click();",
        "await page.locator('#b').click({ button: 'middle' });",
        "await page.locator('#c').click({ modifiers: ['Shift', 'Control'] });",
        "await page.locator('#d').click({ clickCount: 2 });",
        "await page.locator('#e').click({ force: true, modifiers: ['ControlOrMeta'] });",
      ].join("\n"),
    );
    expect(steps[0]?.value).toBeUndefined();
    expect(steps[1]?.value).toBe('{"button":"middle"}');
    expect(JSON.parse(steps[2]?.value ?? "{}")).toEqual({ modifiers: ["Shift", "Control"] });
    expect(JSON.parse(steps[3]?.value ?? "{}")).toEqual({ clickCount: 2 });
    expect(JSON.parse(steps[4]?.value ?? "{}")).toEqual({
      force: true,
      modifiers: ["ControlOrMeta"],
    });
  });

  it("marks the click a popup wait was recorded for and drops the bookkeeping (M16)", () => {
    const { steps, unsupported } = parseCodegenOutput(
      [
        "await page.goto('https://example.com/');",
        "const page1Promise = page.waitForEvent('popup');",
        "await page.getByRole('link', { name: 'Open in a new tab' }).click();",
        "const page1 = await page1Promise;",
      ].join("\n"),
    );
    expect(steps.map((s) => s.action)).toEqual(["goto", "click"]);
    expect(steps[0]?.value).toBe("https://example.com/");
    expect(steps[1]).toMatchObject({
      selector: "getByRole('link', { name: 'Open in a new tab' })",
      value: '{"popup":true}',
    });
    // The `waitForEvent`/`await …Promise` lines are neither steps nor unsupported.
    expect(unsupported).toEqual([]);
  });

  it("marks the click a download wait was recorded for (M16)", () => {
    const { steps, unsupported } = parseCodegenOutput(
      [
        "const downloadPromise = page.waitForEvent('download');",
        "await page.getByRole('link', { name: 'Download' }).click();",
        "const download = await downloadPromise;",
      ].join("\n"),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      action: "click",
      selector: "getByRole('link', { name: 'Download' })",
      value: '{"download":true}',
    });
    expect(unsupported).toEqual([]);
  });

  it("merges the popup marker into an existing click-option JSON (M16)", () => {
    const { steps, unsupported } = parseCodegenOutput(
      [
        "const page2Promise = page.waitForEvent('popup');",
        "await page.getByRole('button').click({ button: 'right', modifiers: ['Shift'] });",
        "const page2 = await page2Promise;",
      ].join("\n"),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]?.value).toBe('{"button":"right","modifiers":["Shift"],"popup":true}');
    expect(unsupported).toEqual([]);
  });

  it("handles the inline single-line and multi-line Promise.all popup forms (M16)", () => {
    const single = parseCodegenOutput(
      "const [page1] = await Promise.all([page.waitForEvent('popup'), page.getByRole('link', { name: 'Open' }).click()]);",
    );
    expect(single.steps).toHaveLength(1);
    expect(single.steps[0]).toMatchObject({
      action: "click",
      selector: "getByRole('link', { name: 'Open' })",
      value: '{"popup":true}',
    });
    expect(single.unsupported).toEqual([]);

    const multi = parseCodegenOutput(
      [
        "const [page1] = await Promise.all([",
        "  page.waitForEvent('download'),",
        "  page.getByRole('link', { name: 'Download' }).click()",
        "]);",
      ].join("\n"),
    );
    expect(multi.steps).toHaveLength(1);
    expect(multi.steps[0]).toMatchObject({
      action: "click",
      selector: "getByRole('link', { name: 'Download' })",
      value: '{"download":true}',
    });
    expect(multi.unsupported).toEqual([]);
  });

  it("leaves a plain click value-less and only marks the click a wait precedes (M16)", () => {
    const { steps, unsupported } = parseCodegenOutput(
      [
        "const page1Promise = page.waitForEvent('popup');",
        "await page.locator('#a').click();",
        "const page1 = await page1Promise;",
        "await page.locator('#b').click();",
      ].join("\n"),
    );
    expect(steps).toHaveLength(2);
    expect(steps[0]?.value).toBe('{"popup":true}');
    expect(steps[1]?.value).toBeUndefined();
    expect(unsupported).toEqual([]);
  });

  it("does not mark a click when the wait is followed by another step (M16)", () => {
    const { steps, unsupported } = parseCodegenOutput(
      [
        "const page1Promise = page.waitForEvent('popup');",
        "await page.locator('#a').fill('x');",
        "await page.locator('#b').click();",
      ].join("\n"),
    );
    expect(steps.map((s) => s.action)).toEqual(["fill", "click"]);
    expect(steps[1]?.value).toBeUndefined();
    expect(unsupported).toEqual([]);
  });

  it("records the popup page's later interactions after adopting the settled alias (M16)", () => {
    const { steps, unsupported } = parseCodegenOutput(
      [
        "const page1Promise = page.waitForEvent('popup');",
        "await page.getByRole('link', { name: 'Sign in' }).click();",
        "const page1 = await page1Promise;",
        "await page1.getByRole('textbox', { name: 'Password' }).fill('pw');",
        "await page1.getByRole('button', { name: 'Sign in' }).click();",
        "await expect(page1.getByRole('heading', { name: 'Welcome' })).toBeVisible();",
      ].join("\n"),
    );
    // The two bookkeeping lines yield neither a step nor an unsupported entry.
    expect(steps.map((s) => s.action)).toEqual(["click", "fill", "click", "assert-visible"]);
    expect(steps.map((s) => s.order)).toEqual([0, 1, 2, 3]);
    expect(steps[0]).toMatchObject({
      action: "click",
      selector: "getByRole('link', { name: 'Sign in' })",
      value: '{"popup":true}',
    });
    expect(steps[1]).toMatchObject({
      action: "fill",
      selector: "getByRole('textbox', { name: 'Password' })",
      value: "pw",
    });
    expect(steps[2]).toMatchObject({
      action: "click",
      selector: "getByRole('button', { name: 'Sign in' })",
      value: undefined,
    });
    expect(steps[3]).toMatchObject({
      action: "assert-visible",
      selector: "getByRole('heading', { name: 'Welcome' })",
    });
    expect(unsupported).toEqual([]);
  });

  it("ignores a page-variable statement when no popup was booked (unchanged behaviour, M16)", () => {
    const { steps, unsupported } = parseCodegenOutput(
      [
        "await page1.getByRole('button', { name: 'Sign in' }).click();",
        "await page1.getByLabel('Email').fill('a@b.c');",
      ].join("\n"),
    );
    // No alias adoption without a popup booking: `page1.` is not `page.`, so the
    // gate in `parseLine` drops the lines silently (not reported as unsupported).
    expect(steps).toEqual([]);
    expect(unsupported).toEqual([]);
  });

  it("never adopts a download variable as a page alias (M16)", () => {
    const { steps, unsupported } = parseCodegenOutput(
      [
        "const downloadPromise = page.waitForEvent('download');",
        "await page.getByRole('link', { name: 'Download' }).click();",
        "const download = await downloadPromise;",
        "await download.suggestedFilename();",
        "await download.getByRole('button', { name: 'Save' }).click();",
      ].join("\n"),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      action: "click",
      selector: "getByRole('link', { name: 'Download' })",
      value: '{"download":true}',
    });
    expect(unsupported).toEqual([]);
  });

  it("maps the M15 action vocabulary (text-exact/attribute/attached/nav/upload/drag/select-object)", () => {
    const { steps, unsupported } = parseCodegenOutput(
      [
        "await expect(page.getByText('Hi')).toContainText('Hi');",
        "await expect(page.getByText('Hi')).toHaveText('Hi');",
        "await expect(page.locator('.row')).toHaveText(['a', 'b']);",
        "await expect(page.locator('#x')).toHaveAttribute('data-state', 'open');",
        "await expect(page.locator('#x')).toHaveAttribute('class', /row-\\d+/);",
        "await expect(page.locator('#x')).toBeAttached();",
        "await page.reload();",
        "await page.goBack();",
        "await page.goForward();",
        "await page.locator('#file').setInputFiles('/tmp/a.txt');",
        "await page.locator('#file').setInputFiles(['/tmp/a.txt', '/tmp/b.txt']);",
        "await page.locator('#src').dragTo(page.locator('#dst'));",
        "await page.getByLabel('Country').selectOption({ label: 'IN' });",
        "await page.getByLabel('Country').selectOption({ index: 2 });",
        "await page.getByLabel('Tags').selectOption([{ label: 'A' }, { label: 'B' }]);",
      ].join("\n"),
    );
    expect(steps.map((s) => s.action)).toEqual([
      "assert-text",
      "assert-text-exact",
      "assert-text-exact",
      "assert-attribute",
      "assert-attribute",
      "assert-attached",
      "reload",
      "go-back",
      "go-forward",
      "upload",
      "upload",
      "drag",
      "select",
      "select",
      "select",
    ]);
    expect(steps[0]).toMatchObject({ selector: "getByText('Hi')", value: "Hi" });
    expect(steps[1]).toMatchObject({ selector: "getByText('Hi')", value: "Hi" });
    expect(steps[2]?.value).toBe('["a","b"]');
    expect(steps[3]?.value).toBe("data-state=open");
    expect(steps[4]?.value).toBe("class=/row-\\d+/");
    expect(steps[5]?.selector).toBe("locator('#x')");
    expect(steps[6]?.value).toBeUndefined();
    expect(steps[9]?.value).toBe("/tmp/a.txt");
    expect(steps[10]?.value).toBe('["/tmp/a.txt","/tmp/b.txt"]');
    expect(steps[11]).toMatchObject({ selector: "locator('#src')", value: "locator('#dst')" });
    expect(steps[12]?.value).toBe('{"label":"IN"}');
    expect(steps[13]?.value).toBe('{"index":2}');
    expect(steps[14]?.value).toBe('[{"label":"A"},{"label":"B"}]');
    expect(unsupported).toEqual([]);
  });

  it("reports unknown page/expect statements instead of converting them", () => {
    const { steps, unsupported } = parseCodegenOutput(
      [
        "await page.request.get('https://api.test/health');",
        "await page.screenshot({ path: 'a.png' });",
        "await expect(page.locator('#x')).toHaveCSS('color', 'red');",
      ].join("\n"),
    );
    expect(steps).toEqual([]);
    expect(unsupported).toHaveLength(3);
    expect(unsupported[0]).toMatchObject({
      line: "page.request.get('https://api.test/health')",
      reason: "page.request.get(...) is not supported — add a manual step",
    });
    expect(unsupported[1]?.reason).toContain("page.screenshot(...)");
    expect(unsupported[2]?.reason).toBe(
      "expect(...).toHaveCSS() is not supported — add a manual step",
    );
  });

  it("skips boilerplate and returns dense orders", () => {
    const { steps, unsupported } = parseCodegenOutput(
      "import { test } from 'x';\n\ntest('t', async () => {\n});\n",
    );
    expect(steps).toEqual([]);
    expect(unsupported).toEqual([]);
  });
});

describe("CodegenRecorder lifecycle", () => {
  it("starts once, stops with parsed steps, and cleans up the tmp file", async () => {
    const log: string[] = [];
    const recorder = new CodegenRecorder(fakeDeps(SAMPLE, log));
    expect(recorder.isRunning()).toBe(false);

    await expect(recorder.start("https://example.com")).resolves.toEqual({ pid: 4242 });
    expect(recorder.isRunning()).toBe(true);
    await expect(recorder.start("https://example.com")).rejects.toThrow(
      RecorderAlreadyRunningError,
    );

    const result = recorder.stop();
    expect(result.steps).toHaveLength(11);
    expect(result.unsupported).toEqual([]);
    expect(result.raw).toContain("page.goto");
    expect(recorder.isRunning()).toBe(false);
    expect(log).toContain("kill:SIGTERM");
    expect(log.some((entry) => entry.startsWith("discard:"))).toBe(true);
  });

  it("stops cleanly when codegen wrote nothing (closed without acting)", async () => {
    const log: string[] = [];
    const deps = fakeDeps("", log);
    deps.readOutput = () => null;
    const recorder = new CodegenRecorder(deps);
    await recorder.start("https://example.com");
    const result = recorder.stop();
    expect(result.steps).toEqual([]);
    expect(result.unsupported).toEqual([]);
    expect(result.raw).toBe("");
  });

  it("throws RecorderStartError with the stderr tail when codegen exits early (M15)", async () => {
    const log: string[] = [];
    const deps: RecorderDeps = {
      ...fakeDeps(SAMPLE, log),
      spawnCodegen: () =>
        fakeChild(log, {
          hasExited: () => true,
          stderrTail: () => "Error: browser not installed",
        }),
      waitMs: (ms) => {
        log.push(`wait:${ms}`);
        return Promise.resolve();
      },
      startGracePeriodMs: 1500,
    };
    const recorder = new CodegenRecorder(deps);
    await expect(recorder.start("https://example.com")).rejects.toThrow(RecorderStartError);
    await expect(recorder.start("https://example.com")).rejects.toThrow(/browser not installed/);
    expect(log).toContain("wait:1500");
    expect(recorder.isRunning()).toBe(false);
  });

  it("throws when codegen spawns without a pid", async () => {
    const recorder = new CodegenRecorder({
      ...fakeDeps(SAMPLE, []),
      spawnCodegen: () => fakeChild([], { pid: undefined }),
    });
    await expect(recorder.start("https://example.com")).rejects.toThrow(/no pid/);
  });

  it("throws when stopping with no active session", () => {
    const recorder = new CodegenRecorder(fakeDeps("", []));
    expect(() => recorder.stop()).toThrow(RecorderNotRunningError);
  });
});

/**
 * A db + tmp artifacts root with a project (baseUrl) and one case — the shape
 * `recorder:start({caseId})` resolves from (M14).
 */
function recorderFixture(): {
  handle: DatabaseHandle;
  root: string;
  projectId: string;
  caseId: string;
} {
  const handle = createDatabase(":memory:");
  const root = mkdtempSync(join(tmpdir(), "playtest-recorder-"));
  const project = createProject(handle.db, { name: "P", baseUrl: "https://example.com" });
  const testCase = createCase(handle.db, { projectId: project.id, name: "C" });
  return { handle, root, projectId: project.id, caseId: testCase.id };
}

function fakeIpc(): {
  handle: IpcHandleFn;
  listeners: Map<string, (payload: unknown) => unknown>;
} {
  const listeners = new Map<string, (payload: unknown) => unknown>();
  return {
    handle: (channel, listener) => {
      listeners.set(channel, listener);
    },
    listeners,
  };
}

describe("registerRecorderHandlers", () => {
  it("resolves baseUrl + the case profile and returns parsed steps through the fake IPC surface", async () => {
    const { registerRecorderHandlers } = await import("../src/main/ipc-register.js");
    const fx = recorderFixture();
    try {
      const ipc = fakeIpc();
      const recorder = new CodegenRecorder(fakeDeps(SAMPLE, []));
      registerRecorderHandlers(ipc.handle, fx.handle.db, {
        artifactsRoot: fx.root,
        recorder,
      });

      const start = ipc.listeners.get("recorder:start");
      const stop = ipc.listeners.get("recorder:stop");
      expect(start).toBeDefined();
      expect(stop).toBeDefined();
      // `{caseId}` only — baseUrl + options come from the project + profile.
      // `recorder:start` is async (M15): the promise resolves to the pid.
      await expect(start?.({ caseId: fx.caseId })).resolves.toEqual({ pid: 4242 });
      expect(() => start?.({ caseId: "ghost" })).toThrow();
      expect(() => start?.({ caseId: "" })).toThrow();

      const result = stop?.({}) as { steps: unknown[]; unsupported: unknown[]; raw: string };
      expect(result.steps).toHaveLength(11);
      expect(result.unsupported).toEqual([]);
      expect(result.raw).toContain("page.goto");
    } finally {
      fx.handle.close();
    }
  });
});

describe("buildCodegenArgs (M9, PLAN §18.2)", () => {
  const phones = new Set(["iPhone 11", "Pixel 5"]);

  it("emits only base args when no options are set", () => {
    expect(buildCodegenArgs("https://example.com", "/tmp/out.js", {}, phones)).toEqual([
      "https://example.com",
      "--output",
      "/tmp/out.js",
    ]);
  });

  it("maps every option to its verified codegen flag", () => {
    expect(
      buildCodegenArgs(
        "https://example.com",
        "/tmp/out.js",
        {
          viewport: { width: 390, height: 844 },
          device: "iPhone 11",
          colorScheme: "dark",
          locale: "en-GB",
          timezone: "Europe/Rome",
          storageStatePath: "/tmp/logged-in.json",
          saveStoragePath: "/tmp/save-here.json",
        },
        phones,
      ),
    ).toEqual([
      "https://example.com",
      "--output",
      "/tmp/out.js",
      "--viewport-size",
      "390,844",
      "--device",
      "iPhone 11",
      "--color-scheme",
      "dark",
      "--lang",
      "en-GB",
      "--timezone",
      "Europe/Rome",
      "--load-storage",
      "/tmp/logged-in.json",
      "--save-storage",
      "/tmp/save-here.json",
    ]);
  });

  it("rejects unknown devices with a clear error", () => {
    expect(() =>
      buildCodegenArgs("https://e.com", "/tmp/o.js", { device: "Nokia 3310" }, phones),
    ).toThrow(UnknownRecorderDeviceError);
    expect(() =>
      buildCodegenArgs("https://e.com", "/tmp/o.js", { device: "Nokia 3310" }, phones),
    ).toThrow(/use a Playwright device name/);
  });

  it("rejects flag-looking values that would escape their flag (no shell, but minimist still eats --foo)", () => {
    expect(() =>
      buildCodegenArgs("https://e.com", "/tmp/o.js", { device: "--output /evil" }),
    ).toThrow(/must not look like a CLI flag/);
    expect(() =>
      buildCodegenArgs("https://e.com", "/tmp/o.js", { timezone: "--save-storage=x" }),
    ).toThrow(/invalid timezone/);
    expect(() =>
      buildCodegenArgs("https://e.com", "/tmp/o.js", { saveStoragePath: "-evil" }),
    ).toThrow(/must be a path/);
  });

  it("rejects out-of-range viewports, bad locales, and bad schemes", () => {
    expect(() =>
      buildCodegenArgs("https://e.com", "/tmp/o.js", { viewport: { width: 10, height: 10 } }),
    ).toThrow(/invalid viewport/);
    expect(() =>
      buildCodegenArgs("https://e.com", "/tmp/o.js", { locale: "not a locale!!" }),
    ).toThrow(/invalid locale/);
    expect(() =>
      buildCodegenArgs("https://e.com", "/tmp/o.js", { colorScheme: "sepia" as "dark" }),
    ).toThrow(/invalid colorScheme/);
  });
});

describe("CodegenRecorder options pass-through (M9)", () => {
  it("forwards emulation options to spawnCodegen", async () => {
    const log: string[] = [];
    const recorder = new CodegenRecorder(fakeDeps(SAMPLE, log));
    await recorder.start("https://example.com", {
      viewport: { width: 390, height: 844 },
      colorScheme: "dark",
    });
    expect(log.some((entry) => entry.includes('"viewport":{"width":390,"height":844}'))).toBe(true);
    expect(log.some((entry) => entry.includes('"colorScheme":"dark"'))).toBe(true);
    recorder.stop();
  });

  it("records with iPhone-ish viewport + dark scheme and parses the same steps", async () => {
    const recorder = new CodegenRecorder(fakeDeps(SAMPLE, []));
    await recorder.start("https://example.com", {
      viewport: { width: 390, height: 844 },
      device: undefined,
      colorScheme: "dark",
    });
    const result = recorder.stop();
    expect(result.steps.map((s) => s.action)).toEqual([
      "goto",
      "fill",
      "fill",
      "click",
      "select",
      "check",
      "press",
      "assert-visible",
      "assert-visible",
      "assert-text",
      "wait",
    ]);
  });
});

describe("registerRecorderHandlers profile resolution (M14)", () => {
  function capturingRecorder(seen: RecorderStartOptions[]): CodegenRecorder {
    const capturing: RecorderDeps = {
      ...fakeDeps(SAMPLE, []),
      spawnCodegen: (_outputPath, _baseUrl, options) => {
        seen.push(options);
        return fakeChild([]);
      },
    };
    return new CodegenRecorder(capturing);
  }

  it("maps the profile onto the recorder options and reaches the codegen spawn", async () => {
    const { registerRecorderHandlers } = await import("../src/main/ipc-register.js");
    const fx = recorderFixture();
    try {
      const authDir = authStateDir(fx.root, fx.projectId);
      mkdirSync(authDir, { recursive: true });
      writeFileSync(join(authDir, "login.json"), "{}");
      setCaseProfile(fx.handle.db, fx.caseId, {
        viewportW: 390,
        viewportH: 844,
        device: "iPhone 11",
        colorScheme: "dark",
        locale: "en-GB",
        timezone: "Europe/Rome",
        storageState: "login.json",
        saveStorageState: "after.json",
      });
      const seen: RecorderStartOptions[] = [];
      const recorder = capturingRecorder(seen);
      const ipc = fakeIpc();
      registerRecorderHandlers(ipc.handle, fx.handle.db, {
        artifactsRoot: fx.root,
        recorder,
      });

      await expect(ipc.listeners.get("recorder:start")?.({ caseId: fx.caseId })).resolves.toEqual({
        pid: 4242,
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        viewport: { width: 390, height: 844 },
        device: "iPhone 11",
        colorScheme: "dark",
        locale: "en-GB",
        timezone: "Europe/Rome",
        storageStatePath: join(authDir, "login.json"),
        saveStoragePath: join(authDir, "after.json"),
      });
      // The save-state target directory is created so codegen can write it.
      expect(existsSync(authDir)).toBe(true);
      recorder.stop();
    } finally {
      fx.handle.close();
    }
  });

  it("throws MissingAuthStateError before spawning when the auth file is gone", async () => {
    const { registerRecorderHandlers } = await import("../src/main/ipc-register.js");
    const fx = recorderFixture();
    try {
      setCaseProfile(fx.handle.db, fx.caseId, { storageState: "ghost.json" });
      const seen: RecorderStartOptions[] = [];
      const recorder = capturingRecorder(seen);
      const ipc = fakeIpc();
      registerRecorderHandlers(ipc.handle, fx.handle.db, {
        artifactsRoot: fx.root,
        recorder,
      });

      expect(() => ipc.listeners.get("recorder:start")?.({ caseId: fx.caseId })).toThrow(
        MissingAuthStateError,
      );
      expect(seen).toHaveLength(0);
      expect(recorder.isRunning()).toBe(false);
    } finally {
      fx.handle.close();
    }
  });

  it("rejects when neither the case nor the project has a URL", async () => {
    const { registerRecorderHandlers } = await import("../src/main/ipc-register.js");
    const handle = createDatabase(":memory:");
    try {
      const root = mkdtempSync(join(tmpdir(), "playtest-recorder-"));
      const project = createProject(handle.db, { name: "No URL" });
      const testCase = createCase(handle.db, { projectId: project.id, name: "C" });
      const ipc = fakeIpc();
      const recorder = new CodegenRecorder(fakeDeps(SAMPLE, []));
      registerRecorderHandlers(ipc.handle, handle.db, { artifactsRoot: root, recorder });
      expect(() => ipc.listeners.get("recorder:start")?.({ caseId: testCase.id })).toThrow(
        /set one before recording/,
      );
    } finally {
      handle.close();
    }
  });

  it("treats a half-filled viewport as unset and validates the caseId payload", async () => {
    const { registerRecorderHandlers } = await import("../src/main/ipc-register.js");
    const fx = recorderFixture();
    try {
      const seen: RecorderStartOptions[] = [];
      const recorder = capturingRecorder(seen);
      const ipc = fakeIpc();
      registerRecorderHandlers(ipc.handle, fx.handle.db, {
        artifactsRoot: fx.root,
        recorder,
      });
      const start = ipc.listeners.get("recorder:start");

      // A device-only profile leaves viewport unset (the mapping only maps a
      // complete width/height pair).
      setCaseProfile(fx.handle.db, fx.caseId, { device: "iPhone 11" });
      await start?.({ caseId: fx.caseId });
      expect(seen[0]?.viewport).toBeUndefined();
      expect(seen[0]?.device).toBe("iPhone 11");
      recorder.stop();

      // The payload carries only `{caseId}` (M14) — empty or mistyped rejects.
      expect(() => start?.({})).toThrow();
      expect(() => start?.({ caseId: 42 })).toThrow();
    } finally {
      fx.handle.close();
    }
  });
});

describe("resolveRecorderStartOptions URL precedence (M14)", () => {
  it("prefers the case url over the project baseUrl (both trimmed)", async () => {
    const { resolveRecorderStartOptions } = await import("../src/main/ipc-register.js");
    const handle = createDatabase(":memory:");
    try {
      const root = mkdtempSync(join(tmpdir(), "playtest-recorder-"));
      const project = createProject(handle.db, { name: "P", baseUrl: "https://project.test" });
      const testCase = createCase(handle.db, {
        projectId: project.id,
        name: "C",
        url: "  https://case.test  ",
      });
      expect(resolveRecorderStartOptions(handle.db, root, testCase.id).baseUrl).toBe(
        "https://case.test",
      );
    } finally {
      handle.close();
    }
  });

  it("falls back to the project baseUrl when the case url is null or empty", async () => {
    const { resolveRecorderStartOptions } = await import("../src/main/ipc-register.js");
    const handle = createDatabase(":memory:");
    try {
      const root = mkdtempSync(join(tmpdir(), "playtest-recorder-"));
      const project = createProject(handle.db, { name: "P", baseUrl: "  https://project.test  " });
      const testCase = createCase(handle.db, { projectId: project.id, name: "C" });
      // No case url → the project baseUrl (trimmed) is used.
      expect(resolveRecorderStartOptions(handle.db, root, testCase.id).baseUrl).toBe(
        "https://project.test",
      );
      // A whitespace-only case url is still "unset" → same fallback.
      updateCase(handle.db, { id: testCase.id, url: "   " });
      expect(resolveRecorderStartOptions(handle.db, root, testCase.id).baseUrl).toBe(
        "https://project.test",
      );
    } finally {
      handle.close();
    }
  });

  it("throws when neither the case nor the project has a URL", async () => {
    const { resolveRecorderStartOptions } = await import("../src/main/ipc-register.js");
    const handle = createDatabase(":memory:");
    try {
      const root = mkdtempSync(join(tmpdir(), "playtest-recorder-"));
      const project = createProject(handle.db, { name: "P" });
      const testCase = createCase(handle.db, { projectId: project.id, name: "C" });
      expect(() => resolveRecorderStartOptions(handle.db, root, testCase.id)).toThrow(
        /set one before recording/,
      );
    } finally {
      handle.close();
    }
  });
});
