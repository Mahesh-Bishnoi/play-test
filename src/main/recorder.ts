import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { devices } from "playwright";

import type { RecorderStartOptions, RecorderUnsupported } from "../shared/ipc-contract.js";
import { splitTopLevel } from "../shared/locator-allowlist.js";
import type { TestStep } from "../shared/step-types.js";
import { resolvePlaywrightCli, spawnPlaywrightCli } from "./playwright-cli.js";
import type { PlaywrightCliChild } from "./playwright-cli.js";

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

/**
 * Thrown when codegen exits during the start grace period — bad argv, a
 * missing Playwright install, or a browser launch failure (M15 item 5). The
 * child's stderr tail is carried in the message so the UI can show the cause
 * instead of a silent no-op window.
 */
export class RecorderStartError extends Error {
  constructor(stderrTail: string) {
    const detail = stderrTail.trim();
    super(
      detail === ""
        ? "playwright codegen exited before it was ready — check the Playwright install"
        : `playwright codegen exited before it was ready:\n${detail}`,
    );
    this.name = "RecorderStartError";
  }
}

export interface ParsedRecording {
  steps: TestStep[];
  /** Codegen lines that matched no mapping — reported, never silently converted (M15). */
  unsupported: RecorderUnsupported[];
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
  // Unescape `\\` first (via a placeholder): otherwise a literal backslash-n
  // in the recorded value would become a real newline below.
  return inner
    .replace(/\\\\/g, "\uE000")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\`/g, "`")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\uE000/g, "\\");
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
 * Select value: a JSON array for multi-select, else a JSON object for the
 * `{ label | value | index }` form, else the first quoted string.
 * A JSON array may mix plain strings and `{ … }` option objects; each element
 * round-trips to `parseSelectValue` in the runner.
 */
function terminalSelectValue(stmt: string): string | undefined {
  const raw = terminalArgs(stmt, "selectOption");
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") {
      return undefined;
    }
    const values: Array<string | Record<string, string | number>> = [];
    for (const part of splitTopLevel(inner, ",")) {
      const object = selectObjectLiteral(part);
      if (object !== undefined) {
        values.push(object);
        continue;
      }
      const text = part.trim();
      if (!isQuotedLiteral(text)) {
        // Not a shape the runner understands — fall back to the legacy
        // single-string extraction so nothing is silently dropped.
        return terminalStringArg(stmt, "selectOption");
      }
      values.push(unquote(text));
    }
    if (values.length > 0) {
      return JSON.stringify(values);
    }
  }
  const object = selectObjectLiteral(trimmed);
  if (object !== undefined) {
    return JSON.stringify(object);
  }
  return terminalStringArg(stmt, "selectOption");
}

/** Text inside the *terminal* call's parentheses (`''` for a bare call). */
function terminalArgs(stmt: string, terminal: string): string | undefined {
  const marker = `.${terminal}(`;
  const idx = stmt.lastIndexOf(marker);
  if (idx === -1) {
    return undefined;
  }
  const start = idx + marker.length;
  // The terminal call closes the statement (codegen emits one call per line),
  // so its argument text ends at the final `)`.
  const end = stmt.lastIndexOf(")");
  return (end > start ? stmt.slice(start, end) : stmt.slice(start)).trim();
}

/** Inner text of a call, quote-aware, given the index just after its `(`. */
function balancedCallInner(text: string, start: number): string | undefined {
  let depth = 1;
  let quote: string | null = null;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i);
      }
    }
  }
  return undefined;
}

/**
 * Locator source inside `expect(page.<chain>)` — the full chain including its
 * closing `)` (e.g. `locator('#x')`), or undefined when the subject is not a
 * `page.` locator.
 */
function expectTarget(stmt: string): string | undefined {
  const marker = "expect(";
  const idx = stmt.indexOf(marker);
  if (idx === -1) {
    return undefined;
  }
  const inner = balancedCallInner(stmt, idx + marker.length);
  if (inner === undefined) {
    return undefined;
  }
  const trimmed = inner.trim();
  if (!trimmed.startsWith("page.")) {
    return undefined;
  }
  return pageChainSource(trimmed);
}

/** True when `text` is a single/double/backtick-quoted literal. */
function isQuotedLiteral(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) {
    return false;
  }
  const first = trimmed[0] as string;
  const last = trimmed[trimmed.length - 1] as string;
  return (
    (first === "'" && last === "'") ||
    (first === '"' && last === '"') ||
    (first === "`" && last === "`")
  );
}

/** A JS literal as its string value: quoted → unescaped, otherwise verbatim. */
function literalText(text: string): string {
  const trimmed = text.trim();
  return isQuotedLiteral(trimmed) ? unquote(trimmed) : trimmed;
}

/** `['a', 'b']` → `['a', 'b']` (strings only); undefined for other literals. */
function stringArrayLiteral(raw: string): string[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return undefined;
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") {
    return [];
  }
  const out: string[] = [];
  for (const part of splitTopLevel(inner, ",")) {
    const text = part.trim();
    if (!isQuotedLiteral(text)) {
      return undefined;
    }
    out.push(unquote(text));
  }
  return out;
}

/** `{ label: 'IN', index: 2 }` → `{ label: "IN", index: 2 }` (JS object literal). */
function selectObjectLiteral(raw: string): Record<string, string | number> | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  const inner = trimmed.slice(1, -1).trim();
  const out: Record<string, string | number> = {};
  if (inner === "") {
    return out;
  }
  for (const part of splitTopLevel(inner, ",")) {
    const colon = part.indexOf(":");
    if (colon === -1) {
      return undefined;
    }
    const key = literalText(part.slice(0, colon));
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
      return undefined;
    }
    const valueText = part.slice(colon + 1).trim();
    if (isQuotedLiteral(valueText)) {
      out[key] = unquote(valueText);
    } else if (/^-?\d+(?:\.\d+)?$/.test(valueText)) {
      out[key] = Number(valueText);
    } else {
      return undefined;
    }
  }
  return out;
}

/** Click modifiers the runner accepts (kept in sync with `parseClickValue`). */
const CLICK_MODIFIERS: ReadonlySet<string> = new Set([
  "Alt",
  "Control",
  "ControlOrMeta",
  "Meta",
  "Shift",
]);

/**
 * Click option encoding: a JSON object (`{"button":"right","modifiers":…,
 * "clickCount":2,"force":true}`) when any option is present, else undefined so
 * a plain `.click()` stays value-less (runner's `parseClickValue`).
 */
function clickValueFrom(stmt: string): string | undefined {
  const args = terminalArgs(stmt, "click");
  if (args === undefined || !/button:|modifiers:|force:|clickCount:/.test(args)) {
    return undefined;
  }
  const options: Record<string, unknown> = {};
  const button = /button:\s*['"](right|middle)['"]/.exec(args)?.[1];
  if (button !== undefined) {
    options["button"] = button;
  }
  if (/force:\s*true/.test(args)) {
    options["force"] = true;
  }
  const count = /clickCount:\s*(\d+)/.exec(args)?.[1];
  if (count !== undefined && Number(count) >= 1) {
    options["clickCount"] = Number(count);
  }
  const modifiers = /modifiers:\s*\[([^\]]*)\]/.exec(args)?.[1];
  if (modifiers !== undefined) {
    const valid = modifiers
      .split(",")
      .map((m) => literalText(m))
      .filter((m) => CLICK_MODIFIERS.has(m));
    if (valid.length > 0) {
      options["modifiers"] = valid;
    }
  }
  return Object.keys(options).length === 0 ? undefined : JSON.stringify(options);
}

/** `toHaveAttribute('name', 'value' | /re/)` → `name=value` / `name=/re/flags`. */
function attributeValueFrom(stmt: string): string | undefined {
  const args = terminalArgs(stmt, "toHaveAttribute");
  if (args === undefined) {
    return undefined;
  }
  const parts = splitTopLevel(args, ",");
  const name = parts[0] === undefined ? "" : literalText(parts[0]);
  if (name === "") {
    return undefined;
  }
  const expected = (parts[1] ?? "").trim();
  return expected === "" ? name : `${name}=${literalText(expected)}`;
}

/** Text matcher value: a JSON array for multi-element, else the first string. */
function textValueFrom(stmt: string, terminal: string): string | undefined {
  const raw = terminalArgs(stmt, terminal);
  if (raw === undefined) {
    return undefined;
  }
  const list = stringArrayLiteral(raw);
  if (list !== undefined) {
    return JSON.stringify(list);
  }
  return terminalStringArg(stmt, terminal);
}

/** Upload value: a path, or a JSON array of paths (`setInputFiles`). */
function uploadValueFrom(stmt: string): string | undefined {
  const raw = terminalArgs(stmt, "setInputFiles");
  if (raw === undefined) {
    return undefined;
  }
  const list = stringArrayLiteral(raw);
  return list !== undefined ? JSON.stringify(list) : literalText(raw);
}

/** The `page.`-relative locator chain of an expression, e.g. a `dragTo` target. */
function pageChainSource(expr: string): string | undefined {
  const trimmed = expr.trim();
  if (trimmed === "") {
    return undefined;
  }
  const pageIdx = trimmed.indexOf("page.");
  const source = (pageIdx === -1 ? trimmed : trimmed.slice(pageIdx + "page.".length)).trim();
  return source === "" ? undefined : source;
}

/**
 * Short human reason for an unmapped line (M15): names the offending call so
 * the user knows what to add as a manual step.
 */
function unsupportedFor(stmt: string): RecorderUnsupported {
  if (stmt.includes("expect(")) {
    const matcher = /\)\.([A-Za-z][A-Za-z0-9]*)\s*\(/.exec(stmt)?.[1];
    if (matcher !== undefined) {
      return {
        line: stmt,
        reason: `expect(...).${matcher}() is not supported — add a manual step`,
      };
    }
  }
  const pageCall = /\b(page\.[A-Za-z0-9_$.]+?)\s*\(/.exec(stmt)?.[1];
  if (pageCall !== undefined) {
    return { line: stmt, reason: `${pageCall}(...) is not supported — add a manual step` };
  }
  return { line: stmt, reason: "statement is not supported — add a manual step" };
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
  if (!head.includes("page.")) {
    return undefined;
  }
  return pageChainSource(head);
}

/** One parsed line: a recognised step, an unsupported statement, or null (boilerplate). */
type ParsedLine =
  | { kind: "step"; step: Omit<TestStep, "order"> }
  | { kind: "unsupported"; entry: RecorderUnsupported };

/**
 * Parse one codegen statement. Distinguishes three cases (M15):
 *  (a) a recognised step → `{ kind: "step", step }`;
 *  (b) a `page.` / `expect(` statement no pattern matches →
 *      `{ kind: "unsupported", entry }` (reported, never silently converted);
 *  (c) boilerplate (imports, test scaffolding, braces, comments, blanks) → null.
 */
function parseLine(line: string): ParsedLine | null {
  const raw = line.trim();
  const stmt = raw.replace(/^await\s+/, "").replace(/;\s*$/, "");
  if (stmt === "" || stmt.startsWith("//")) {
    return null;
  }
  if (!stmt.includes("page.") && !stmt.startsWith("expect(") && !stmt.includes(" expect(")) {
    return null;
  }
  const asStep = (step: Omit<TestStep, "order">): ParsedLine => ({ kind: "step", step });

  // Navigation: page.goto('https://…') / page.reload() / goBack() / goForward()
  if (/\.goto\(/.test(stmt)) {
    return asStep({ action: "goto", value: terminalStringArg(stmt, "goto") });
  }
  if (/\.reload\(/.test(stmt)) {
    return asStep({ action: "reload" });
  }
  if (/\.goBack\(/.test(stmt)) {
    return asStep({ action: "go-back" });
  }
  if (/\.goForward\(/.test(stmt)) {
    return asStep({ action: "go-forward" });
  }
  // Text entry: locator.fill('…')
  if (/\.fill\(/.test(stmt)) {
    return asStep({
      action: "fill",
      selector: locatorSource(stmt, "fill"),
      value: terminalStringArg(stmt, "fill"),
    });
  }
  // Dropdown: locator.selectOption('…' | ['a','b'] | { label|value|index })
  if (/\.selectOption\(/.test(stmt)) {
    return asStep({
      action: "select",
      selector: locatorSource(stmt, "selectOption"),
      value: terminalSelectValue(stmt),
    });
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
      return asStep(
        /setChecked\(\s*false/.test(stmt)
          ? { action: "uncheck", selector }
          : { action: "check", selector },
      );
    }
    return asStep(
      terminal === "check" ? { action: "check", selector } : { action: "uncheck", selector },
    );
  }
  // Keyboard: locator.press('Enter') / page.keyboard.press('Enter')
  if (/\.press\(/.test(stmt)) {
    return asStep({
      action: "press",
      selector: locatorSource(stmt, "press"),
      value: terminalStringArg(stmt, "press"),
    });
  }
  // Char-by-char typing: locator.pressSequentially('…') / locator.type('…')
  if (/\.pressSequentially\(/.test(stmt) || /\.type\(/.test(stmt)) {
    const terminal = /\.pressSequentially\(/.test(stmt) ? "pressSequentially" : "type";
    return asStep({
      action: "type",
      selector: locatorSource(stmt, terminal),
      value: terminalStringArg(stmt, terminal),
    });
  }
  // Hover / focus
  if (/\.hover\(/.test(stmt)) {
    return asStep({ action: "hover", selector: locatorSource(stmt, "hover") });
  }
  if (/\.focus\(/.test(stmt)) {
    return asStep({ action: "focus", selector: locatorSource(stmt, "focus") });
  }
  // Drag: sourceLocator.dragTo(targetLocator) — source selector, target value.
  if (/\.dragTo\(/.test(stmt)) {
    return asStep({
      action: "drag",
      selector: locatorSource(stmt, "dragTo"),
      value: pageChainSource(terminalArgs(stmt, "dragTo") ?? ""),
    });
  }
  // File upload: locator.setInputFiles('path' | ['a', 'b'])
  if (/\.setInputFiles\(/.test(stmt)) {
    return asStep({
      action: "upload",
      selector: locatorSource(stmt, "setInputFiles"),
      value: uploadValueFrom(stmt),
    });
  }
  // Click: locator.click() — options (button/modifiers/force/clickCount) as JSON.
  if (/\.click\(/.test(stmt)) {
    return asStep({
      action: "click",
      selector: locatorSource(stmt, "click"),
      value: clickValueFrom(stmt),
    });
  }
  // Explicit waits: page.waitForTimeout(500)
  if (/\.waitForTimeout\(/.test(stmt)) {
    const num = /waitForTimeout\(\s*(\d+)/.exec(stmt)?.[1];
    return asStep({ action: "wait", value: num });
  }
  // Visibility wait: locator.waitFor() — hidden/detached waits assert absence.
  if (/\.waitFor\(/.test(stmt)) {
    if (/state:\s*['"](hidden|detached)['"]/.test(stmt)) {
      return asStep({ action: "assert-hidden", selector: locatorSource(stmt, "waitFor") });
    }
    return asStep({ action: "assert-visible", selector: locatorSource(stmt, "waitFor") });
  }
  // Assertions: expect(locator).toBeVisible() / toContainText('…') / …
  if (stmt.includes("expect(")) {
    const target = expectTarget(stmt);
    if (/toBeHidden/.test(stmt)) {
      return asStep({ action: "assert-hidden", selector: target });
    }
    if (/toBeDisabled/.test(stmt)) {
      return asStep({ action: "assert-disabled", selector: target });
    }
    if (/toBeEditable/.test(stmt)) {
      return asStep({ action: "assert-editable", selector: target });
    }
    if (/toBeFocused/.test(stmt)) {
      return asStep({ action: "assert-focused", selector: target });
    }
    if (/toBeChecked/.test(stmt)) {
      return asStep({ action: "assert-checked", selector: target });
    }
    if (/toBeAttached/.test(stmt)) {
      return asStep({ action: "assert-attached", selector: target });
    }
    if (/toHaveValue/.test(stmt)) {
      return asStep({
        action: "assert-value",
        selector: target,
        value: terminalStringArg(stmt, "toHaveValue"),
      });
    }
    if (/toHaveCount/.test(stmt)) {
      const num = /toHaveCount\(\s*(\d+)/.exec(stmt)?.[1];
      return asStep({ action: "assert-count", selector: target, value: num });
    }
    if (/toHaveURL/.test(stmt)) {
      return asStep({ action: "assert-url", value: terminalStringArg(stmt, "toHaveURL") });
    }
    if (/toHaveTitle/.test(stmt)) {
      return asStep({ action: "assert-title", value: terminalStringArg(stmt, "toHaveTitle") });
    }
    if (/toHaveAttribute/.test(stmt)) {
      return asStep({
        action: "assert-attribute",
        selector: target,
        value: attributeValueFrom(stmt),
      });
    }
    if (/toBeVisible|toBeEnabled/.test(stmt)) {
      return asStep(
        /toBeEnabled/.test(stmt)
          ? { action: "assert-enabled", selector: target }
          : { action: "assert-visible", selector: target },
      );
    }
    if (/toContainText/.test(stmt)) {
      return asStep({
        action: "assert-text",
        selector: target,
        value: textValueFrom(stmt, "toContainText"),
      });
    }
    if (/toHaveText/.test(stmt)) {
      return asStep({
        action: "assert-text-exact",
        selector: target,
        value: textValueFrom(stmt, "toHaveText"),
      });
    }
    return { kind: "unsupported", entry: unsupportedFor(stmt) };
  }
  // dblclick is first-class (legacy click+value:"dblclick" still runs).
  if (/\.dblclick\(/.test(stmt)) {
    return asStep({ action: "dblclick", selector: locatorSource(stmt, "dblclick") });
  }

  // Unrecognised page/expect statement — report it instead of dropping data.
  return { kind: "unsupported", entry: unsupportedFor(stmt) };
}

/**
 * Parse Playwright codegen output into ordered `TestStep[]` plus the lines that
 * mapped to no step (PLAN §7 / M15). Pure: no IO. Orders are dense 0..n-1 in
 * file order; fields a pattern cannot fill are omitted (inner code treats
 * missing as unset).
 */
export function parseCodegenOutput(code: string): {
  steps: TestStep[];
  unsupported: RecorderUnsupported[];
} {
  const steps: TestStep[] = [];
  const unsupported: RecorderUnsupported[] = [];
  for (const line of code.split("\n")) {
    const parsed = parseLine(line);
    if (parsed === null) {
      continue;
    }
    if (parsed.kind === "unsupported") {
      unsupported.push(parsed.entry);
      continue;
    }
    steps.push({ ...parsed.step, order: steps.length });
  }
  return { steps, unsupported };
}

// --- Process shell -----------------------------------------------------------

/**
 * Minimal child handle the recorder manages: the shared `PlaywrightCliChild`
 * in prod, a fake in tests. `hasExited`/`stderrTail` back the start grace
 * period and `RecorderStartError` (M15 item 5).
 */
export type CodegenChild = PlaywrightCliChild;

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
  /** Sleep, injectable so the start grace period is deterministic in tests. */
  waitMs?: (ms: number) => Promise<void>;
  /** Start grace period in ms (default {@link START_GRACE_PERIOD_MS}); 0 = check immediately. */
  startGracePeriodMs?: number;
}

/** How long codegen gets to prove it stayed alive before `start` resolves. */
export const START_GRACE_PERIOD_MS = 1500;

/** Bound on the captured codegen stderr tail (chars). */
const CODEGEN_STDERR_TAIL_LIMIT = 2000;

function defaultWaitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Fallback launcher for when `playwright/cli.js` cannot be resolved (M15
 * item 5): the previous `npx playwright codegen …` spawn wrapped in the
 * `PlaywrightCliChild` shape so callers stay uniform. stderr is piped so the
 * start grace period can surface a launch failure.
 */
function spawnNpxCodegen(args: string[]): CodegenChild {
  const child: ChildProcess = spawn("npx", ["playwright", "codegen", ...args], {
    stdio: ["ignore", "ignore", "pipe"],
    shell: process.platform === "win32",
  });
  let exited = child.exitCode !== null || child.signalCode !== null;
  let stderr = "";
  child.on("exit", () => {
    exited = true;
  });
  child.on("error", (err) => {
    stderr = `${stderr}${err.message}`.slice(-CODEGEN_STDERR_TAIL_LIMIT);
    exited = true;
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${String(chunk)}`.slice(-CODEGEN_STDERR_TAIL_LIMIT);
  });
  return {
    pid: child.pid,
    kill: (signal?: string) => child.kill(signal as NodeJS.Signals | undefined),
    hasExited: () => exited,
    stderrTail: () => stderr,
  };
}

function defaultDeps(): RecorderDeps {
  return {
    spawnCodegen: (outputPath, baseUrl, options) => {
      const tail = buildCodegenArgs(baseUrl, outputPath, options, new Set(Object.keys(devices)));
      const cli = resolvePlaywrightCli();
      if (cli !== null) {
        return spawnPlaywrightCli(cli, ["codegen", ...tail], {
          stderrTailLimit: CODEGEN_STDERR_TAIL_LIMIT,
        });
      }
      return spawnNpxCodegen(tail);
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
    waitMs: defaultWaitMs,
    startGracePeriodMs: START_GRACE_PERIOD_MS,
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

  /**
   * Spawn codegen and wait out a short grace period (M15 item 5): a bad argv
   * or a missing browser makes the child exit immediately, which surfaces as
   * `RecorderStartError(stderrTail)` instead of a silently dead window.
   */
  async start(baseUrl: string, options: RecorderStartOptions = {}): Promise<{ pid: number }> {
    if (this.active !== null) {
      throw new RecorderAlreadyRunningError();
    }
    const outputPath = this.deps.makeOutputPath();
    const child = this.deps.spawnCodegen(outputPath, baseUrl, options);
    if (child.pid === undefined) {
      throw new Error("failed to launch playwright codegen (no pid)");
    }
    const graceMs = this.deps.startGracePeriodMs ?? START_GRACE_PERIOD_MS;
    if (graceMs > 0) {
      await (this.deps.waitMs ?? defaultWaitMs)(graceMs);
    }
    if (child.hasExited()) {
      throw new RecorderStartError(child.stderrTail());
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
    const { steps, unsupported } = parseCodegenOutput(raw);
    return { steps, unsupported, raw };
  }
}

/** Shared process-wide recorder (one codegen window per app, PLAN §7). */
export const sharedRecorder = new CodegenRecorder();
