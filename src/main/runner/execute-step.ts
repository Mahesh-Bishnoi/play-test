/**
 * One step against the page seam. The switch is the runner's action
 * vocabulary — every entry validates its required fields first, so a
 * misconfigured step fails with a message naming the step and what to edit
 * rather than a Playwright error about `undefined`.
 */

import { existsSync } from "node:fs";

import type { StepRow } from "../../shared/schema.js";
import { StepExecutionError } from "./errors.js";
import type { RunPage } from "./seams.js";
import {
  parseAssertMatcher,
  parseClickValue,
  parseSelectValue,
  parseStringList,
  parseTypeValue,
} from "./step-values.js";

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
