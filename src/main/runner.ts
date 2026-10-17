import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { eq } from "drizzle-orm";
import { chromium, devices } from "playwright";
import { expect } from "playwright/test";
import type { Browser, BrowserContext, FrameLocator, Locator, Page } from "playwright";

import type {
  RunnerCancelPayload,
  RunnerResumePayload,
  RunnerRunSinglePayload,
} from "../shared/ipc-contract.js";
import { tryWriteSuiteHtmlReport } from "./reports.js";
import {
  RunFinishedEvent,
  RunLogEvent,
  RunnerCancelPayload as RunnerCancelSchema,
  RunnerResumePayload as RunnerResumeSchema,
  RunnerRunSinglePayload as RunnerRunSingleSchema,
} from "../shared/ipc-contract.js";
import { RunStepUpdateEvent } from "../shared/ipc-contract.js";
import type { CaseProfile, RunMode, StepRow } from "../shared/schema.js";
import {
  CHAIN_METHODS,
  PAGE_FACTORY_METHODS,
  isRegexStart,
  splitTopLevel,
} from "../shared/locator-allowlist.js";
import { MissingTestDataKeyError, substituteTestDataValue } from "../shared/step-types.js";
import type { StepStatus } from "../shared/step-types.js";
import type { AppDatabase } from "./db.js";
import { caseTracePath, caseVideoPath, ensureCaseDir, stepScreenshotPath } from "./artifacts.js";
import { getCase } from "./ipc-cases.js";
import { getCaseProfile, MissingAuthStateError, resolveAuthStatePath } from "./ipc-profiles.js";
import { getProject } from "./ipc-projects.js";
import { getTestData, listSteps } from "./ipc-steps.js";
import { caseRuns, stepRuns, suiteRuns } from "./schema.js";

// --- Seams (production + test fake counts as the two adapters) ----------------

/**
 * Minimal page surface the runner drives (PLAN §8). Production wraps a
 * Playwright `Page`; tests inject a recording fake. Timeouts pass straight
 * through — `undefined` means the Playwright default.
 */
export interface ClickStepOptions {
  button?: "left" | "right" | "middle";
  modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
  force?: boolean;
  /** Recorded `clickCount` (M15); `2` is normalised to the `double` path below. */
  clickCount?: number;
  /** Adopt the page this click opens instead of leaving it in the background (M16). */
  popup?: boolean;
  /** Save the download this click starts to the case's downloads dir (M16). */
  download?: boolean;
  /** Click at this offset inside the element instead of its centre (M17). */
  position?: { x: number; y: number };
}

export interface RunPage {
  goto(url: string, timeoutMs?: number): Promise<void>;
  click(selector: string, timeoutMs?: number, options?: ClickStepOptions): Promise<void>;
  dblclick(selector: string, timeoutMs?: number): Promise<void>;
  fill(selector: string, value: string, timeoutMs?: number): Promise<void>;
  /** `delayMs` slows the keystrokes (M17); `undefined` uses Playwright's default. */
  type(selector: string, text: string, timeoutMs?: number, delayMs?: number): Promise<void>;
  selectOption(selector: string, value: SelectOptionInput, timeoutMs?: number): Promise<void>;
  check(selector: string, timeoutMs?: number): Promise<void>;
  uncheck(selector: string, timeoutMs?: number): Promise<void>;
  hover(selector: string, timeoutMs?: number): Promise<void>;
  focus(selector: string, timeoutMs?: number): Promise<void>;
  press(selector: string | undefined, key: string, timeoutMs?: number): Promise<void>;
  assertVisible(selector: string, timeoutMs?: number): Promise<void>;
  assertHidden(selector: string, timeoutMs?: number): Promise<void>;
  assertText(selector: string, value: string, timeoutMs?: number): Promise<void>;
  assertValue(selector: string, value: string, timeoutMs?: number): Promise<void>;
  assertChecked(selector: string, timeoutMs?: number): Promise<void>;
  assertUnchecked(selector: string, timeoutMs?: number): Promise<void>;
  assertEnabled(selector: string, timeoutMs?: number): Promise<void>;
  assertDisabled(selector: string, timeoutMs?: number): Promise<void>;
  assertEditable(selector: string, timeoutMs?: number): Promise<void>;
  assertFocused(selector: string, timeoutMs?: number): Promise<void>;
  assertCount(selector: string, expected: number, timeoutMs?: number): Promise<void>;
  assertUrl(value: string, timeoutMs?: number): Promise<void>;
  /** Waits until the page URL matches `value` — a glob (`**` + `/login`) or `/regex/` (M17). */
  waitForUrl(value: string, timeoutMs?: number): Promise<void>;
  assertTitle(value: string, timeoutMs?: number): Promise<void>;
  /** Exact text match — a list matches several elements (M15). */
  assertTextExact(selector: string, value: string | string[], timeoutMs?: number): Promise<void>;
  /** `name=expected`; `expected` keeps `/re/flags` as RegExp (M15). */
  assertAttribute(
    selector: string,
    name: string,
    expected: string | RegExp,
    timeoutMs?: number,
  ): Promise<void>;
  assertAttached(selector: string, timeoutMs?: number): Promise<void>;
  reload(timeoutMs?: number): Promise<void>;
  /** Resolves false when there is no history entry (M15). */
  goBack(timeoutMs?: number): Promise<boolean>;
  goForward(timeoutMs?: number): Promise<boolean>;
  upload(selector: string, files: string | string[], timeoutMs?: number): Promise<void>;
  drag(source: string, target: string, timeoutMs?: number): Promise<void>;
  /** Scroll the element into view — lazy-loading lists, screenshot framing (M17). */
  scrollIntoView(selector: string, timeoutMs?: number): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(path: string): Promise<void>;
  /**
   * Pages currently open in the runner's browser context (M16). Drives the
   * "a click opened a new tab" warning without reaching into Playwright.
   */
  pageCount(): number;
}

/** A launched browser context plus its teardown/artifact hooks. */
export interface RunContext {
  page: RunPage;
  /** Release browser + context. Call after `saveVideo`/`discardVideo`. */
  close(): Promise<void>;
  /**
   * Persist the recording to `dest` (retain-on-failure). Closes the context so
   * Playwright finalizes the video, then `Video.saveAs`. Playwright needs the
   * browser still open, so call this before `close()`. No-op when not recording.
   */
  saveVideo(dest: string): Promise<void>;
  /**
   * Drop the recording (pass / cancel). Closes the context to finalize the
   * video, then `Video.delete`. Call before `close()`.
   */
  discardVideo(): Promise<void>;
  /** Persist the trace to `path`; `null` discards it (pass / cancel). */
  saveTrace(path: string | null): Promise<void>;
  /**
   * Persist the trace collected so far to `path` and keep recording (M13).
   * A supervised run calls this the moment it pauses on failure so the
   * evidence survives an edit-and-resume.
   */
  saveTraceChunk(path: string): Promise<void>;
  /** Open a named group in the trace, closed by `groupEnd` (M13). */
  group(name: string): Promise<void>;
  groupEnd(): Promise<void>;
}

/**
 * Run-log severity, shared by both runners' `log` and the page's injected
 * `onLog` (M16) so popup/download messages stream over `run:log`.
 */
export type RunLogLevel = "info" | "warn" | "error";

/**
 * Everything a single browser context needs, resolved per case from its profile
 * (M14, SPECS §2). `videoDir`/`title` are per-case; the rest mirror Playwright's
 * `newContext` options. `baseURL` comes from the project, not the profile.
 */
export interface ContextLaunchOptions {
  /** Playwright's raw recording dir (moved to `failed.webm` on failure). */
  videoDir: string;
  /** Trace display name (case name); tracing is per-context. */
  title: string;
  viewport?: { width: number; height: number };
  device?: string;
  colorScheme?: "light" | "dark";
  locale?: string;
  timezoneId?: string;
  storageState?: string;
  baseURL?: string;
  /**
   * sessionStorage seeded before the first script runs (M17). `origin` scopes
   * the entries to the app's origin (`null` = every origin, used when the
   * project has no base URL).
   */
  sessionState?: { origin: string | null; entries: Record<string, string> };
  dialogPolicy?: "default" | "accept" | "dismiss";
  /** Where click downloads land (M16): `<videoDir>/downloads`. */
  downloadsDir: string;
  /** Sink for click popup/download progress (M16); the runner logs over IPC. */
  onLog: (level: RunLogLevel, message: string) => void;
}

/** An open browser with a fresh-context factory (M14 launcher seam). */
export interface BrowserHandle {
  newContext(o: ContextLaunchOptions): Promise<RunContext>;
  /** Tear down the whole browser (the owner closes it, not the context). */
  close(): Promise<void>;
}

export interface BrowserLauncher {
  /**
   * One browser per run (single) or per suite worker; every case gets a fresh
   * context via `BrowserHandle.newContext` so profiles never leak across cases.
   */
  launchBrowser(headless: boolean): Promise<BrowserHandle>;
}

/**
 * Build the `ContextLaunchOptions` for one case (M14): profile emulation +
 * auth-state file (absolute path) + the project's `baseUrl`. A named auth-state
 * file that is not on disk throws `MissingAuthStateError` *before* the caller
 * launches anything, so a stale login never starts a silently-wrong run.
 */
export function contextLaunchOptionsFromProfile(input: {
  artifactsRoot: string;
  projectId: string;
  caseName: string;
  projectBaseUrl?: string;
  profile: CaseProfile | null;
  videoDir: string;
  onLog: (level: RunLogLevel, message: string) => void;
}): ContextLaunchOptions {
  const options: ContextLaunchOptions = {
    videoDir: input.videoDir,
    title: input.caseName,
    downloadsDir: join(input.videoDir, "downloads"),
    onLog: input.onLog,
  };
  if (input.projectBaseUrl !== undefined && input.projectBaseUrl !== "") {
    options.baseURL = input.projectBaseUrl;
  }
  const profile = input.profile;
  if (profile !== null) {
    // An explicit viewport wins over the device preset; only a complete pair
    // counts (Playwright needs both dimensions).
    if (profile.viewportW !== undefined && profile.viewportH !== undefined) {
      options.viewport = { width: profile.viewportW, height: profile.viewportH };
    }
    if (profile.device !== undefined) {
      options.device = profile.device;
    }
    if (profile.colorScheme !== undefined) {
      options.colorScheme = profile.colorScheme;
    }
    if (profile.locale !== undefined) {
      options.locale = profile.locale;
    }
    if (profile.timezone !== undefined) {
      options.timezoneId = profile.timezone;
    }
    if (profile.dialogPolicy !== undefined) {
      options.dialogPolicy = profile.dialogPolicy;
    }
    if (profile.storageState !== undefined) {
      const storagePath = resolveAuthStatePath(
        input.artifactsRoot,
        input.projectId,
        profile.storageState,
      );
      if (!existsSync(storagePath)) {
        throw new MissingAuthStateError(profile.storageState);
      }
      options.storageState = storagePath;
    }
    if (profile.sessionState !== undefined) {
      const sessionPath = resolveAuthStatePath(
        input.artifactsRoot,
        input.projectId,
        profile.sessionState,
      );
      if (!existsSync(sessionPath)) {
        throw new MissingAuthStateError(profile.sessionState);
      }
      options.sessionState = {
        origin: originOf(input.projectBaseUrl),
        entries: readSessionStateFile(sessionPath, profile.sessionState),
      };
    }
  }
  return options;
}

/** The origin of a URL, or `null` (apply everywhere) when it cannot be parsed. */
function originOf(url: string | undefined): string | null {
  if (url === undefined || url === "") {
    return null;
  }
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Read a sessionStorage seed file (M17): a JSON object of string → string. A
 * file in any other shape is a user error and fails loudly, naming the file.
 */
function readSessionStateFile(path: string, filename: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new StepExecutionError(
      `session state file ${filename} is not valid JSON — expected {"key":"value"}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StepExecutionError(
      `session state file ${filename} must be a JSON object of string values`,
    );
  }
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new StepExecutionError(
        `session state file ${filename} has a non-string value for "${key}"`,
      );
    }
    entries[key] = value;
  }
  return entries;
}

export type RunEventChannel = "run:step-update" | "run:log" | "run:finished";

/** Main wires this to `webContents.send`; tests collect into an array. */
export type EmitRunEvent = (channel: RunEventChannel, payload: unknown) => void;

export interface RunnerDeps {
  launchBrowser: BrowserLauncher;
  emit: EmitRunEvent;
  artifactsRoot: string;
  generateId?: () => string;
  now?: () => number;
  /** Injectable inter-step pacing (tests record calls; prod sleeps). */
  delay?: (ms: number) => Promise<void>;
  /**
   * Wired by main.ts to the SuiteRunner's active flag so a single-case run
   * refuses to start while a parallel suite owns the browsers (and vice
   * versa). Absent in unit tests, where each runner is exercised alone.
   */
  isSuiteActive?: () => boolean;
}

/** Thrown when a second run starts while one session is still open. */
export class RunAlreadyActiveError extends Error {
  constructor() {
    super("another run is already active — cancel it before starting a new one");
    this.name = "RunAlreadyActiveError";
  }
}

/** Thrown by resume when the supervised context is gone (PLAN §8). */
export class ContextClosedError extends Error {
  constructor() {
    super("context closed — full re-run required");
    this.name = "ContextClosedError";
  }
}

/** A single step that cannot execute (missing selector/value, bad wait, …). */
export class StepExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepExecutionError";
  }
}

// --- Pure helpers (unit-tested directly) --------------------------------------

/** `{{key}}` substitution applies to step `value` only (PLAN §10). */
export function substituteStepValue(
  template: string | undefined,
  data: Record<string, string>,
): string | undefined {
  if (template === undefined) {
    return undefined;
  }
  return substituteTestDataValue(template, data);
}

/**
 * Click `value` encoding (no schema change): empty = plain left-click,
 * legacy `"dblclick"` = double-click, `"right"` / `"middle"` = button,
 * `"shift"` / `"ctrl"` / `"alt"` / `"meta"` (+ `-click` / `+`-joined forms) =
 * modifiers, `"force"` = force click, `"popup"` / `"download"` = adopt the
 * opened page / save the triggered download (M16), or a JSON object like
 * `{"button":"right","modifiers":["Shift"],"force":true,"popup":true}` or
 * `{"position":{"x":10,"y":20}}` to click an offset inside the element (M17).
 * Only the JSON form can express `position` — the token form cannot.
 */
export function parseClickValue(value: string | undefined): {
  double: boolean;
  options: ClickStepOptions;
} {
  const options: ClickStepOptions = {};
  if (value === undefined || value.trim() === "") {
    return { double: false, options };
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const out: ClickStepOptions = {};
      if (parsed["button"] === "right" || parsed["button"] === "middle") {
        out.button = parsed["button"];
      }
      if (Array.isArray(parsed["modifiers"])) {
        const mods = (parsed["modifiers"] as unknown[]).filter(
          (m): m is NonNullable<ClickStepOptions["modifiers"]>[number] =>
            m === "Alt" ||
            m === "Control" ||
            m === "ControlOrMeta" ||
            m === "Meta" ||
            m === "Shift",
        );
        if (mods.length > 0) {
          out.modifiers = mods;
        }
      }
      if (parsed["force"] === true) {
        out.force = true;
      }
      if (parsed["popup"] === true) {
        out.popup = true;
      }
      if (parsed["download"] === true) {
        out.download = true;
      }
      const position = parsed["position"];
      if (
        typeof position === "object" &&
        position !== null &&
        typeof (position as Record<string, unknown>)["x"] === "number" &&
        typeof (position as Record<string, unknown>)["y"] === "number"
      ) {
        const { x, y } = position as { x: number; y: number };
        out.position = { x, y };
      }
      const count = parsed["clickCount"];
      if (typeof count === "number" && Number.isInteger(count) && count >= 1) {
        out.clickCount = count;
      }
      if (parsed["double"] === true || parsed["clickCount"] === 2) {
        return { double: true, options: out };
      }
      return { double: false, options: out };
    } catch {
      return { double: false, options };
    }
  }
  const tokens = trimmed
    .toLowerCase()
    .split(/[\s+,]+/)
    .flatMap((t) => t.split("-"));
  let double = false;
  const modifiers = new Set<NonNullable<ClickStepOptions["modifiers"]>[number]>();
  for (const token of tokens) {
    if (token === "" || token === "click") {
      continue;
    }
    if (token === "dblclick" || token === "double") {
      double = true;
    } else if (token === "right") {
      options.button = "right";
    } else if (token === "middle") {
      options.button = "middle";
    } else if (token === "shift") {
      modifiers.add("Shift");
    } else if (token === "ctrl" || token === "control") {
      modifiers.add("Control");
    } else if (token === "alt") {
      modifiers.add("Alt");
    } else if (token === "meta" || token === "mod" || token === "cmd") {
      modifiers.add("Meta");
    } else if (token === "force") {
      options.force = true;
    } else if (token === "popup") {
      options.popup = true;
    } else if (token === "download") {
      options.download = true;
    }
  }
  if (modifiers.size > 0) {
    options.modifiers = [...modifiers];
  }
  return { double, options };
}

/**
 * True when a click's `value` opts into the popup/download patterns (M16).
 * Used to scope the "opened a new tab" warning to plain clicks: a click that
 * already follows or saves the event needs no hint.
 */
function clickFollowsPageEvent(value: string | undefined): boolean {
  const { options } = parseClickValue(value);
  return options.popup === true || options.download === true;
}

/**
 * Shared value encoding for `select` (multi-select) and `assert-value`
 * (`toHaveValues`): a JSON array of strings when the value looks like one,
 * else the raw string.
 */
export function parseStringList(value: string): string | string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
        return parsed as string[];
      }
    } catch {
      // Not JSON — fall through to the single-value form.
    }
  }
  return value;
}

/**
 * `type` value encoding (M17): a JSON object `{"text":"…","delay":50}` types
 * `text` with a per-keystroke `delay`; anything else is the literal text. A
 * malformed object falls back to the literal so a stray brace never breaks a run.
 */
export function parseTypeValue(value: string | undefined): { text: string; delayMs?: number } {
  if (value === undefined) {
    return { text: "" };
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isOptions(parsed) && typeof parsed["text"] === "string") {
        const delay = parsed["delay"];
        if (typeof delay === "number" && Number.isInteger(delay) && delay >= 0) {
          return { text: parsed["text"], delayMs: delay };
        }
        return { text: parsed["text"] };
      }
    } catch {
      // Not JSON — fall through to the literal form.
    }
  }
  return { text: value };
}

/**
 * Select-option encodings the parser emits for `selectOption({label|value|index})`
 * (M15). A JSON object or an array of objects selects by label/value/index; the
 * array form drives a multi-select. Values pass straight through to Playwright.
 */
export interface SelectOptionValue {
  label?: string;
  value?: string;
  index?: number;
}

export type SelectOptionInput = string | string[] | SelectOptionValue | SelectOptionValue[];

function isSelectOptionValue(value: unknown): value is SelectOptionValue {
  if (!isOptions(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((k) => k !== "label" && k !== "value" && k !== "index")) {
    return false;
  }
  if ("label" in value && typeof value["label"] !== "string") {
    return false;
  }
  if ("value" in value && typeof value["value"] !== "string") {
    return false;
  }
  if (
    "index" in value &&
    (typeof value["index"] !== "number" || !Number.isInteger(value["index"]))
  ) {
    return false;
  }
  return true;
}

/**
 * Select `value` encoding (no schema change): a JSON array of strings selects
 * multiple options (`["a", "b"]`), a JSON object / array of objects selects by
 * `{label|value|index}` (M15, parser encoding), anything else selects the single
 * named value/label.
 */
export function parseSelectValue(value: string): SelectOptionInput {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        if (parsed.every((v) => typeof v === "string")) {
          return parsed as string[];
        }
        if (parsed.length > 0 && parsed.every(isSelectOptionValue)) {
          return parsed as SelectOptionValue[];
        }
      } else if (isSelectOptionValue(parsed)) {
        return parsed;
      }
    } catch {
      // Not JSON — fall through to the single-value form.
    }
  }
  return value;
}

/** Step-error budget — big enough for Playwright's diff + call log, bounded for the DB. */
const STEP_ERROR_MAX_CHARS = 8_000;

/**
 * Failure text for a step. Playwright's assertion errors carry the
 * Expected/Received diff and call log, so the message is kept verbatim (only
 * trailing whitespace trimmed) instead of being re-wrapped in a summary.
 */
export function formatStepError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.trimEnd().slice(0, STEP_ERROR_MAX_CHARS);
}

/** Screenshot budget before a capture is abandoned (evidence, not a verdict). */
const SCREENSHOT_TIMEOUT_MS = 10_000;
/** Total capture attempts: the first plus two retries. */
const SCREENSHOT_MAX_ATTEMPTS = 3;
/** Gap between attempts — a save racing navigation needs a beat to settle. */
const SCREENSHOT_RETRY_DELAY_MS = 250;

/**
 * Capture the per-step screenshot. A capture racing a just-triggered navigation
 * fails at the CDP protocol level ("Unable to capture screenshot"); settle
 * briefly and retry, up to two extra attempts, before giving up with a warning.
 * Never throws — screenshots are evidence, so a missing one must not flip the
 * step result. Shared by both runners so their behavior stays identical.
 */
export async function captureStepScreenshot(
  page: RunPage,
  path: string,
  onWarn: (message: string) => void,
): Promise<void> {
  for (let attempt = 1; attempt <= SCREENSHOT_MAX_ATTEMPTS; attempt++) {
    try {
      await page.screenshot(path);
      return;
    } catch {
      if (attempt === SCREENSHOT_MAX_ATTEMPTS) {
        onWarn(`screenshot failed for ${path}`);
        return;
      }
      await page.waitForTimeout(SCREENSHOT_RETRY_DELAY_MS);
    }
  }
}

/**
 * Trace-viewer step label (M13): `Step N · action — detail`, where detail is
 * the selector, or the value (URL, key, text) for selector-less steps.
 */
export function stepTraceLabel(step: {
  order: number;
  action: string;
  selector?: string;
  value?: string;
}): string {
  const detail =
    step.selector !== undefined && step.selector !== "" ? step.selector : (step.value ?? "");
  return detail === ""
    ? `Step ${step.order} · ${step.action}`
    : `Step ${step.order} · ${step.action} — ${detail}`;
}

/** Run one step inside a named trace group; the group always closes (M13). */
export async function runStepInTraceGroup(
  context: RunContext,
  label: string,
  run: () => Promise<void>,
): Promise<void> {
  await context.group(label);
  try {
    await run();
  } finally {
    await context.groupEnd();
  }
}

/**
 * Execute one substituted step against the page. Throws StepExecutionError
 * for missing required fields so the failure message tells the user exactly
 * what to fix in the step editor.
 */
export async function executeStep(
  page: RunPage,
  step: {
    order: number;
    action: StepRow["action"];
    selector?: string;
    value?: string;
    timeoutMs?: number;
  },
): Promise<void> {
  const label = `s${step.order} (${step.action})`;
  const timeoutMs = step.timeoutMs;
  switch (step.action) {
    case "goto": {
      if (step.value === undefined || step.value === "") {
        throw new StepExecutionError(`${label} needs a URL in value`);
      }
      await page.goto(step.value, timeoutMs);
      return;
    }
    case "click": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      const { double, options } = parseClickValue(step.value);
      if (double) {
        await page.dblclick(step.selector, timeoutMs);
      } else {
        await page.click(step.selector, timeoutMs, options);
      }
      return;
    }
    case "dblclick": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      await page.dblclick(step.selector, timeoutMs);
      return;
    }
    case "fill": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      if (step.value === undefined) {
        throw new StepExecutionError(`${label} needs a value`);
      }
      await page.fill(step.selector, step.value, timeoutMs);
      return;
    }
    case "select": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      if (step.value === undefined) {
        throw new StepExecutionError(`${label} needs a value`);
      }
      await page.selectOption(step.selector, parseSelectValue(step.value), timeoutMs);
      return;
    }
    case "type": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      if (step.value === undefined) {
        throw new StepExecutionError(`${label} needs a value`);
      }
      const { text, delayMs } = parseTypeValue(step.value);
      await page.type(step.selector, text, timeoutMs, delayMs);
      return;
    }
    case "check": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      await page.check(step.selector, timeoutMs);
      return;
    }
    case "uncheck": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      await page.uncheck(step.selector, timeoutMs);
      return;
    }
    case "hover": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      await page.hover(step.selector, timeoutMs);
      return;
    }
    case "focus": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      await page.focus(step.selector, timeoutMs);
      return;
    }
    case "press": {
      if (step.value === undefined || step.value === "") {
        throw new StepExecutionError(`${label} needs a key in value (e.g. Enter)`);
      }
      await page.press(step.selector, step.value, timeoutMs);
      return;
    }
    case "assert-visible": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      await page.assertVisible(step.selector, timeoutMs);
      return;
    }
    case "assert-hidden": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      await page.assertHidden(step.selector, timeoutMs);
      return;
    }
    case "assert-enabled": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      await page.assertEnabled(step.selector, timeoutMs);
      return;
    }
    case "assert-disabled": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      await page.assertDisabled(step.selector, timeoutMs);
      return;
    }
    case "assert-editable": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      await page.assertEditable(step.selector, timeoutMs);
      return;
    }
    case "assert-focused": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      await page.assertFocused(step.selector, timeoutMs);
      return;
    }
    case "assert-checked": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      await page.assertChecked(step.selector, timeoutMs);
      return;
    }
    case "assert-unchecked": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      await page.assertUnchecked(step.selector, timeoutMs);
      return;
    }
    case "assert-value": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      if (step.value === undefined) {
        throw new StepExecutionError(`${label} needs expected value in value`);
      }
      await page.assertValue(step.selector, step.value, timeoutMs);
      return;
    }
    case "assert-count": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      if (step.value === undefined || !/^\d+$/.test(step.value.trim())) {
        throw new StepExecutionError(`${label} needs an expected count in value`);
      }
      await page.assertCount(step.selector, Number.parseInt(step.value.trim(), 10), timeoutMs);
      return;
    }
    case "assert-url": {
      if (step.value === undefined || step.value === "") {
        throw new StepExecutionError(`${label} needs expected URL text in value`);
      }
      await page.assertUrl(step.value, timeoutMs);
      return;
    }
    case "assert-title": {
      if (step.value === undefined || step.value === "") {
        throw new StepExecutionError(`${label} needs expected title text in value`);
      }
      await page.assertTitle(step.value, timeoutMs);
      return;
    }
    case "assert-text": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      if (step.value === undefined) {
        throw new StepExecutionError(`${label} needs expected text in value`);
      }
      await page.assertText(step.selector, step.value, timeoutMs);
      return;
    }
    case "assert-text-exact": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      if (step.value === undefined) {
        throw new StepExecutionError(`${label} needs expected text in value`);
      }
      await page.assertTextExact(step.selector, parseStringList(step.value), timeoutMs);
      return;
    }
    case "assert-attribute": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      if (step.value === undefined) {
        throw new StepExecutionError(`${label} value must be name=expected (e.g. href=/login/)`);
      }
      // Split at the first `=`: the attribute name is the trimmed left side, the
      // rest is the expected value (`/re/flags` stays a RegExp).
      const separator = step.value.indexOf("=");
      const name = separator === -1 ? "" : step.value.slice(0, separator).trim();
      if (separator === -1 || name === "") {
        throw new StepExecutionError(`${label} value must be name=expected (e.g. href=/login/)`);
      }
      await page.assertAttribute(
        step.selector,
        name,
        parseAssertMatcher(step.value.slice(separator + 1)),
        timeoutMs,
      );
      return;
    }
    case "assert-attached": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      await page.assertAttached(step.selector, timeoutMs);
      return;
    }
    case "reload": {
      await page.reload(timeoutMs);
      return;
    }
    case "go-back": {
      if (!(await page.goBack(timeoutMs))) {
        throw new StepExecutionError(`${label} — no page history to go back to`);
      }
      return;
    }
    case "go-forward": {
      if (!(await page.goForward(timeoutMs))) {
        throw new StepExecutionError(`${label} — no page history to go forward to`);
      }
      return;
    }
    case "upload": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      if (step.value === undefined || step.value === "") {
        throw new StepExecutionError(`${label} needs a file path in value`);
      }
      const files = parseStringList(step.value);
      const paths = Array.isArray(files) ? files : [files];
      const missing = paths.filter((path) => !existsSync(path));
      if (missing.length > 0) {
        throw new StepExecutionError(
          `${label} upload path not found: ${missing.join(", ")} — fix the step or record the upload again`,
        );
      }
      await page.upload(step.selector, files, timeoutMs);
      return;
    }
    case "drag": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a source selector`);
      }
      if (step.value === undefined || step.value === "") {
        throw new StepExecutionError(`${label} needs a target locator in value`);
      }
      await page.drag(step.selector, step.value, timeoutMs);
      return;
    }
    case "wait": {
      if (step.value === undefined || !/^\d+$/.test(step.value.trim())) {
        throw new StepExecutionError(`${label} needs a duration in ms in value (e.g. 500)`);
      }
      await page.waitForTimeout(Number.parseInt(step.value.trim(), 10));
      return;
    }
    case "wait-url": {
      if (step.value === undefined || step.value === "") {
        throw new StepExecutionError(`${label} needs a URL glob or /regex/ in value`);
      }
      await page.waitForUrl(step.value, timeoutMs);
      return;
    }
    case "scroll-into-view": {
      if (step.selector === undefined || step.selector === "") {
        throw new StepExecutionError(`${label} needs a selector`);
      }
      await page.scrollIntoView(step.selector, timeoutMs);
      return;
    }
  }
}

// --- Live session ---------------------------------------------------------------

interface LiveSession {
  suiteRunId: string;
  caseRunId: string;
  caseId: string;
  projectId: string;
  mode: RunMode;
  actionDelayMs: number;
  /** One browser per run; every run uses a single fresh context (M14). */
  browser: BrowserHandle | null;
  context: RunContext | null;
  cancelled: boolean;
  busy: boolean;
  settled: boolean;
  startedAt: number;
  /** Pause snapshot: remaining steps are marked skipped if cancelled while paused. */
  pausedSteps?: StepRow[];
  pausedFromIndex?: number;
}

export interface StartedRun {
  suiteRunId: string;
  caseRunId: string;
  /** Resolves when the background execution settles (never rejects). */
  done: Promise<void>;
}

/**
 * Single-case runner (WS5 / M5, PLAN §8). One active session process-wide;
 * suite-parallel execution lands in M6. `runSingle` validates, persists the
 * run rows, launches the browser, and returns ids immediately — progress
 * streams over `run:step-update` / `run:log` / `run:finished`.
 *
 * Execution note: steps run directly against the Playwright library rather
 * than generated temp-spec files (see PLAN ledger 2026-10-16 WS5). Same
 * observable contract — per-step wrap, `{{key}}` substitution, screenshot
 * after every step, video/trace retain-on-failure — with live-context resume
 * and per-step streaming that a spec-file + reporter split cannot provide.
 */
export class SingleCaseRunner {
  private readonly db: AppDatabase;
  private readonly launchBrowser: BrowserLauncher;
  private readonly emit: EmitRunEvent;
  private readonly artifactsRoot: string;
  private readonly generateId: () => string;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly isSuiteActive: () => boolean;
  private session: LiveSession | null = null;

  constructor(db: AppDatabase, deps: RunnerDeps) {
    this.db = db;
    this.launchBrowser = deps.launchBrowser;
    this.emit = deps.emit;
    this.artifactsRoot = deps.artifactsRoot;
    this.generateId = deps.generateId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.delay = deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.isSuiteActive = deps.isSuiteActive ?? (() => false);
  }

  /** True while a single-case session (live or paused) holds its context. */
  hasActiveSession(): boolean {
    return this.session !== null;
  }

  /** Start a supervised (headed, pausable) or unsupervised (headless) single-case run. */
  runSingle(input: RunnerRunSinglePayload): StartedRun {
    const parsed = RunnerRunSingleSchema.parse(input);
    if (this.session !== null || this.isSuiteActive()) {
      throw new RunAlreadyActiveError();
    }
    const testCase = getCase(this.db, parsed.caseId);
    const steps = listSteps(this.db, parsed.caseId);
    const data = getTestData(this.db, { caseId: parsed.caseId });

    const startedAt = this.now();
    const suiteRunId = this.generateId();
    const caseRunId = this.generateId();
    const insertRunRows = (): void => {
      this.db
        .insert(suiteRuns)
        .values({ id: suiteRunId, suiteId: null, mode: parsed.mode, status: "running", startedAt })
        .run();
      this.db
        .insert(caseRuns)
        .values({ id: caseRunId, suiteRunId, caseId: parsed.caseId, status: "running" })
        .run();
    };

    if (steps.length === 0) {
      insertRunRows();
      this.finishSuite(suiteRunId, "passed");
      this.finishCase(caseRunId, "passed", startedAt);
      this.log("warn", "no steps — nothing to execute");
      this.finish(suiteRunId, { total: 1, passed: 1, failed: 0, skipped: 0 });
      return { suiteRunId, caseRunId, done: Promise.resolve() };
    }

    // Fail fast on config errors without launching a browser: the run record
    // still exists (failed step + finished event) so the graph shows red.
    const missingKey = firstMissingKey(steps, data);
    if (missingKey !== null) {
      insertRunRows();
      this.createStepRun(
        caseRunId,
        missingKey.stepId,
        missingKey.order,
        "fail",
        `missing test-data key: ${missingKey.key}`,
      );
      for (const step of steps) {
        if (step.order !== missingKey.order) {
          this.createStepRun(caseRunId, step.id, step.order, "skipped", null);
        }
      }
      this.stepEvent(caseRunId, missingKey.order, "fail");
      this.log("error", `missing test-data key: ${missingKey.key}`);
      this.finishCase(caseRunId, "failed", startedAt);
      this.finishSuite(suiteRunId, "failed");
      this.finish(suiteRunId, { total: 1, passed: 0, failed: 1, skipped: 0 });
      return { suiteRunId, caseRunId, done: Promise.resolve() };
    }

    // Resolve the run environment (M14) before writing any run row: a missing
    // auth-state file is a config error that must not leave a perpetually
    // "running" row behind (it throws synchronously to the caller).
    const caseDir = ensureCaseDir(
      this.artifactsRoot,
      testCase.projectId,
      suiteRunId,
      parsed.caseId,
    );
    const launchOptions = contextLaunchOptionsFromProfile({
      artifactsRoot: this.artifactsRoot,
      projectId: testCase.projectId,
      caseName: testCase.name,
      projectBaseUrl: getProject(this.db, testCase.projectId).baseUrl,
      profile: getCaseProfile(this.db, parsed.caseId),
      videoDir: caseDir,
      onLog: (level, msg) => this.log(level, msg),
    });
    insertRunRows();
    const session: LiveSession = {
      suiteRunId,
      caseRunId,
      caseId: parsed.caseId,
      projectId: testCase.projectId,
      mode: parsed.mode,
      actionDelayMs: parsed.actionDelayMs ?? 0,
      browser: null,
      context: null,
      cancelled: false,
      busy: true,
      settled: false,
      startedAt,
    };
    this.session = session;
    const done = (async (): Promise<void> => {
      try {
        const browser = await this.launchBrowser.launchBrowser(parsed.mode === "unsupervised");
        session.browser = browser;
        session.context = await browser.newContext(launchOptions);
        await this.executeFrom(session, steps, data, 0, startedAt);
      } catch (err) {
        await this.closeSessionResources(session);
        this.abortSession(session, steps, err instanceof Error ? err.message : String(err));
      }
    })();
    return { suiteRunId, caseRunId, done };
  }

  /**
   * Resume a paused supervised run in its live context (PLAN §8). Reloads
   * steps + test data so edits made while paused apply. The live context keeps
   * the profile it launched with (M14) — re-resolving here would change the
   * environment mid-run; anything without a live context has none to resume.
   */
  resumeFromStep(input: RunnerResumePayload): StartedRun {
    const parsed = RunnerResumeSchema.parse(input);
    const session = this.session;
    if (session === null || session.caseRunId !== parsed.caseRunId || session.context === null) {
      throw new ContextClosedError();
    }
    if (session.busy) {
      throw new RunAlreadyActiveError();
    }
    const steps = listSteps(this.db, session.caseId);
    if (parsed.fromOrder < 0 || parsed.fromOrder >= steps.length) {
      throw new ContextClosedError();
    }
    const data = getTestData(this.db, { caseId: session.caseId });
    this.clearStepRunsFrom(session.caseRunId, parsed.fromOrder);
    session.busy = true;
    session.cancelled = false;
    session.pausedSteps = undefined;
    session.pausedFromIndex = undefined;
    const startedAt = this.now();
    session.startedAt = startedAt;
    const done = (async (): Promise<void> => {
      try {
        await this.executeFrom(session, steps, data, parsed.fromOrder, startedAt);
      } catch (err) {
        this.abortSession(session, steps, err instanceof Error ? err.message : String(err));
      }
    })();
    return { suiteRunId: session.suiteRunId, caseRunId: session.caseRunId, done };
  }

  /** Flag cancellation; the loop settles between steps, or now when paused. */
  async cancelRun(input: RunnerCancelPayload): Promise<null> {
    const parsed = RunnerCancelSchema.parse(input);
    const session = this.session;
    if (session === null || session.suiteRunId !== parsed.suiteRunId) {
      return null;
    }
    session.cancelled = true;
    if (!session.busy) {
      await this.settleCancel(session, session.pausedSteps, session.pausedFromIndex);
    }
    return null;
  }

  // --- Execution loop ---------------------------------------------------------

  private async executeFrom(
    session: LiveSession,
    steps: StepRow[],
    data: Record<string, string>,
    fromOrder: number,
    startedAt: number,
  ): Promise<void> {
    const { caseRunId, suiteRunId } = session;
    for (let index = fromOrder; index < steps.length; index++) {
      const step = steps[index];
      if (step === undefined) {
        break;
      }
      if (session.cancelled) {
        await this.settleCancel(session, steps, index);
        return;
      }
      // Pre-run speed control: pace supervised runs so each headed action can
      // be followed. Skipped for the first step of each executeFrom batch so a
      // resume continues immediately rather than idling first.
      if (session.actionDelayMs > 0 && index > fromOrder) {
        await this.delay(session.actionDelayMs);
        if (session.cancelled) {
          await this.settleCancel(session, steps, index);
          return;
        }
      }
      const context = session.context;
      if (context === null) {
        throw new ContextClosedError();
      }
      const screenshotPath = stepScreenshotPath(
        this.artifactsRoot,
        session.projectId,
        suiteRunId,
        session.caseId,
        step.order,
      );
      this.createStepRun(caseRunId, step.id, step.order, "running", null);
      this.stepEvent(caseRunId, step.order, "running");
      const stepStarted = this.now();
      try {
        // Substitution inside the try: data may change while paused, so a
        // deleted key fails this step (and pauses again) instead of aborting.
        const value = substituteStepValue(step.value, data);
        // M16: a plain click that opens a tab leaves it in the background —
        // snapshot the context's page count and hint at the `popup` token
        // when it grew. Clicks that opt in (popup/download) are excluded.
        const watchPopup = step.action === "click" && !clickFollowsPageEvent(value);
        const pagesBefore = watchPopup ? context.page.pageCount() : 0;
        await runStepInTraceGroup(context, stepTraceLabel({ ...step, value }), () =>
          executeStep(context.page, { ...step, value }),
        );
        if (watchPopup && context.page.pageCount() > pagesBefore) {
          this.log(
            "warn",
            `step s${step.order} (click) opened a new page — add the "popup" token to value to follow it`,
          );
        }
        await this.captureScreenshot(context, screenshotPath);
        this.updateStepRun(caseRunId, step.id, "pass", null, screenshotPath, stepStarted);
        this.stepEvent(caseRunId, step.order, "pass");
      } catch (err) {
        const message = formatStepError(err);
        await this.captureScreenshot(context, screenshotPath);
        this.updateStepRun(caseRunId, step.id, "fail", message, screenshotPath, stepStarted);
        this.stepEvent(caseRunId, step.order, "fail");
        this.log("error", `step s${step.order} (${step.action}) failed: ${message}`);
        if (session.mode === "supervised") {
          session.busy = false;
          session.pausedSteps = steps;
          session.pausedFromIndex = index + 1;
          // Persist the failure evidence now: an edit-and-resume must not lose
          // the trace. Restarting the chunk keeps the resumed run traced too.
          try {
            await context.saveTraceChunk(
              caseTracePath(this.artifactsRoot, session.projectId, suiteRunId, session.caseId),
            );
          } catch {
            this.log("warn", "failed to save trace");
          }
          this.log("warn", `paused at step ${step.order} — edit the step and resume, or re-run`);
          return;
        }
        this.markSkippedFrom(caseRunId, steps, index + 1);
        await this.settleFailure(session, startedAt);
        return;
      }
    }
    if (session.cancelled) {
      await this.settleCancel(session, steps, steps.length);
      return;
    }
    await this.settlePass(session, startedAt);
  }

  private async settlePass(session: LiveSession, startedAt: number): Promise<void> {
    const context = session.context;
    if (context !== null) {
      try {
        await context.saveTrace(null);
      } catch {
        this.log("warn", "failed to discard trace");
      }
      await this.safeDiscardVideo(context);
    }
    await this.closeSessionResources(session);
    this.finishCase(session.caseRunId, "passed", startedAt);
    this.finishSuite(session.suiteRunId, "passed");
    this.finish(session.suiteRunId, { total: 1, passed: 1, failed: 0, skipped: 0 });
    if (this.session === session) {
      this.session = null;
    }
  }

  private async settleFailure(session: LiveSession, startedAt: number): Promise<void> {
    const context = session.context;
    let videoPath: string | null = null;
    if (context !== null) {
      const traceDest = caseTracePath(
        this.artifactsRoot,
        session.projectId,
        session.suiteRunId,
        session.caseId,
      );
      try {
        await context.saveTrace(traceDest);
      } catch {
        this.log("warn", "failed to save trace");
      }
      const videoDest = caseVideoPath(
        this.artifactsRoot,
        session.projectId,
        session.suiteRunId,
        session.caseId,
      );
      if (await this.safeSaveVideo(context, videoDest)) {
        videoPath = videoDest;
      }
    }
    await this.closeSessionResources(session);
    if (videoPath !== null) {
      this.db.update(caseRuns).set({ videoPath }).where(eq(caseRuns.id, session.caseRunId)).run();
    }
    this.finishCase(session.caseRunId, "failed", startedAt);
    this.finishSuite(session.suiteRunId, "failed");
    this.finish(session.suiteRunId, { total: 1, passed: 0, failed: 1, skipped: 0 });
    if (this.session === session) {
      this.session = null;
    }
  }

  /** Idempotent — the loop and cancelRun can both reach it. */
  private async settleCancel(
    session: LiveSession,
    steps?: StepRow[],
    fromIndex?: number,
  ): Promise<void> {
    if (session.settled) {
      return;
    }
    session.settled = true;
    if (steps !== undefined && fromIndex !== undefined) {
      this.markSkippedFrom(session.caseRunId, steps, fromIndex);
    }
    const context = session.context;
    if (context !== null) {
      try {
        await context.saveTrace(null);
      } catch {
        // Context may already be half-closed — cancellation still proceeds.
      }
      await this.safeDiscardVideo(context);
    }
    await this.closeSessionResources(session);
    this.finishCase(session.caseRunId, "cancelled", session.startedAt);
    this.finishSuite(session.suiteRunId, "cancelled");
    // Contract has no cancelled bucket — cancellation counts as skipped.
    this.finish(session.suiteRunId, { total: 1, passed: 0, failed: 0, skipped: 1 });
    this.log("warn", "run cancelled — remaining steps skipped");
    if (this.session === session) {
      this.session = null;
    }
  }

  /**
   * Close the run's context then its browser (M14: the browser outlives a
   * single context). Best-effort — teardown failures must not unseat a settled
   * run.
   */
  private async closeSessionResources(session: LiveSession): Promise<void> {
    const context = session.context;
    if (context !== null) {
      try {
        await context.close();
      } catch {
        // Already closing — nothing left to do.
      }
      session.context = null;
    }
    const browser = session.browser;
    if (browser !== null) {
      try {
        await browser.close();
      } catch {
        // Already closing — nothing left to do.
      }
      session.browser = null;
    }
  }

  /** Last-resort: background threw outside per-step handling (e.g. launch). */
  private abortSession(session: LiveSession, steps: StepRow[], message: string): void {
    if (this.session !== session) {
      return;
    }
    try {
      const rows = this.db
        .select()
        .from(stepRuns)
        .where(eq(stepRuns.caseRunId, session.caseRunId))
        .all();
      if (rows.length === 0) {
        for (const step of steps) {
          this.createStepRun(session.caseRunId, step.id, step.order, "skipped", null);
        }
      }
      this.log("error", message);
      this.finishCase(session.caseRunId, "failed", this.now());
      this.finishSuite(session.suiteRunId, "failed");
      this.finish(session.suiteRunId, { total: 1, passed: 0, failed: 1, skipped: 0 });
    } catch {
      this.log("error", message);
    } finally {
      this.session = null;
    }
  }

  // --- Small persistence / emit helpers (one effect per line) ------------------

  private createStepRun(
    caseRunId: string,
    stepId: string,
    order: number,
    status: StepStatus,
    error: string | null,
  ): void {
    this.db
      .insert(stepRuns)
      .values({ id: this.generateId(), caseRunId, stepId, order, status, error })
      .run();
  }

  private updateStepRun(
    caseRunId: string,
    stepId: string,
    status: StepStatus,
    error: string | null,
    screenshotPath: string,
    stepStarted: number,
  ): void {
    const rows = this.db.select().from(stepRuns).where(eq(stepRuns.caseRunId, caseRunId)).all();
    const row = rows.find((r) => r.stepId === stepId);
    if (row === undefined) {
      return;
    }
    this.db
      .update(stepRuns)
      .set({
        status,
        error,
        screenshotPath,
        durationMs: this.now() - stepStarted,
      })
      .where(eq(stepRuns.id, row.id))
      .run();
  }

  private clearStepRunsFrom(caseRunId: string, fromOrder: number): void {
    const rows = this.db.select().from(stepRuns).where(eq(stepRuns.caseRunId, caseRunId)).all();
    for (const row of rows) {
      if (row.order >= fromOrder) {
        this.db.delete(stepRuns).where(eq(stepRuns.id, row.id)).run();
      }
    }
  }

  private markSkippedFrom(caseRunId: string, steps: StepRow[], fromIndex: number): void {
    for (let index = fromIndex; index < steps.length; index++) {
      const step = steps[index];
      if (step === undefined) {
        break;
      }
      this.createStepRun(caseRunId, step.id, step.order, "skipped", null);
      this.stepEvent(caseRunId, step.order, "skipped");
    }
  }

  private finishCase(
    caseRunId: string,
    status: "passed" | "failed" | "cancelled",
    startedAt: number,
  ): void {
    this.db
      .update(caseRuns)
      .set({ status, durationMs: this.now() - startedAt })
      .where(eq(caseRuns.id, caseRunId))
      .run();
  }

  private finishSuite(suiteRunId: string, status: "passed" | "failed" | "cancelled"): void {
    this.db
      .update(suiteRuns)
      .set({ status, endedAt: this.now() })
      .where(eq(suiteRuns.id, suiteRunId))
      .run();
  }

  private stepEvent(caseRunId: string, order: number, status: StepStatus): void {
    this.emit("run:step-update", RunStepUpdateEvent.parse({ caseRunId, order, status }));
  }

  private log(level: "info" | "warn" | "error", msg: string): void {
    this.emit("run:log", RunLogEvent.parse({ level, msg }));
  }

  private finish(
    suiteRunId: string,
    summary: { total: number; passed: number; failed: number; skipped: number },
  ): void {
    // Report write is evidence, not verdict: best-effort before the finished
    // event so the report page can link it immediately; a write failure warns.
    tryWriteSuiteHtmlReport(this.db, this.artifactsRoot, suiteRunId, (msg) => {
      this.log("warn", msg);
    });
    this.emit("run:finished", RunFinishedEvent.parse({ suiteRunId, summary }));
  }

  // Screenshots are evidence, not verdicts: a failed capture warns, never
  // flips the step result. Awaited (not fire-and-forget) so artifacts exist
  // before the run settles — important for tests and the report page.
  private async captureScreenshot(context: RunContext, path: string): Promise<void> {
    await captureStepScreenshot(context.page, path, (message) => this.log("warn", message));
  }

  private async safeSaveVideo(context: RunContext, dest: string): Promise<boolean> {
    try {
      await context.saveVideo(dest);
      return true;
    } catch {
      return false;
    }
  }

  private async safeDiscardVideo(context: RunContext): Promise<void> {
    try {
      await context.discardVideo();
    } catch {
      // A leftover recording is harmless — the run still settles.
    }
  }
}

/** First step whose `{{key}}` has no test-data entry (fail-fast pre-scan). */
function firstMissingKey(
  steps: StepRow[],
  data: Record<string, string>,
): { stepId: string; order: number; key: string } | null {
  for (const step of steps) {
    try {
      substituteStepValue(step.value, data);
    } catch (err) {
      if (err instanceof MissingTestDataKeyError) {
        return { stepId: step.id, order: step.order, key: err.key };
      }
      throw err;
    }
  }
  return null;
}

// --- Selector resolution (recorder getBy* chains) -------------------------------

/**
 * Resolve a stored step selector to a Playwright Locator.
 *
 * The recorder keeps codegen chains verbatim (`getByRole('link', …)`,
 * `getByText(…)`, `locator('…')`, `frameLocator('…')`), which
 * `page.locator(string)` cannot parse — it expects CSS/XPath and throws
 * `Unsupported token "{" …`. Plain CSS (or Playwright engine syntax like
 * `text=…`) falls through to `page.locator`.
 *
 * A chain may enter an iframe (`page.frameLocator('#f')`) but must end on a
 * Locator — a FrameLocator is not actionable, so a chain that stops on the
 * frame fails with guidance.
 *
 * Never `eval`s the selector: the chain name allowlist below plus the strict
 * literal parser (strings/numbers/booleans/regex/objects/arrays only — no
 * calls, no identifiers, except a nested locator chain passed to
 * `filter({ has })` which is resolved recursively as data) keep recorder
 * content from becoming code execution in the main process.
 */
export function resolveLocator(page: Page, selector: string): Locator {
  const segments = splitLocatorChain(selector);
  if (segments === null) {
    return page.locator(selector);
  }
  const [first, ...rest] = segments;
  if (first === undefined) {
    throw new StepExecutionError(
      `unsupported selector "${selector}": empty — edit the step to a CSS selector or a getByRole/getByText/locator/frameLocator chain`,
    );
  }
  let current: LocatorNode;
  const factory = parseCall(first, selector);
  if (factory.name === "frameLocator") {
    current = {
      kind: "frame",
      value: page.frameLocator(frameLocatorSelector(factory.args, selector)),
    };
  } else {
    current = { kind: "locator", value: applyFactory(page, first, selector) };
  }
  for (const segment of rest) {
    current = applyChainStep(current, segment, selector, page);
  }
  if (current.kind === "frame") {
    throw new StepExecutionError(
      `unsupported selector "${selector}": a frame is not actionable — add a locator inside it (e.g. .getByRole(…))`,
    );
  }
  return current.value;
}

function unsupportedSelector(full: string, detail: string): StepExecutionError {
  return new StepExecutionError(
    `unsupported selector "${full}": ${detail} — edit the step to a CSS selector or a getByRole/getByText/locator chain`,
  );
}

/**
 * Split `getByRole(…).filter(…).first()` on top-level dots, or return null
 * when the selector is plain CSS/engine syntax (no codegen-chain head).
 * Throws StepExecutionError for chains starting with a non-locator call
 * (`page.evaluate(…)`, `frameLocator(…)`, …) so the step fails with guidance
 * instead of a CSS parse error.
 */
function splitLocatorChain(selector: string): string[] | null {
  let text = selector.trim();
  if (text.startsWith("page.")) {
    text = text.slice("page.".length).trim();
  }
  if (text === "") {
    throw new StepExecutionError("step needs a selector");
  }
  const head = /^([A-Za-z_$][\w$]*)/.exec(text)?.[1];
  if (head === undefined) {
    return null;
  }
  if (!PAGE_FACTORY_METHODS.has(head)) {
    if (/^[A-Za-z_$][\w$]*\(/.test(text)) {
      throw unsupportedSelector(selector, `"${head}(…)" is not a locator`);
    }
    return null;
  }
  const segments = splitTopLevel(text, ".");
  for (const segment of segments) {
    if (segment === "") {
      throw unsupportedSelector(selector, "empty chain segment");
    }
    const name = /^([A-Za-z_$][\w$]*)/.exec(segment)?.[1];
    if (name === undefined || !CHAIN_METHODS.has(name)) {
      throw unsupportedSelector(selector, `"${segment}" is not a supported locator step`);
    }
  }
  return segments;
}

interface ParsedCall {
  name: string;
  args: unknown[];
}

function parseCall(segment: string, full: string): ParsedCall {
  const bare = /^([A-Za-z_$][\w$]*)$/.exec(segment)?.[1];
  if (bare !== undefined) {
    return { name: bare, args: [] };
  }
  const call = /^([A-Za-z_$][\w$]*)\((.*)\)$/s.exec(segment);
  if (call?.[1] === undefined || call[2] === undefined) {
    throw unsupportedSelector(full, `cannot parse "${segment}"`);
  }
  return { name: call[1], args: parseArgList(call[2], full) };
}

function parseArgList(argsText: string, full: string): unknown[] {
  if (argsText.trim() === "") {
    return [];
  }
  if (argsText.length > 10000) {
    throw unsupportedSelector(full, "argument list too long");
  }
  return splitTopLevel(argsText, ",").map((arg) => parseJsLiteral(arg, full));
}

/**
 * Strict JS-literal parser: strings, numbers, booleans, null/undefined,
 * RegExp, arrays, and plain objects. Anything else (calls, identifiers,
 * templates with interpolation) throws — selectors must stay data.
 */
function parseJsLiteral(text: string, full: string): unknown {
  return new LiteralParser(text, full).parse();
}

class LiteralParser {
  private pos = 0;
  private nesting = 0;

  constructor(
    private readonly text: string,
    private readonly full: string,
  ) {}

  parse(): unknown {
    const value = this.parseValue();
    this.skipWs();
    if (this.pos !== this.text.length) {
      throw unsupportedSelector(this.full, `unexpected trailing text in "${this.text.trim()}"`);
    }
    return value;
  }

  private parseValue(): unknown {
    this.skipWs();
    const ch = this.text[this.pos];
    if (ch === "'" || ch === '"' || ch === "`") {
      return this.parseString();
    }
    if (ch === "/") {
      return this.parseRegex();
    }
    if (ch === "[") {
      return this.parseArray();
    }
    if (ch === "{") {
      return this.parseObject();
    }
    if (ch === "-" || (ch !== undefined && /[0-9]/.test(ch))) {
      return this.parseNumber();
    }
    // A nested locator chain (`filter({ has: page.getByText('x') })`) is data:
    // keep it as a string and resolve it later through the same allowlisted
    // parser — never eval it.
    if (this.startsLocatorChain()) {
      return this.parseChainText();
    }
    return this.parseKeyword();
  }

  /** True when the upcoming token is `page.…` or a factory call (`getByText(…`). */
  private startsLocatorChain(): boolean {
    const match = /^([A-Za-z_$][\w$]*)/.exec(this.text.slice(this.pos));
    if (match === null) {
      return false;
    }
    const name = match[1] as string;
    if (name !== "page" && !PAGE_FACTORY_METHODS.has(name)) {
      return false;
    }
    let next = this.pos + name.length;
    while (next < this.text.length && /\s/.test(this.text[next] as string)) {
      next++;
    }
    const ch = this.text[next];
    return name === "page" ? ch === "." : ch === "(" || ch === ".";
  }

  /**
   * Consume a balanced locator-chain expression (strings/regex/parens/braces
   * tracked) up to a top-level `,` / `}` / `]` and return it verbatim.
   */
  private parseChainText(): string {
    const start = this.pos;
    let depth = 0;
    let quote: string | null = null;
    let escaped = false;
    let inRegex = false;
    let inRegexClass = false;
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos] as string;
      if (quote !== null) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === quote) {
          quote = null;
        }
        this.pos++;
        continue;
      }
      if (inRegex) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "[") {
          inRegexClass = true;
        } else if (ch === "]") {
          inRegexClass = false;
        } else if (ch === "/" && !inRegexClass) {
          inRegex = false;
          while (
            this.pos + 1 < this.text.length &&
            /[a-z]/i.test(this.text[this.pos + 1] as string)
          ) {
            this.pos++;
          }
        }
        this.pos++;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
        this.pos++;
        continue;
      }
      if (ch === "/" && isRegexStart(this.text, this.pos)) {
        inRegex = true;
        this.pos++;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        depth++;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0 && (ch === "]" || ch === "}")) {
          break;
        }
        depth--;
      } else if (ch === "," && depth === 0) {
        break;
      }
      this.pos++;
    }
    const chain = this.text.slice(start, this.pos).trim();
    if (chain === "") {
      throw unsupportedSelector(this.full, "empty locator chain");
    }
    return chain;
  }

  private parseString(): string {
    const quote = this.text[this.pos] as string;
    this.pos++;
    let out = "";
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined) {
        throw unsupportedSelector(this.full, "unterminated string");
      }
      if (ch === quote) {
        this.pos++;
        return out;
      }
      if (ch === "\\") {
        out += this.parseEscape(quote);
        continue;
      }
      if (quote === "`" && ch === "$" && this.text[this.pos + 1] === "{") {
        throw unsupportedSelector(this.full, "template interpolation is not supported");
      }
      out += ch;
      this.pos++;
    }
  }

  private parseEscape(quote: string): string {
    // this.text[this.pos] is the backslash here.
    this.pos++;
    const ch = this.text[this.pos];
    if (ch === undefined) {
      throw unsupportedSelector(this.full, "unterminated escape");
    }
    this.pos++;
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "v":
        return "\v";
      case "0":
        return "\0";
      case "\\":
        return "\\";
      case "'":
        return "'";
      case '"':
        return '"';
      case "`":
        return "`";
      case "$":
        return "$";
      case "/":
        return "/";
      case "u": {
        const hex = this.text.slice(this.pos, this.pos + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw unsupportedSelector(this.full, "bad unicode escape");
        }
        this.pos += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        if (ch === quote) {
          return quote;
        }
        throw unsupportedSelector(this.full, `unsupported escape "\\${ch}"`);
    }
  }

  private parseRegex(): RegExp {
    this.pos++;
    let pattern = "";
    let inClass = false;
    let escaped = false;
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined || ch === "\n") {
        throw unsupportedSelector(this.full, "unterminated regex");
      }
      if (escaped) {
        pattern += `\\${ch}`;
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "[") {
        inClass = true;
        pattern += ch;
      } else if (ch === "]") {
        inClass = false;
        pattern += ch;
      } else if (ch === "/" && !inClass) {
        break;
      } else {
        pattern += ch;
      }
      this.pos++;
    }
    this.pos++;
    let flags = "";
    while (this.pos < this.text.length && /[a-z]/i.test(this.text[this.pos] as string)) {
      flags += this.text[this.pos];
      this.pos++;
    }
    if (/[^dgimsuvy]/.test(flags) || new Set(flags).size !== flags.length) {
      throw unsupportedSelector(this.full, `bad regex flags "/${flags}"`);
    }
    try {
      return new RegExp(pattern, flags);
    } catch {
      throw unsupportedSelector(this.full, "invalid regex");
    }
  }

  private parseArray(): unknown[] {
    this.pos++;
    this.enterNested();
    try {
      const items: unknown[] = [];
      for (;;) {
        this.skipWs();
        if (this.text[this.pos] === "]") {
          this.pos++;
          return items;
        }
        if (this.text[this.pos] === undefined) {
          throw unsupportedSelector(this.full, "unterminated array");
        }
        items.push(this.parseValue());
        this.skipWs();
        const ch = this.text[this.pos];
        if (ch === ",") {
          this.pos++;
          continue;
        }
        if (ch === "]") {
          this.pos++;
          return items;
        }
        throw unsupportedSelector(this.full, 'expected "," or "]"');
      }
    } finally {
      this.nesting--;
    }
  }

  private parseObject(): Record<string, unknown> {
    this.pos++;
    this.enterNested();
    try {
      const obj: Record<string, unknown> = {};
      for (;;) {
        this.skipWs();
        if (this.text[this.pos] === "}") {
          this.pos++;
          return obj;
        }
        if (this.text[this.pos] === undefined) {
          throw unsupportedSelector(this.full, "unterminated object");
        }
        const key = this.parseKey();
        this.skipWs();
        if (this.text[this.pos] !== ":") {
          throw unsupportedSelector(this.full, `expected ":" after key "${key}"`);
        }
        this.pos++;
        obj[key] = this.parseValue();
        this.skipWs();
        const ch = this.text[this.pos];
        if (ch === ",") {
          this.pos++;
          continue;
        }
        if (ch === "}") {
          this.pos++;
          return obj;
        }
        throw unsupportedSelector(this.full, 'expected "," or "}"');
      }
    } finally {
      this.nesting--;
    }
  }

  private enterNested(): void {
    this.nesting++;
    if (this.nesting > 20) {
      throw unsupportedSelector(this.full, "nesting too deep");
    }
  }

  private parseKey(): string {
    this.skipWs();
    const ch = this.text[this.pos];
    if (ch === "'" || ch === '"' || ch === "`") {
      return this.parseString();
    }
    const match = /^[A-Za-z_$][\w$]*/.exec(this.text.slice(this.pos));
    if (match === null) {
      throw unsupportedSelector(this.full, "bad object key");
    }
    this.pos += match[0].length;
    return match[0];
  }

  private parseNumber(): number {
    const match =
      /^-?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        this.text.slice(this.pos),
      );
    if (match === null) {
      throw unsupportedSelector(
        this.full,
        `bad number near "${this.text.slice(this.pos, this.pos + 10)}"`,
      );
    }
    this.pos += match[0].length;
    const value = Number(match[0]);
    if (Number.isNaN(value)) {
      throw unsupportedSelector(this.full, `bad number "${match[0]}"`);
    }
    return value;
  }

  private parseKeyword(): unknown {
    const match = /^[A-Za-z_$][\w$]*/.exec(this.text.slice(this.pos));
    if (match === null) {
      throw unsupportedSelector(this.full, `unexpected character "${this.text[this.pos] ?? ""}"`);
    }
    const word = match[0];
    this.pos += word.length;
    switch (word) {
      case "true":
        return true;
      case "false":
        return false;
      case "null":
        return null;
      case "undefined":
        return undefined;
      default:
        throw unsupportedSelector(this.full, `"${word}" is not a supported literal`);
    }
  }

  private skipWs(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos] as string)) {
      this.pos++;
    }
  }
}

/** A resolved chain node — a Locator (actionable) or a FrameLocator (waypoint). */
type LocatorNode = { kind: "frame"; value: FrameLocator } | { kind: "locator"; value: Locator };

/** `frameLocator('css')` needs a non-empty selector string. */
function frameLocatorSelector(args: unknown[], full: string): string {
  const [selector] = args;
  if (typeof selector !== "string" || selector === "") {
    throw unsupportedSelector(full, `frameLocator needs a selector`);
  }
  return selector;
}

/**
 * Dispatch the shared `getBy*` factories on a Page, Locator, or FrameLocator
 * (all three expose identical signatures and return a Locator). Returns null
 * when `name` is not a `getBy*` method so the caller can handle its own steps.
 */
function applyGetBy(
  host: Page | Locator | FrameLocator,
  name: string,
  args: unknown[],
  full: string,
): Locator | null {
  const target = host as Locator;
  switch (name) {
    case "getByRole": {
      const [role, options] = args;
      if (typeof role !== "string" || (options !== undefined && !isOptions(options))) {
        throw unsupportedSelector(full, `getByRole needs (role, options?)`);
      }
      return target.getByRole(
        role as Parameters<Locator["getByRole"]>[0],
        options as Parameters<Locator["getByRole"]>[1],
      );
    }
    case "getByText": {
      const [text, options] = args;
      if (
        (typeof text !== "string" && !(text instanceof RegExp)) ||
        (options !== undefined && !isOptions(options))
      ) {
        throw unsupportedSelector(full, `getByText needs (text, options?)`);
      }
      return target.getByText(text, options as Parameters<Locator["getByText"]>[1]);
    }
    case "getByLabel": {
      const [text, options] = args;
      if (
        (typeof text !== "string" && !(text instanceof RegExp)) ||
        (options !== undefined && !isOptions(options))
      ) {
        throw unsupportedSelector(full, `getByLabel needs (text, options?)`);
      }
      return target.getByLabel(text, options as Parameters<Locator["getByLabel"]>[1]);
    }
    case "getByPlaceholder": {
      const [text, options] = args;
      if (
        (typeof text !== "string" && !(text instanceof RegExp)) ||
        (options !== undefined && !isOptions(options))
      ) {
        throw unsupportedSelector(full, `getByPlaceholder needs (text, options?)`);
      }
      return target.getByPlaceholder(text, options as Parameters<Locator["getByPlaceholder"]>[1]);
    }
    case "getByAltText": {
      const [text, options] = args;
      if (
        (typeof text !== "string" && !(text instanceof RegExp)) ||
        (options !== undefined && !isOptions(options))
      ) {
        throw unsupportedSelector(full, `getByAltText needs (text, options?)`);
      }
      return target.getByAltText(text, options as Parameters<Locator["getByAltText"]>[1]);
    }
    case "getByTitle": {
      const [text, options] = args;
      if (
        (typeof text !== "string" && !(text instanceof RegExp)) ||
        (options !== undefined && !isOptions(options))
      ) {
        throw unsupportedSelector(full, `getByTitle needs (text, options?)`);
      }
      return target.getByTitle(text, options as Parameters<Locator["getByTitle"]>[1]);
    }
    case "getByTestId": {
      const [id] = args;
      if (typeof id !== "string" && !(id instanceof RegExp)) {
        throw unsupportedSelector(full, `getByTestId needs (testId)`);
      }
      return target.getByTestId(id);
    }
    default:
      return null;
  }
}

function applyFactory(page: Page, segment: string, full: string): Locator {
  const { name, args } = parseCall(segment, full);
  const found = applyGetBy(page, name, args, full);
  if (found !== null) {
    return found;
  }
  if (name === "locator") {
    const [sel, options] = args;
    if (typeof sel !== "string" || (options !== undefined && !isOptions(options))) {
      throw unsupportedSelector(full, `locator needs (selector, options?)`);
    }
    return page.locator(
      sel,
      resolveLocatorOptions(options, full, page) as Parameters<Page["locator"]>[1],
    );
  }
  throw unsupportedSelector(full, `"${name}(…)" is not a locator`);
}

/**
 * Apply one chain segment to the current node. A `FrameLocator` chain keeps
 * only the frame methods (`getBy*`, `locator`, nested `frameLocator`, `first`,
 * `last`, `nth` — no `filter`); a `Locator` chain keeps the full set.
 */
function applyChainStep(
  current: LocatorNode,
  segment: string,
  full: string,
  page: Page,
): LocatorNode {
  const { name, args } = parseCall(segment, full);
  if (current.kind === "frame") {
    return applyFrameChainStep(current.value, name, args, full, page);
  }
  return { kind: "locator", value: applyLocatorChainStep(current.value, name, args, full, page) };
}

function applyFrameChainStep(
  current: FrameLocator,
  name: string,
  args: unknown[],
  full: string,
  page: Page,
): LocatorNode {
  if (name === "frameLocator") {
    return { kind: "frame", value: current.frameLocator(frameLocatorSelector(args, full)) };
  }
  if (name === "first") {
    if (args.length !== 0) {
      throw unsupportedSelector(full, `first takes no arguments`);
    }
    return { kind: "frame", value: current.first() };
  }
  if (name === "last") {
    if (args.length !== 0) {
      throw unsupportedSelector(full, `last takes no arguments`);
    }
    return { kind: "frame", value: current.last() };
  }
  if (name === "nth") {
    const [index] = args;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      throw unsupportedSelector(full, `nth needs a non-negative integer`);
    }
    return { kind: "frame", value: current.nth(index) };
  }
  if (name === "locator") {
    const [sel, options] = args;
    if (typeof sel !== "string" || (options !== undefined && !isOptions(options))) {
      throw unsupportedSelector(full, `locator needs (selector, options?)`);
    }
    return {
      kind: "locator",
      value: current.locator(
        sel,
        resolveLocatorOptions(options, full, page) as Parameters<FrameLocator["locator"]>[1],
      ),
    };
  }
  const found = applyGetBy(current, name, args, full);
  if (found !== null) {
    return { kind: "locator", value: found };
  }
  if (name === "filter") {
    throw unsupportedSelector(
      full,
      `a frame cannot be filtered — locate an element inside the frame instead`,
    );
  }
  throw unsupportedSelector(full, `"${name}(…)" is not a supported frame locator step`);
}

function applyLocatorChainStep(
  current: Locator,
  name: string,
  args: unknown[],
  full: string,
  page: Page,
): Locator {
  const found = applyGetBy(current, name, args, full);
  if (found !== null) {
    return found;
  }
  switch (name) {
    case "locator": {
      const [sel, options] = args;
      if (typeof sel !== "string" || (options !== undefined && !isOptions(options))) {
        throw unsupportedSelector(full, `locator needs (selector, options?)`);
      }
      return current.locator(
        sel,
        resolveLocatorOptions(options, full, page) as Parameters<Locator["locator"]>[1],
      );
    }
    case "filter": {
      const [options] = args;
      if (options !== undefined && !isOptions(options)) {
        throw unsupportedSelector(full, `filter needs ({ hasText?, … })`);
      }
      return current.filter(
        resolveLocatorOptions(options, full, page) as Parameters<Locator["filter"]>[0],
      );
    }
    case "first": {
      if (args.length !== 0) {
        throw unsupportedSelector(full, `first takes no arguments`);
      }
      return current.first();
    }
    case "last": {
      if (args.length !== 0) {
        throw unsupportedSelector(full, `last takes no arguments`);
      }
      return current.last();
    }
    case "nth": {
      const [index] = args;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
        throw unsupportedSelector(full, `nth needs a non-negative integer`);
      }
      return current.nth(index);
    }
    default:
      throw unsupportedSelector(full, `"${name}(…)" is not a supported locator step`);
  }
}

function isOptions(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Locator/filter option keys the parser may emit; anything else is rejected. */
const ALLOWED_LOCATOR_OPTION_KEYS: ReadonlySet<string> = new Set([
  "has",
  "hasNot",
  "hasText",
  "hasNotText",
  "visible",
]);

/**
 * `has`/`hasNot` take a Locator, which the literal parser cannot produce — the
 * parser emits a nested locator chain string instead (M15). Resolve that chain
 * against the page (still no eval, same allowlist/parser) and hand Playwright a
 * real Locator. Unknown option keys are still rejected so recorder content
 * cannot smuggle arbitrary options through.
 */
function resolveLocatorOptions(
  options: unknown,
  full: string,
  page: Page,
): Record<string, unknown> | undefined {
  if (options === undefined) {
    return undefined;
  }
  if (!isOptions(options)) {
    throw unsupportedSelector(full, `locator options must be an object`);
  }
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (!ALLOWED_LOCATOR_OPTION_KEYS.has(key)) {
      throw unsupportedSelector(full, `unknown locator option "${key}"`);
    }
    if (key === "has" || key === "hasNot") {
      if (typeof value !== "string" || value.trim() === "") {
        throw unsupportedSelector(
          full,
          `${key} needs a locator chain string (e.g. ${key}: page.getByText('x'))`,
        );
      }
      resolved[key] = resolveLocator(page, value);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

// --- Production Playwright adapter -----------------------------------------------

/**
 * Assertion timeout default, matching Playwright's own assertion budget: every
 * `assert-*` step goes through `playwright/test`'s web-first matchers, so a
 * failure carries Playwright's Expected/Received diff and call log instead of a
 * one-line hand-rolled message.
 */
const DEFAULT_ASSERT_TIMEOUT_MS = 30_000;

class PlaywrightRunPage implements RunPage {
  /**
   * Mutable current page (M16): a `popup` click adopts the page it opened, so
   * every following step drives that page instead of the original one.
   */
  private page: Page;

  constructor(
    private readonly context: BrowserContext,
    page: Page,
    private readonly deps: {
      downloadsDir: string;
      onLog: (level: RunLogLevel, message: string) => void;
      dialogPolicy?: "default" | "accept" | "dismiss";
    },
  ) {
    this.page = page;
  }

  /** Recorder chains (`getByRole(…)`) need dispatch; plain CSS passes through. */
  private loc(selector: string): Locator {
    return resolveLocator(this.page, selector);
  }

  async goto(url: string, timeoutMs?: number): Promise<void> {
    await this.page.goto(url, { timeout: timeoutMs });
  }

  /**
   * `popup` / `download` are runner-level patterns (M16), not Playwright click
   * options — strip them before the click and arm the matching `waitForEvent`
   * promise so the click and the event race together (Playwright's own
   * `Promise.all([waitForEvent, click])` idiom).
   */
  async click(selector: string, timeoutMs?: number, options?: ClickStepOptions): Promise<void> {
    const { popup, download, ...clickOptions } = options ?? {};
    const loc = this.loc(selector);
    if (popup === true) {
      const [next] = await Promise.all([
        this.context.waitForEvent("page"),
        loc.click({ timeout: timeoutMs, ...clickOptions }),
      ]);
      // Adopt the opened page: tracing is context-level, but the profile's
      // dialog policy is attached per page, so re-attach it to the new one.
      this.page = next;
      if (this.deps.dialogPolicy !== undefined && this.deps.dialogPolicy !== "default") {
        attachDialogPolicy(next, this.deps.dialogPolicy);
      }
      this.deps.onLog("info", `popup opened: ${next.url()}`);
      return;
    }
    if (download === true) {
      const [dl] = await Promise.all([
        this.page.waitForEvent("download"),
        loc.click({ timeout: timeoutMs, ...clickOptions }),
      ]);
      mkdirSync(this.deps.downloadsDir, { recursive: true });
      const dest = join(this.deps.downloadsDir, sanitizeDownloadFilename(dl.suggestedFilename()));
      await dl.saveAs(dest);
      this.deps.onLog("info", `download saved: ${dest}`);
      return;
    }
    await loc.click({ timeout: timeoutMs, ...clickOptions });
  }

  pageCount(): number {
    return this.context.pages().length;
  }

  async dblclick(selector: string, timeoutMs?: number): Promise<void> {
    await this.loc(selector).dblclick({ timeout: timeoutMs });
  }

  async fill(selector: string, value: string, timeoutMs?: number): Promise<void> {
    await this.loc(selector).fill(value, { timeout: timeoutMs });
  }

  async type(selector: string, text: string, timeoutMs?: number, delayMs?: number): Promise<void> {
    await this.loc(selector).pressSequentially(text, {
      timeout: timeoutMs,
      ...(delayMs !== undefined ? { delay: delayMs } : {}),
    });
  }

  async selectOption(
    selector: string,
    value: SelectOptionInput,
    timeoutMs?: number,
  ): Promise<void> {
    await this.loc(selector).selectOption(value, { timeout: timeoutMs });
  }

  async check(selector: string, timeoutMs?: number): Promise<void> {
    await this.loc(selector).check({ timeout: timeoutMs });
  }

  async uncheck(selector: string, timeoutMs?: number): Promise<void> {
    await this.loc(selector).uncheck({ timeout: timeoutMs });
  }

  async hover(selector: string, timeoutMs?: number): Promise<void> {
    await this.loc(selector).hover({ timeout: timeoutMs });
  }

  async focus(selector: string, timeoutMs?: number): Promise<void> {
    await this.loc(selector).focus({ timeout: timeoutMs });
  }

  async press(selector: string | undefined, key: string, timeoutMs?: number): Promise<void> {
    if (selector === undefined || selector === "") {
      await this.page.keyboard.press(key);
    } else {
      await this.loc(selector).press(key, { timeout: timeoutMs });
    }
  }

  async assertVisible(selector: string, timeoutMs?: number): Promise<void> {
    await expect(this.loc(selector)).toBeVisible(this.assertTimeout(timeoutMs));
  }

  async assertHidden(selector: string, timeoutMs?: number): Promise<void> {
    await expect(this.loc(selector)).toBeHidden(this.assertTimeout(timeoutMs));
  }

  async assertEnabled(selector: string, timeoutMs?: number): Promise<void> {
    await expect(this.loc(selector)).toBeEnabled(this.assertTimeout(timeoutMs));
  }

  async assertDisabled(selector: string, timeoutMs?: number): Promise<void> {
    await expect(this.loc(selector)).toBeDisabled(this.assertTimeout(timeoutMs));
  }

  async assertEditable(selector: string, timeoutMs?: number): Promise<void> {
    await expect(this.loc(selector)).toBeEditable(this.assertTimeout(timeoutMs));
  }

  async assertFocused(selector: string, timeoutMs?: number): Promise<void> {
    await expect(this.loc(selector)).toBeFocused(this.assertTimeout(timeoutMs));
  }

  async assertChecked(selector: string, timeoutMs?: number): Promise<void> {
    await expect(this.loc(selector)).toBeChecked(this.assertTimeout(timeoutMs));
  }

  async assertUnchecked(selector: string, timeoutMs?: number): Promise<void> {
    await expect(this.loc(selector)).not.toBeChecked(this.assertTimeout(timeoutMs));
  }

  async assertValue(selector: string, value: string, timeoutMs?: number): Promise<void> {
    const expected = parseStringList(value);
    if (Array.isArray(expected)) {
      await expect(this.loc(selector)).toHaveValues(expected, this.assertTimeout(timeoutMs));
      return;
    }
    await expect(this.loc(selector)).toHaveValue(expected, this.assertTimeout(timeoutMs));
  }

  async assertCount(selector: string, expected: number, timeoutMs?: number): Promise<void> {
    await expect(this.loc(selector)).toHaveCount(expected, this.assertTimeout(timeoutMs));
  }

  async assertUrl(value: string, timeoutMs?: number): Promise<void> {
    await expect(this.page).toHaveURL(parseAssertMatcher(value), this.assertTimeout(timeoutMs));
  }

  /** `waitForURL` takes a glob (`**` + `/login`); `/re/flags` stays a RegExp (M17). */
  async waitForUrl(value: string, timeoutMs?: number): Promise<void> {
    await this.page.waitForURL(parseAssertMatcher(value), { timeout: timeoutMs });
  }

  async assertTitle(value: string, timeoutMs?: number): Promise<void> {
    await expect(this.page).toHaveTitle(parseAssertMatcher(value), this.assertTimeout(timeoutMs));
  }

  async assertText(selector: string, value: string, timeoutMs?: number): Promise<void> {
    await expect(this.loc(selector)).toContainText(value, this.assertTimeout(timeoutMs));
  }

  async assertTextExact(
    selector: string,
    value: string | string[],
    timeoutMs?: number,
  ): Promise<void> {
    await expect(this.loc(selector)).toHaveText(value, this.assertTimeout(timeoutMs));
  }

  async assertAttribute(
    selector: string,
    name: string,
    expected: string | RegExp,
    timeoutMs?: number,
  ): Promise<void> {
    await expect(this.loc(selector)).toHaveAttribute(name, expected, this.assertTimeout(timeoutMs));
  }

  async assertAttached(selector: string, timeoutMs?: number): Promise<void> {
    await expect(this.loc(selector)).toBeAttached(this.assertTimeout(timeoutMs));
  }

  async reload(timeoutMs?: number): Promise<void> {
    await this.page.reload({ timeout: timeoutMs });
  }

  /** `false` when there is no history entry to navigate to (M15). */
  async goBack(timeoutMs?: number): Promise<boolean> {
    return (await this.page.goBack({ timeout: timeoutMs })) !== null;
  }

  async goForward(timeoutMs?: number): Promise<boolean> {
    return (await this.page.goForward({ timeout: timeoutMs })) !== null;
  }

  async upload(selector: string, files: string | string[], timeoutMs?: number): Promise<void> {
    await this.loc(selector).setInputFiles(files, { timeout: timeoutMs });
  }

  async drag(source: string, target: string, timeoutMs?: number): Promise<void> {
    await this.loc(source).dragTo(this.loc(target), { timeout: timeoutMs });
  }

  /** Reveals the element — lazy-loading lists, screenshot framing (M17). */
  async scrollIntoView(selector: string, timeoutMs?: number): Promise<void> {
    await this.loc(selector).scrollIntoViewIfNeeded({ timeout: timeoutMs });
  }

  /** Web-first matchers default to 30 s, overridable per step (PLAN §2). */
  private assertTimeout(timeoutMs?: number): { timeout: number } {
    return { timeout: timeoutMs ?? DEFAULT_ASSERT_TIMEOUT_MS };
  }

  async waitForTimeout(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({
      path,
      animations: "disabled",
      caret: "hide",
      timeout: SCREENSHOT_TIMEOUT_MS,
    });
  }
}

class PlaywrightRunContext implements RunContext {
  private readonly context: BrowserContext;
  private readonly rawPage: Page;
  readonly page: RunPage;
  private closed = false;

  constructor(context: BrowserContext, page: Page, o: ContextLaunchOptions) {
    this.context = context;
    this.rawPage = page;
    this.page = new PlaywrightRunPage(context, page, {
      downloadsDir: o.downloadsDir,
      onLog: o.onLog,
      dialogPolicy: o.dialogPolicy,
    });
  }

  async saveVideo(dest: string): Promise<void> {
    // Finalize the recording first: Playwright's saveAs needs the browser
    // connection (it dies in browser close), and the artifact is only complete
    // once the context closes. Read the Video via the held page — the object
    // outlives the context.
    await this.close();
    const video = this.rawPage.video();
    if (video !== null) {
      await video.saveAs(dest);
    }
  }

  async discardVideo(): Promise<void> {
    await this.close();
    const video = this.rawPage.video();
    if (video !== null) {
      await video.delete();
    }
  }

  async close(): Promise<void> {
    // Only the context — the owning BrowserHandle closes the browser (M14).
    // Idempotent: saveVideo/discardVideo already closed the context.
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.context.close();
  }

  async saveTrace(path: string | null): Promise<void> {
    if (path === null) {
      await this.context.tracing.stop();
    } else {
      await this.context.tracing.stop({ path });
    }
  }

  async saveTraceChunk(path: string): Promise<void> {
    await this.context.tracing.stopChunk({ path });
    await this.context.tracing.startChunk();
  }

  async group(name: string): Promise<void> {
    await this.context.tracing.group(name);
  }

  async groupEnd(): Promise<void> {
    await this.context.tracing.groupEnd();
  }
}

/** Attach the profile's dialog policy to a page (M14); `default` = no handler. */
function attachDialogPolicy(page: Page, policy: ContextLaunchOptions["dialogPolicy"]): void {
  if (policy === "accept") {
    page.on("dialog", (dialog) => void dialog.accept());
  } else if (policy === "dismiss") {
    page.on("dialog", (dialog) => void dialog.dismiss());
  }
}

/**
 * Download destination filename (M16). `suggestedFilename()` is server-
 * controlled, so keep only the basename and neutralise any leftover path
 * separators / `..` before joining it under the case's downloads dir.
 */
function sanitizeDownloadFilename(suggested: string): string {
  const base = basename(suggested)
    .replace(/[\\/]+/g, "_")
    .replace(/\.\./g, "_")
    .trim();
  if (base === "" || base === "." || base === "..") {
    return "download";
  }
  return base;
}

/**
 * One Chromium (MVP locked decision) with a fresh-context factory. The context
 * maps the case profile onto Playwright's `newContext`: an explicit viewport
 * wins over the device preset (device fields spread first), tracing starts with
 * the case name, and `dialogPolicy` is attached per created page.
 */
class PlaywrightBrowserHandle implements BrowserHandle {
  private readonly browser: Browser;

  constructor(browser: Browser) {
    this.browser = browser;
  }

  async newContext(o: ContextLaunchOptions): Promise<RunContext> {
    const context = await this.browser.newContext({
      // Device preset first so an explicit viewport/scheme below wins. Each
      // field is spread only when set: passing an explicit `viewport: undefined`
      // would clobber the device's viewport with Playwright's default.
      ...(o.device !== undefined ? devices[o.device] : {}),
      ...(o.viewport !== undefined ? { viewport: o.viewport } : {}),
      ...(o.colorScheme !== undefined ? { colorScheme: o.colorScheme } : {}),
      ...(o.locale !== undefined ? { locale: o.locale } : {}),
      ...(o.timezoneId !== undefined ? { timezoneId: o.timezoneId } : {}),
      ...(o.storageState !== undefined ? { storageState: o.storageState } : {}),
      ...(o.baseURL !== undefined ? { baseURL: o.baseURL } : {}),
      recordVideo: { dir: o.videoDir, size: o.viewport ?? { width: 1280, height: 720 } },
    });
    try {
      await context.tracing.start({ screenshots: true, snapshots: true, title: o.title });
      if (o.sessionState !== undefined) {
        await context.addInitScript(
          ({ origin, entries }: { origin: string | null; entries: Record<string, string> }) => {
            if (origin === null || location.origin === origin) {
              for (const [key, value] of Object.entries(entries)) {
                window.sessionStorage.setItem(key, value);
              }
            }
          },
          { origin: o.sessionState.origin, entries: o.sessionState.entries },
        );
      }
      const page = await context.newPage();
      attachDialogPolicy(page, o.dialogPolicy);
      return new PlaywrightRunContext(context, page, o);
    } catch (err) {
      await context.close();
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}

/**
 * `/pattern/flags` → RegExp; anything else is the literal string the matcher
 * compares against. Playwright 1.64 matches plain URL/title strings exactly
 * (no glob expansion) — patterns need the `/…/flags` form.
 */
export function parseAssertMatcher(value: string): string | RegExp {
  if (value.length >= 2 && value.startsWith("/") && value.lastIndexOf("/") > 0) {
    const lastSlash = value.lastIndexOf("/");
    try {
      return new RegExp(value.slice(1, lastSlash), value.slice(lastSlash + 1));
    } catch {
      return value;
    }
  }
  return value;
}

/** Production launcher: Chromium only (MVP locked decision). */
export function playwrightLauncher(): BrowserLauncher {
  return {
    async launchBrowser(headless: boolean): Promise<BrowserHandle> {
      const browser = await chromium.launch({ headless });
      return new PlaywrightBrowserHandle(browser);
    },
  };
}
