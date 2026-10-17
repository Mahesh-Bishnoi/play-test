import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { devices } from "playwright";

import type { RecorderStartOptions } from "../shared/ipc-contract.js";
import type { TestStep } from "../shared/step-types.js";

/** Thrown when `device` is not a known Playwright device name. */
export class UnknownRecorderDeviceError extends Error {
  constructor(device: string) {
    super(`unknown device "${device}" — use a Playwright device name, e.g. "iPhone 11"`);
    this.name = "UnknownRecorderDeviceError";
  }
}

/** Thrown when `start` is called while a codegen window is already open. */
export class RecorderAlreadyRunningError extends Error {
  constructor() {
    super("recorder is already running — stop it before starting again");
    this.name = "RecorderAlreadyRunningError";
  }
}

/** Thrown when `stop` is called with no active codegen process. */
export class RecorderNotRunningError extends Error {
  constructor() {
    super("recorder is not running");
    this.name = "RecorderNotRunningError";
  }
}

export interface ParsedRecording {
  steps: TestStep[];
  /** Full codegen file content (empty when codegen wrote nothing). Kept for debugging. */
  raw: string;
}

/**
 * Strip surrounding single/double/backtick quotes and unescape JS string
 * escapes. Returns the inner text unchanged when not quoted.
 */
function unquote(literal: string): string {
  const text = literal.trim();
  if (text.length < 2) {
    return text;
  }
  const first = text[0] as string;
  const last = text[text.length - 1] as string;
  const quoted =
    (first === "'" && last === "'") ||
    (first === '"' && last === '"') ||
    (first === "`" && last === "`");
  if (!quoted) {
    return text;
  }
  const inner = text.slice(1, -1);
  return inner
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\`/g, "`")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

/** First quoted string argument in a call, e.g. `fill('hi')` → `hi`. */
function firstStringArg(call: string): string | undefined {
  const match = /\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/.exec(call);
  return match?.[1] === undefined ? undefined : unquote(match[1]);
}

/**
 * First quoted string argument of the *terminal* call, e.g.
 * `page.getByLabel('Email').fill('ada@x')` → `ada@x` (not `Email`).
 * Reading the whole statement would return the selector's string.
 */
function terminalStringArg(stmt: string, terminal: string): string | undefined {
  const marker = `.${terminal}(`;
  const idx = stmt.lastIndexOf(marker);
  if (idx === -1) {
    return undefined;
  }
  return firstStringArg(stmt.slice(idx + marker.length - 1));
}

/**
 * Select value: a JSON array for multi-select (`["a", "b"]`), else the first
 * quoted string (single value/label).
 */
function terminalSelectValue(stmt: string): string | undefined {
  const marker = ".selectOption(";
  const idx = stmt.lastIndexOf(marker);
  if (idx === -1) {
    return undefined;
  }
  const rest = stmt.slice(idx + marker.length).trim();
  if (rest.startsWith("[")) {
    const end = rest.indexOf("]");
    if (end !== -1) {
      try {
        const parsed: unknown = JSON.parse(rest.slice(0, end + 1));
        if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
          return JSON.stringify(parsed);
        }
      } catch {
        // Fall through to single-string extraction.
      }
    }
  }
  return terminalStringArg(stmt, "selectOption");
}

/**
 * Playwright locator source for `page.<chain>.<terminal>(...)`, e.g.
 * `page.getByRole('button').click()` → `getByRole('button')`,
 * `page.locator('#id').fill('x')` → `locator('#id')`.
 * Returns undefined for bare `page.<terminal>(...)` calls.
 */
function locatorSource(stmt: string, terminal: string): string | undefined {
  const idx = stmt.lastIndexOf(`.${terminal}(`);
  if (idx === -1) {
    return undefined;
  }
  const head = stmt.slice(0, idx);
  const pageIdx = head.indexOf("page.");
  if (pageIdx === -1) {
    return undefined;
  }
  const source = head.slice(pageIdx + "page.".length).trim();
  return source === "" ? undefined : source;
}

/**
 * Parse one codegen statement into a TestStep (sans order). Returns null for
 * boilerplate lines (imports, test scaffolding, braces) that carry no action.
 * Anything with `page.`/`expect(` that matches no known pattern becomes a
 * `wait` step holding the raw line as `value` — never drop user data (§7).
 */
function parseLine(line: string): Omit<TestStep, "order"> | null {
  const stmt = line
    .trim()
    .replace(/^await\s+/, "")
    .replace(/;\s*$/, "");
  if (stmt === "" || stmt.startsWith("//")) {
    return null;
  }
  if (!stmt.includes("page.") && !stmt.startsWith("expect(") && !stmt.includes(" expect(")) {
    return null;
  }

  // Navigation: page.goto('https://…')
  if (/\.goto\(/.test(stmt)) {
    return { action: "goto", value: terminalStringArg(stmt, "goto") };
  }
  // Text entry: locator.fill('…')
  if (/\.fill\(/.test(stmt)) {
    return {
      action: "fill",
      selector: locatorSource(stmt, "fill"),
      value: terminalStringArg(stmt, "fill"),
    };
  }
  // Dropdown: locator.selectOption('…') / selectOption(['a', 'b'])
  if (/\.selectOption\(/.test(stmt)) {
    return {
      action: "select",
      selector: locatorSource(stmt, "selectOption"),
      value: terminalSelectValue(stmt),
    };
  }
  // Checkbox: locator.check() → check, locator.uncheck()/setChecked(false) → uncheck
  if (/\.check\(/.test(stmt) || /\.uncheck\(/.test(stmt) || /\.setChecked\(/.test(stmt)) {
    const terminal = /\.check\(/.test(stmt)
      ? "check"
      : /\.uncheck\(/.test(stmt)
        ? "uncheck"
        : "setChecked";
    const selector = locatorSource(stmt, terminal);
    if (/\.setChecked\(/.test(stmt)) {
      return /setChecked\(\s*false/.test(stmt)
        ? { action: "uncheck", selector }
        : { action: "check", selector };
    }
    return terminal === "check" ? { action: "check", selector } : { action: "uncheck", selector };
  }
  // Keyboard: locator.press('Enter') / page.keyboard.press('Enter')
  if (/\.press\(/.test(stmt)) {
    return {
      action: "press",
      selector: locatorSource(stmt, "press"),
      value: terminalStringArg(stmt, "press"),
    };
  }
  // Char-by-char typing: locator.pressSequentially('…') / locator.type('…')
  if (/\.pressSequentially\(/.test(stmt) || /\.type\(/.test(stmt)) {
    const terminal = /\.pressSequentially\(/.test(stmt) ? "pressSequentially" : "type";
    return {
      action: "type",
      selector: locatorSource(stmt, terminal),
      value: terminalStringArg(stmt, terminal),
    };
  }
  // Hover / focus
  if (/\.hover\(/.test(stmt)) {
    return { action: "hover", selector: locatorSource(stmt, "hover") };
  }
  if (/\.focus\(/.test(stmt)) {
    return { action: "focus", selector: locatorSource(stmt, "focus") };
  }
  // Click: locator.click() — right/middle button encoded in value (runner parses)
  if (/\.click\(/.test(stmt)) {
    const selector = locatorSource(stmt, "click");
    if (/button:\s*['"]right['"]/.test(stmt)) {
      return { action: "click", selector, value: "right" };
    }
    if (/button:\s*['"]middle['"]/.test(stmt)) {
      return { action: "click", selector, value: "middle" };
    }
    return { action: "click", selector };
  }
  // Explicit waits: page.waitForTimeout(500)
  if (/\.waitForTimeout\(/.test(stmt)) {
    const num = /waitForTimeout\(\s*(\d+)/.exec(stmt)?.[1];
    return { action: "wait", value: num };
  }
  // Visibility wait: locator.waitFor()
  if (/\.waitFor\(/.test(stmt)) {
    return { action: "assert-visible", selector: locatorSource(stmt, "waitFor") };
  }
  // Assertions: expect(locator).toBeVisible() / toContainText('…') / toHaveText('…')
  if (stmt.includes("expect(")) {
    const target = /expect\(\s*page\.(.+?)\s*\)/.exec(stmt)?.[1] ?? locatorSource(stmt, "expect");
    if (/toBeHidden/.test(stmt)) {
      return { action: "assert-hidden", selector: target };
    }
    if (/toBeDisabled/.test(stmt)) {
      return { action: "assert-disabled", selector: target };
    }
    if (/toBeEditable/.test(stmt)) {
      return { action: "assert-editable", selector: target };
    }
    if (/toBeFocused/.test(stmt)) {
      return { action: "assert-focused", selector: target };
    }
    if (/toBeChecked/.test(stmt)) {
      return { action: "assert-checked", selector: target };
    }
    if (/toHaveValue/.test(stmt)) {
      return {
        action: "assert-value",
        selector: target,
        value: terminalStringArg(stmt, "toHaveValue"),
      };
    }
    if (/toHaveCount/.test(stmt)) {
      const num = /toHaveCount\(\s*(\d+)/.exec(stmt)?.[1];
      return { action: "assert-count", selector: target, value: num };
    }
    if (/toHaveURL/.test(stmt)) {
      return { action: "assert-url", value: terminalStringArg(stmt, "toHaveURL") };
    }
    if (/toHaveTitle/.test(stmt)) {
      return { action: "assert-title", value: terminalStringArg(stmt, "toHaveTitle") };
    }
    if (/toBeVisible|toBeAttached|toBeEnabled/.test(stmt)) {
      return /toBeEnabled/.test(stmt)
        ? { action: "assert-enabled", selector: target }
        : { action: "assert-visible", selector: target };
    }
    if (/toContainText|toHaveText/.test(stmt)) {
      const terminal = /toContainText/.test(stmt) ? "toContainText" : "toHaveText";
      return {
        action: "assert-text",
        selector: target,
        value: terminalStringArg(stmt, terminal),
      };
    }
    return { action: "assert-visible", selector: target, value: stmt.slice(0, 10000) };
  }
  // dblclick is first-class (legacy click+value:"dblclick" still runs).
  if (/\.dblclick\(/.test(stmt)) {
    return { action: "dblclick", selector: locatorSource(stmt, "dblclick") };
  }

  // Unknown page/expect statement — keep the raw line so nothing is lost.
  return { action: "wait", value: stmt.slice(0, 10000) };
}

/**
 * Parse Playwright codegen output into ordered `TestStep[]` (PLAN §7).
 * Pure: no IO. Orders are dense 0..n-1 in file order; fields that a pattern
 * cannot fill are omitted (inner code treats missing as unset).
 */
export function parseCodegenOutput(code: string): TestStep[] {
  const steps: TestStep[] = [];
  for (const line of code.split("\n")) {
    const parsed = parseLine(line);
    if (parsed !== null) {
      steps.push({ ...parsed, order: steps.length });
    }
  }
  return steps;
}

// --- Process shell -----------------------------------------------------------

/** Minimal child handle the recorder manages (real ChildProcess in prod, fake in tests). */
export interface CodegenChild {
  pid: number | undefined;
  kill: (signal?: string) => boolean;
}

/**
 * Build the argv tail for `npx playwright codegen` (everything after
 * `["playwright", "codegen"]`). Pure: no IO. Only allowlisted flags —
 * never interpolates option values into shell (caller passes the result
 * as an argv array). Throws on any invalid option, including device names
 * outside `knownDevices` (prod passes the real Playwright device table;
 * tests inject a small set).
 */
export function buildCodegenArgs(
  baseUrl: string,
  outputPath: string,
  options: RecorderStartOptions,
  knownDevices?: ReadonlySet<string>,
): string[] {
  const args = [baseUrl, "--output", outputPath];
  const viewport = options.viewport;
  if (viewport !== undefined) {
    const { width, height } = viewport;
    const valid =
      Number.isInteger(width) &&
      Number.isInteger(height) &&
      width >= 100 &&
      width <= 7680 &&
      height >= 100 &&
      height <= 4320;
    if (!valid) {
      throw new Error(
        `invalid viewport ${String(width)}x${String(height)} — width/height must be 100..7680 / 100..4320`,
      );
    }
    args.push("--viewport-size", `${width},${height}`);
  }
  if (options.device !== undefined) {
    const device = options.device;
    if (device.startsWith("-") || device.includes("--") || !/^[A-Za-z0-9 _./()+-]+$/.test(device)) {
      throw new Error(`unsafe device name "${device}" — must not look like a CLI flag`);
    }
    if (knownDevices !== undefined && !knownDevices.has(device)) {
      throw new UnknownRecorderDeviceError(device);
    }
    args.push("--device", device);
  }
  if (options.colorScheme !== undefined) {
    const scheme: string = options.colorScheme;
    if (scheme !== "light" && scheme !== "dark") {
      throw new Error(`invalid colorScheme "${scheme}" — "light" | "dark"`);
    }
    args.push("--color-scheme", options.colorScheme);
  }
  if (options.locale !== undefined) {
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(options.locale)) {
      throw new Error(`invalid locale "${options.locale}" — BCP47-like, e.g. en-GB`);
    }
    args.push("--lang", options.locale);
  }
  if (options.timezone !== undefined) {
    if (
      options.timezone.startsWith("-") ||
      !/^(?!.*\.\.)[A-Za-z0-9_+/-]+$/.test(options.timezone)
    ) {
      throw new Error(`invalid timezone "${options.timezone}" — IANA-like, e.g. Europe/Rome`);
    }
    args.push("--timezone", options.timezone);
  }
  const storageFlags = [
    ["storageStatePath", "--load-storage"],
    ["saveStoragePath", "--save-storage"],
  ] as const;
  for (const [key, flag] of storageFlags) {
    const value = options[key];
    if (value !== undefined) {
      if (value === "" || value.startsWith("-") || value.includes("\0")) {
        throw new Error(`invalid ${key} — must be a path, not a CLI flag`);
      }
      args.push(flag, value);
    }
  }
  return args;
}

export interface RecorderDeps {
  spawnCodegen: (
    outputPath: string,
    baseUrl: string,
    options: RecorderStartOptions,
  ) => CodegenChild;
  readOutput: (outputPath: string) => string | null;
  discardOutput: (outputPath: string) => void;
  makeOutputPath: () => string;
}

function defaultDeps(): RecorderDeps {
  return {
    spawnCodegen: (outputPath, baseUrl, options) => {
      const tail = buildCodegenArgs(baseUrl, outputPath, options, new Set(Object.keys(devices)));
      const child: ChildProcess = spawn("npx", ["playwright", "codegen", ...tail], {
        stdio: "ignore",
        shell: process.platform === "win32",
      });
      return { pid: child.pid, kill: (signal) => child.kill(signal as NodeJS.Signals) };
    },
    readOutput: (outputPath) => {
      try {
        return readFileSync(outputPath, "utf8");
      } catch {
        return null;
      }
    },
    discardOutput: (outputPath) => {
      try {
        unlinkSync(outputPath);
      } catch {
        // Best effort — a leftover tmp file is harmless.
      }
    },
    makeOutputPath: () => join(tmpdir(), `playtest-codegen-${randomUUID()}.js`),
  };
}

/**
 * Owns one external `playwright codegen` window (PLAN §7). Single active
 * session: `start` spawns, `stop` kills, parses the output file, and clears
 * the session. Nondeterminism (spawn/FS) is injected via `RecorderDeps` so
 * tests use fakes and prod uses `defaultDeps()`.
 */
export class CodegenRecorder {
  private readonly deps: RecorderDeps;
  private active: { pid: number; outputPath: string; child: CodegenChild } | null = null;

  constructor(deps: RecorderDeps = defaultDeps()) {
    this.deps = deps;
  }

  isRunning(): boolean {
    return this.active !== null;
  }

  activePid(): number | null {
    return this.active?.pid ?? null;
  }

  start(baseUrl: string, options: RecorderStartOptions = {}): { pid: number } {
    if (this.active !== null) {
      throw new RecorderAlreadyRunningError();
    }
    const outputPath = this.deps.makeOutputPath();
    const child = this.deps.spawnCodegen(outputPath, baseUrl, options);
    if (child.pid === undefined) {
      throw new Error("failed to launch playwright codegen (no pid)");
    }
    this.active = { pid: child.pid, outputPath, child };
    return { pid: child.pid };
  }

  stop(): ParsedRecording {
    const session = this.active;
    if (session === null) {
      throw new RecorderNotRunningError();
    }
    this.active = null;
    try {
      session.child.kill("SIGTERM");
    } catch {
      // The user may have closed codegen manually — parse what was written.
    }
    const raw = this.deps.readOutput(session.outputPath) ?? "";
    this.deps.discardOutput(session.outputPath);
    return { steps: parseCodegenOutput(raw), raw };
  }
}

/** Shared process-wide recorder (one codegen window per app, PLAN §7). */
export const sharedRecorder = new CodegenRecorder();
