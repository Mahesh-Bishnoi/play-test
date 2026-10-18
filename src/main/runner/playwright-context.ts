/**
 * The production `RunContext` + `BrowserHandle` adapters. One Chromium (MVP
 * locked decision) with a fresh-context factory: the context maps the case
 * profile onto Playwright's `newContext`, and the runner owns teardown.
 */

import type { Browser, BrowserContext, Page } from "playwright";
import { devices } from "playwright";

import { PlaywrightRunPage, attachDialogPolicy } from "./playwright-page.js";
import type { BrowserHandle, ContextLaunchOptions, RunContext, RunPage } from "./seams.js";

export class PlaywrightRunContext implements RunContext {
  private readonly context: BrowserContext;
  /** Kept typed so the video follows a popup adopted by a `popup` click (M18). */
  private readonly runPage: PlaywrightRunPage;
  readonly page: RunPage;
  private closed = false;

  constructor(context: BrowserContext, page: Page, o: ContextLaunchOptions) {
    this.context = context;
    this.runPage = new PlaywrightRunPage(context, page, {
      downloadsDir: o.downloadsDir,
      onLog: o.onLog,
      dialogPolicy: o.dialogPolicy,
    });
    this.page = this.runPage;
  }

  async saveVideo(dest: string): Promise<void> {
    // Finalize the recording first: Playwright's saveAs needs the browser
    // connection (it dies in browser close), and the artifact is only complete
    // once the context closes. Read the Video via the current page — the object
    // outlives the context, and after popup adoption the current page's
    // recording is the one that shows the rest of the run.
    await this.close();
    const video = this.runPage.currentPage().video();
    if (video !== null) {
      await video.saveAs(dest);
    }
  }

  async discardVideo(): Promise<void> {
    await this.close();
    const video = this.runPage.currentPage().video();
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

/**
 * One Chromium (MVP locked decision) with a fresh-context factory. The context
 * maps the case profile onto Playwright's `newContext`: an explicit viewport
 * wins over the device preset (device fields spread first), tracing starts with
 * the case name, and `dialogPolicy` is attached per created page.
 */
export class PlaywrightBrowserHandle implements BrowserHandle {
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
      recordVideo: { dir: o.videoDir, size: resolveRecordVideoSize(o) },
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
 * Video size for a context (M18). An explicit viewport wins; otherwise use the
 * device preset's viewport, so a mobile recording is not letterboxed into the
 * 1280×720 default (Playwright records the viewport, not the full page).
 */
export function resolveRecordVideoSize(o: {
  viewport?: { width: number; height: number };
  device?: string;
}): { width: number; height: number } {
  if (o.viewport !== undefined) {
    return o.viewport;
  }
  if (o.device !== undefined) {
    const preset = devices[o.device];
    if (preset?.viewport != null) {
      return { width: preset.viewport.width, height: preset.viewport.height };
    }
  }
  return { width: 1280, height: 720 };
}
