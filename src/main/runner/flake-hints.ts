/**
 * Playwright best-practice hints for steps that bypass native auto-waiting
 * (M18). These are advisories, not failures: the run proceeds, but the log
 * points at the step and the native alternative.
 *
 * `wait` is a fixed sleep (`page.waitForTimeout`), which the Playwright docs
 * call inherently flaky; `assert-*` / `wait-url` retry until the condition
 * holds. `force` skips actionability checks, so a click can land on an
 * element Playwright would otherwise refuse to act on.
 */

import type { StepRow } from "../../shared/schema.js";
import { parseClickValue } from "./step-values.js";

/** Cap repeated fixed-wait hints so one long recording does not flood the log. */
const MAX_WAIT_HINTS = 3;

/** Human warnings for the steps in one case, in step order. */
export function flakeHints(steps: StepRow[]): string[] {
  const hints: string[] = [];
  const waits = steps.filter((step) => step.action === "wait");
  for (const step of waits.slice(0, MAX_WAIT_HINTS)) {
    hints.push(
      `step s${step.order} (wait) sleeps ${step.value ?? "?"} ms — prefer assert-* or wait-url, which retry automatically`,
    );
  }
  if (waits.length > MAX_WAIT_HINTS) {
    hints.push(
      `${waits.length - MAX_WAIT_HINTS} more fixed wait(s) in this case — replace them with assert-* or wait-url`,
    );
  }
  for (const step of steps) {
    if (step.action !== "click") {
      continue;
    }
    // A malformed value fails the step when it executes; hints stay advisory.
    const parsed = parseClickValue(step.value);
    if (parsed.error === undefined && parsed.options.force === true) {
      hints.push(
        `step s${step.order} (click) forces the click, bypassing Playwright actionability checks`,
      );
    }
  }
  return hints;
}
