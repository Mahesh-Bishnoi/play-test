import { describe, expect, it } from "vitest";

import type { CodegenChild, RecorderDeps } from "../src/main/recorder.js";
import type { RecorderStartOptions } from "../src/shared/ipc-contract.js";
import {
  CodegenRecorder,
  RecorderAlreadyRunningError,
  RecorderNotRunningError,
  buildCodegenArgs,
  parseCodegenOutput,
} from "../src/main/recorder.js";
import { UnknownRecorderDeviceError } from "../src/main/recorder.js";

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

function fakeDeps(code: string, log: string[]): RecorderDeps {
  const child: CodegenChild = {
    pid: 4242,
    kill: (signal) => {
      log.push(`kill:${signal ?? ""}`);
      return true;
    },
  };
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
  };
}

describe("parseCodegenOutput (PLAN §7)", () => {
  it("maps goto/fill/click/select/check/press/wait/asserts in file order", () => {
    const steps = parseCodegenOutput(SAMPLE);
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
  });

  it("maps new inputs and assertions (uncheck/dblclick/type/hover/focus)", () => {
    const steps = parseCodegenOutput(
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
    expect(steps[7]).toMatchObject({ value: "right" });
    expect(steps[10]).toMatchObject({ value: "Ada" });
    expect(steps[11]).toMatchObject({ value: "3" });
  });

  it("keeps unknown page statements as wait steps instead of dropping them", () => {
    const steps = parseCodegenOutput("await page.screenshot({ path: 'a.png' });\n");
    expect(steps).toHaveLength(1);
    expect(steps[0]?.action).toBe("wait");
    expect(steps[0]?.value).toContain("screenshot");
  });

  it("skips boilerplate and returns dense orders", () => {
    const steps = parseCodegenOutput("import { test } from 'x';\n\ntest('t', async () => {\n});\n");
    expect(steps).toEqual([]);
  });
});

describe("CodegenRecorder lifecycle", () => {
  it("starts once, stops with parsed steps, and cleans up the tmp file", () => {
    const log: string[] = [];
    const recorder = new CodegenRecorder(fakeDeps(SAMPLE, log));
    expect(recorder.isRunning()).toBe(false);

    expect(recorder.start("https://example.com")).toEqual({ pid: 4242 });
    expect(recorder.isRunning()).toBe(true);
    expect(() => recorder.start("https://example.com")).toThrow(RecorderAlreadyRunningError);

    const result = recorder.stop();
    expect(result.steps).toHaveLength(11);
    expect(result.raw).toContain("page.goto");
    expect(recorder.isRunning()).toBe(false);
    expect(log).toContain("kill:SIGTERM");
    expect(log.some((entry) => entry.startsWith("discard:"))).toBe(true);
  });

  it("stops cleanly when codegen wrote nothing (closed without acting)", () => {
    const log: string[] = [];
    const deps = fakeDeps("", log);
    deps.readOutput = () => null;
    const recorder = new CodegenRecorder(deps);
    recorder.start("https://example.com");
    const result = recorder.stop();
    expect(result.steps).toEqual([]);
    expect(result.raw).toBe("");
  });

  it("throws when stopping with no active session", () => {
    const recorder = new CodegenRecorder(fakeDeps("", []));
    expect(() => recorder.stop()).toThrow(RecorderNotRunningError);
  });
});

describe("registerRecorderHandlers", () => {
  it("validates payloads and returns parsed steps through the fake IPC surface", async () => {
    const { registerRecorderHandlers } = await import("../src/main/ipc-register.js");
    const listeners = new Map<string, (payload: unknown) => unknown>();
    const recorder = new CodegenRecorder(fakeDeps(SAMPLE, []));
    registerRecorderHandlers((channel, listener) => {
      listeners.set(channel, listener);
    }, recorder);

    const start = listeners.get("recorder:start");
    const stop = listeners.get("recorder:stop");
    expect(start).toBeDefined();
    expect(stop).toBeDefined();
    expect(start?.({ baseUrl: "https://example.com" })).toEqual({ pid: 4242 });
    expect(() => start?.({ baseUrl: "" })).toThrow();

    const result = stop?.({}) as { steps: unknown[]; raw: string };
    expect(result.steps).toHaveLength(11);
    expect(result.raw).toContain("page.goto");
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
  it("forwards emulation options to spawnCodegen", () => {
    const log: string[] = [];
    const recorder = new CodegenRecorder(fakeDeps(SAMPLE, log));
    recorder.start("https://example.com", {
      viewport: { width: 390, height: 844 },
      colorScheme: "dark",
    });
    expect(log.some((entry) => entry.includes('"viewport":{"width":390,"height":844}'))).toBe(true);
    expect(log.some((entry) => entry.includes('"colorScheme":"dark"'))).toBe(true);
    recorder.stop();
  });

  it("records with iPhone-ish viewport + dark scheme and parses the same steps", () => {
    const recorder = new CodegenRecorder(fakeDeps(SAMPLE, []));
    recorder.start("https://example.com", {
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

describe("registerRecorderHandlers options boundary (M9)", () => {
  it("accepts full emulation options and rejects injection at the boundary", async () => {
    const { registerRecorderHandlers } = await import("../src/main/ipc-register.js");
    const listeners = new Map<string, (payload: unknown) => unknown>();
    const seen: RecorderStartOptions[] = [];
    const capturing: RecorderDeps = {
      ...fakeDeps(SAMPLE, []),
      spawnCodegen: (_outputPath, _baseUrl, options) => {
        seen.push(options);
        return { pid: 4242, kill: () => true };
      },
    };
    const recorder = new CodegenRecorder(capturing);
    registerRecorderHandlers((channel, listener) => {
      listeners.set(channel, listener);
    }, recorder);

    const start = listeners.get("recorder:start");
    expect(
      start?.({
        baseUrl: "https://example.com",
        viewport: { width: 390, height: 844 },
        device: "iPhone 11",
        colorScheme: "dark",
        locale: "en-GB",
        timezone: "Europe/Rome",
        storageStatePath: "/tmp/in.json",
        saveStoragePath: "/tmp/out.json",
      }),
    ).toEqual({ pid: 4242 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ device: "iPhone 11", colorScheme: "dark", locale: "en-GB" });
    recorder.stop();

    expect(() => start?.({ baseUrl: "https://example.com", device: "--output /evil" })).toThrow();
    expect(() =>
      start?.({ baseUrl: "https://example.com", viewport: { width: 5, height: 5 } }),
    ).toThrow();
    expect(() => start?.({ baseUrl: "https://example.com", colorScheme: "sepia" })).toThrow();
  });
});
