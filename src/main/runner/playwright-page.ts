/**
 * The production `RunPage` adapter: a thin, Playwright-specific implementation
 * of the page seam. Everything Playwright-shaped lives here — recorder chain
 * dispatch, popup/download click patterns, web-first assertions, screenshots —
 * so the runners stay free of Playwright imports.
 */

import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";

import { expect } from "playwright/test";
import type { BrowserContext, Locator, Page } from "playwright";

import { resolveLocator } from "./locator-resolve.js";
import type {
  ClickStepOptions,
  ContextLaunchOptions,
  RunLogLevel,
  RunPage,
  SelectOptionInput,
} from "./seams.js";
import { SCREENSHOT_TIMEOUT_MS } from "./step-evidence.js";
import { parseAssertMatcher, parseStringList } from "./step-values.js";

/**
 * Assertion timeout default, matching Playwright's own assertion budget: every
 * `assert-*` step goes through `playwright/test`'s web-first matchers, so a
 * failure carries Playwright's Expected/Received diff and call log instead of a
 * one-line hand-rolled message.
 */
const DEFAULT_ASSERT_TIMEOUT_MS = 30_000;

export class PlaywrightRunPage implements RunPage {
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
    attachPageDiagnostics(page, deps.onLog);
  }

  /**
   * The page currently being driven (M18). `PlaywrightRunContext` reads its
   * video, so after a `popup` click the failure recording comes from the tab
   * the rest of the run used, not the original (now idle) page.
   */
  currentPage(): Page {
    return this.page;
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
      // dialog policy and error reporting are attached per page, so re-attach
      // them to the new one.
      this.page = next;
      if (this.deps.dialogPolicy !== undefined && this.deps.dialogPolicy !== "default") {
        attachDialogPolicy(next, this.deps.dialogPolicy);
      }
      attachPageDiagnostics(next, this.deps.onLog);
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

  async assertText(selector: string, value: string | string[], timeoutMs?: number): Promise<void> {
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

/** Attach the profile's dialog policy to a page (M14); `default` = no handler. */
export function attachDialogPolicy(page: Page, policy: ContextLaunchOptions["dialogPolicy"]): void {
  if (policy === "accept") {
    page.on("dialog", (dialog) => void dialog.accept());
  } else if (policy === "dismiss") {
    page.on("dialog", (dialog) => void dialog.dismiss());
  }
}

/**
 * Surface uncaught page exceptions in the run log (M18). Playwright's trace
 * viewer already records them, but the live run pane otherwise shows only the
 * failed step — the JS exception that broke the page is the missing cause.
 */
export function attachPageDiagnostics(
  page: Page,
  onLog: (level: RunLogLevel, message: string) => void,
): void {
  page.on("pageerror", (error) => {
    onLog("error", `page error: ${error.message}`);
  });
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
