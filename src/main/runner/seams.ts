/**
 * Runner seams (production adapters + test fakes are the two sides).
 *
 * Both runners drive a page and a browser context through these narrow
 * interfaces: production wraps Playwright, tests inject recording fakes
 * (PLAN §8). Everything here is runner-facing vocabulary with no Playwright
 * import, so the fake and the real adapter stay interchangeable.
 */

/** Click options a `click` step carries after parsing its `value` encoding. */
export interface ClickStepOptions {
  button?: "left" | "right" | "middle";
  modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
  force?: boolean;
  /** Recorded `clickCount` (M15); `2` is normalised to the `double` path. */
  clickCount?: number;
  /** Adopt the page this click opens instead of leaving it in the background (M16). */
  popup?: boolean;
  /** Save the download this click starts to the case's downloads dir (M16). */
  download?: boolean;
  /** Click at this offset inside the element instead of its centre (M17). */
  position?: { x: number; y: number };
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

/**
 * Minimal page surface the runner drives (PLAN §8). Production wraps a
 * Playwright `Page`; tests inject a recording fake. Timeouts pass straight
 * through — `undefined` means the Playwright default.
 */
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
  /** `toContainText` — a list asserts several elements' text (M18). */
  assertText(selector: string, value: string | string[], timeoutMs?: number): Promise<void>;
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

export type RunEventChannel = "run:step-update" | "run:log" | "run:finished";

/** Main wires this to `webContents.send`; tests collect into an array. */
export type EmitRunEvent = (channel: RunEventChannel, payload: unknown) => void;
