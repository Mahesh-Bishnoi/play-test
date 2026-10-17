/**
 * Evidence collected around a step: the post-step screenshot and the trace
 * group. Screenshots and traces are evidence, not verdicts — a failed capture
 * warns and never flips the step result (M13).
 */

import type { RunContext, RunPage } from "./seams.js";

/** Screenshot budget before a capture is abandoned (evidence, not a verdict). */
export const SCREENSHOT_TIMEOUT_MS = 10_000;
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
