/**
 * The recorder's error vocabulary. Each one maps to a distinct user-visible
 * failure: a bad device name, a double `start`, a `stop` with no session, and a
 * codegen process that died before it was ready.
 */

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
