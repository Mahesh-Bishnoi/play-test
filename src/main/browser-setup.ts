import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { chromium } from "playwright";

/**
 * First-run Chromium presence check + install (WS6 / M7, PLAN §11).
 * Stateless functions over an injected `BrowserSetupDeps` seam — production
 * resolves the real Playwright browser path and spawns the real CLI, tests
 * inject fakes (mirrors the `SingleCaseRunner` launcher seam).
 */

export class BrowserSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserSetupError";
  }
}

export interface BrowserStatus {
  installed: boolean;
  executablePath: string;
}

export interface BrowserSetupDeps {
  /** Expected Chromium executable path; may throw when unresolvable. */
  executablePath: () => string;
  pathExists: (path: string) => boolean;
  /** Runs `playwright install chromium`; resolves with the exit code + stderr. */
  runInstall: () => Promise<{ code: number | null; stderr: string }>;
}

export function defaultBrowserSetupDeps(): BrowserSetupDeps {
  return {
    executablePath: () => chromium.executablePath(),
    pathExists: (path) => existsSync(path),
    runInstall: () => installViaPlaywrightCli(),
  };
}

/** Query-only: never throws, missing browser reads as `{ installed: false }`. */
export function getBrowserStatus(
  deps: BrowserSetupDeps = defaultBrowserSetupDeps(),
): BrowserStatus {
  let executablePath = "";
  try {
    executablePath = deps.executablePath();
  } catch {
    return { installed: false, executablePath: "" };
  }
  if (executablePath === "") {
    return { installed: false, executablePath: "" };
  }
  return { installed: deps.pathExists(executablePath), executablePath };
}

/**
 * Install Chromium, then verify the binary exists. Throws
 * `BrowserSetupError` (message carries the installer stderr tail + the manual
 * fallback command) on spawn failure, nonzero exit, or a still-missing binary.
 */
export async function installChromium(
  deps: BrowserSetupDeps = defaultBrowserSetupDeps(),
): Promise<BrowserStatus> {
  let result: { code: number | null; stderr: string };
  try {
    result = await deps.runInstall();
  } catch (err) {
    throw new BrowserSetupError(
      `Chromium install failed to start (${errorMessage(err)}). ` +
        "Run `npx playwright install chromium` manually, then retry.",
    );
  }
  if (result.code !== 0) {
    throw new BrowserSetupError(
      `Chromium install exited with code ${result.code ?? "unknown"}: ${tail(result.stderr)} ` +
        "Run `npx playwright install chromium` manually, then retry.",
    );
  }
  const status = getBrowserStatus(deps);
  if (!status.installed) {
    throw new BrowserSetupError(
      "Chromium install finished but the executable is still missing " +
        `(${status.executablePath || "no path resolved"}). ` +
        "Run `npx playwright install chromium` manually, then retry.",
    );
  }
  return status;
}

/** Last 500 chars of installer output — enough for the cause, not the log. */
function tail(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed === "" ? "(no output)" : trimmed.slice(-500);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Spawn the Playwright CLI from the installed `playwright` package (same
 * node_modules the externalized `playwright` import above resolves from).
 * `process.execPath` (Electron's Node) runs it — no `npx` on PATH required.
 */
function installViaPlaywrightCli(): Promise<{ code: number | null; stderr: string }> {
  let cliPath: string;
  try {
    // `__filename` exists in the bundled CJS main; fall back to CWD for dev.
    const anchor = typeof __filename === "string" ? __filename : process.cwd();
    cliPath = createRequire(anchor).resolve("playwright/cli.js");
  } catch {
    throw new BrowserSetupError(
      "Cannot locate the Playwright CLI from the packaged app. " +
        "Run `npx playwright install chromium` manually, then retry.",
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "install", "chromium"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      resolve({ code, stderr });
    });
  });
}
