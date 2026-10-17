/**
 * The runner's error vocabulary. Everything the runners (and the launcher /
 * selector resolver) throw, plus the one place step failures get formatted —
 * they are collected here so the messages stay consistent across runners.
 */

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

/**
 * The standard "this selector is not supported" failure, with the edit
 * guidance suffix every rejected recorder chain carries. Shared by the chain
 * parser and the literal parser.
 */
export function unsupportedSelector(full: string, detail: string): StepExecutionError {
  return new StepExecutionError(
    `unsupported selector "${full}": ${detail} — edit the step to a CSS selector or a getByRole/getByText/locator chain`,
  );
}
