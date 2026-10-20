/**
 * Parse one codegen statement into a step (or a reported "unsupported" line).
 * This is the recorder's action vocabulary: each `if` recognises one codegen
 * call shape and maps it onto the same free-text `value` encodings the runner
 * decodes (`runner/step-values.ts`), so recorder output round-trips.
 */

import type { RecorderUnsupported } from "../../shared/ipc-contract.js";
import { splitTopLevel } from "../../shared/locator-allowlist.js";
import type { TestStep } from "../../shared/step-types.js";
import { literalText } from "./literals.js";
import type { ClickEventMarker } from "./statement.js";
import {
  attributeValueFrom,
  clickValueFrom,
  expectTarget,
  isNegatedExpect,
  locatorSource,
  pageChainSource,
  terminalArgs,
  terminalSelectValue,
  terminalStringArg,
  textValueFrom,
  typeValueFrom,
  unsupportedFor,
  uploadValueFrom,
} from "./statement.js";

/** One parsed line: a recognised step, an unsupported statement, or null (boilerplate). */
export type ParsedLine =
  | { kind: "step"; step: Omit<TestStep, "order"> }
  | { kind: "unsupported"; entry: RecorderUnsupported };

/**
 * Negated matchers that have an exact positive action already in the runner
 * vocabulary. Everything else negated is reported as unsupported rather than
 * silently replayed as the positive assertion (M18).
 */
const NEGATED_ASSERTIONS: Readonly<Record<string, TestStep["action"]>> = {
  toBeVisible: "assert-hidden",
  toBeHidden: "assert-visible",
  toBeEnabled: "assert-disabled",
  toBeDisabled: "assert-enabled",
  toBeChecked: "assert-unchecked",
};

function negatedAssertion(stmt: string, target: string | undefined): ParsedLine {
  const matcher = /\.not\s*\.\s*([A-Za-z][A-Za-z0-9]*)\s*\(/.exec(stmt)?.[1];
  const action = matcher === undefined ? undefined : NEGATED_ASSERTIONS[matcher];
  if (action !== undefined) {
    return { kind: "step", step: { action, selector: target } };
  }
  return {
    kind: "unsupported",
    entry: {
      line: stmt,
      reason: `expect(...).not.${matcher ?? "…"}() has no step equivalent — add a manual step`,
    },
  };
}

function unsupportedTrial(stmt: string, terminal: string): ParsedLine {
  return {
    kind: "unsupported",
    entry: {
      line: stmt,
      reason: `${terminal}({ trial: true }) only checks actionability — record the real action or add a manual step`,
    },
  };
}

/**
 * Parse one codegen statement. Distinguishes three cases (M15):
 *  (a) a recognised step → `{ kind: "step", step }`;
 *  (b) a `page.` / `expect(` statement no pattern matches →
 *      `{ kind: "unsupported", entry }` (reported, never silently converted);
 *  (c) boilerplate (imports, test scaffolding, braces, comments, blanks) → null.
 *
 * `event` (M16) is the pending popup/download marker, attached to the click it
 * was recorded for.
 */
export function parseLine(line: string, event?: ClickEventMarker): ParsedLine | null {
  const raw = line.trim();
  const stmt = raw.replace(/^await\s+/, "").replace(/;\s*$/, "");
  if (stmt === "" || stmt.startsWith("//")) {
    return null;
  }
  if (!stmt.includes("page.") && !stmt.startsWith("expect(") && !stmt.includes(" expect(")) {
    return null;
  }
  const asStep = (step: Omit<TestStep, "order">): ParsedLine => ({ kind: "step", step });

  // Navigation: page.goto('https://…') / page.reload() / goBack() / goForward()
  if (/\.goto\(/.test(stmt)) {
    return asStep({ action: "goto", value: terminalStringArg(stmt, "goto") });
  }
  // URL wait: page.waitForURL('**/login' | /re/) — glob or regex (M17).
  if (/\.waitForURL\(/.test(stmt)) {
    const arg = splitTopLevel(terminalArgs(stmt, "waitForURL") ?? "", ",")[0]?.trim() ?? "";
    return asStep({ action: "wait-url", value: arg === "" ? undefined : literalText(arg) });
  }
  if (/\.reload\(/.test(stmt)) {
    return asStep({ action: "reload" });
  }
  if (/\.goBack\(/.test(stmt)) {
    return asStep({ action: "go-back" });
  }
  if (/\.goForward\(/.test(stmt)) {
    return asStep({ action: "go-forward" });
  }
  // Text entry: locator.fill('…')
  if (/\.fill\(/.test(stmt)) {
    return asStep({
      action: "fill",
      selector: locatorSource(stmt, "fill"),
      value: terminalStringArg(stmt, "fill"),
    });
  }
  // Dropdown: locator.selectOption('…' | ['a','b'] | { label|value|index })
  if (/\.selectOption\(/.test(stmt)) {
    return asStep({
      action: "select",
      selector: locatorSource(stmt, "selectOption"),
      value: terminalSelectValue(stmt),
    });
  }
  // Checkbox: locator.check() → check, locator.uncheck()/setChecked(false) → uncheck
  if (/\.check\(/.test(stmt) || /\.uncheck\(/.test(stmt) || /\.setChecked\(/.test(stmt)) {
    const terminal = /\.check\(/.test(stmt)
      ? "check"
      : /\.uncheck\(/.test(stmt)
        ? "uncheck"
        : "setChecked";
    const selector = locatorSource(stmt, terminal);
    if (/\.setChecked\(/.test(stmt)) {
      return asStep(
        /setChecked\(\s*false/.test(stmt)
          ? { action: "uncheck", selector }
          : { action: "check", selector },
      );
    }
    return asStep(
      terminal === "check" ? { action: "check", selector } : { action: "uncheck", selector },
    );
  }
  // Keyboard: locator.press('Enter') / page.keyboard.press('Enter')
  if (/\.press\(/.test(stmt)) {
    return asStep({
      action: "press",
      selector: locatorSource(stmt, "press"),
      value: terminalStringArg(stmt, "press"),
    });
  }
  // Char-by-char typing: locator.pressSequentially('…') / locator.type('…')
  if (/\.pressSequentially\(/.test(stmt) || /\.type\(/.test(stmt)) {
    const terminal = /\.pressSequentially\(/.test(stmt) ? "pressSequentially" : "type";
    return asStep({
      action: "type",
      selector: locatorSource(stmt, terminal),
      value: typeValueFrom(stmt, terminal),
    });
  }
  // Hover / focus
  if (/\.hover\(/.test(stmt)) {
    return asStep({ action: "hover", selector: locatorSource(stmt, "hover") });
  }
  if (/\.focus\(/.test(stmt)) {
    return asStep({ action: "focus", selector: locatorSource(stmt, "focus") });
  }
  // Scroll: locator.scrollIntoViewIfNeeded() — lazy-load lists, framing (M17).
  if (/\.scrollIntoViewIfNeeded\(/.test(stmt)) {
    return asStep({
      action: "scroll-into-view",
      selector: locatorSource(stmt, "scrollIntoViewIfNeeded"),
    });
  }
  // Drag: sourceLocator.dragTo(targetLocator) — source selector, target value.
  if (/\.dragTo\(/.test(stmt)) {
    return asStep({
      action: "drag",
      selector: locatorSource(stmt, "dragTo"),
      value: pageChainSource(terminalArgs(stmt, "dragTo") ?? ""),
    });
  }
  // File upload: locator.setInputFiles('path' | ['a', 'b'])
  if (/\.setInputFiles\(/.test(stmt)) {
    return asStep({
      action: "upload",
      selector: locatorSource(stmt, "setInputFiles"),
      value: uploadValueFrom(stmt),
    });
  }
  // Click: locator.click() — options (button/modifiers/force/clickCount) as JSON.
  if (/\.click\(/.test(stmt)) {
    if (/trial:\s*true/.test(stmt)) {
      return unsupportedTrial(stmt, "click");
    }
    return asStep({
      action: "click",
      selector: locatorSource(stmt, "click"),
      value: clickValueFrom(stmt, event),
    });
  }
  // Explicit waits: page.waitForTimeout(500)
  if (/\.waitForTimeout\(/.test(stmt)) {
    const num = /waitForTimeout\(\s*(\d+)/.exec(stmt)?.[1];
    return asStep({ action: "wait", value: num });
  }
  // Locator waits: keep the recorded state (attached/detached differ from
  // visible/hidden); only `detached` has no equivalent step action (M18).
  if (/\.waitFor\(/.test(stmt)) {
    const selector = locatorSource(stmt, "waitFor");
    const state = /state:\s*['"](attached|detached|visible|hidden)['"]/.exec(stmt)?.[1];
    if (state === "attached") {
      return asStep({ action: "assert-attached", selector });
    }
    if (state === "detached") {
      return {
        kind: "unsupported",
        entry: {
          line: stmt,
          reason: 'waitFor({ state: "detached" }) has no step equivalent — add a manual step',
        },
      };
    }
    if (state === "hidden") {
      return asStep({ action: "assert-hidden", selector });
    }
    return asStep({ action: "assert-visible", selector });
  }
  // Assertions: expect(locator).toBeVisible() / toContainText('…') / …
  if (stmt.includes("expect(")) {
    const target = expectTarget(stmt);
    if (isNegatedExpect(stmt)) {
      return negatedAssertion(stmt, target);
    }
    if (/toBeHidden/.test(stmt)) {
      return asStep({ action: "assert-hidden", selector: target });
    }
    if (/toBeDisabled/.test(stmt)) {
      return asStep({ action: "assert-disabled", selector: target });
    }
    if (/toBeEditable/.test(stmt)) {
      return asStep({ action: "assert-editable", selector: target });
    }
    if (/toBeFocused/.test(stmt)) {
      return asStep({ action: "assert-focused", selector: target });
    }
    if (/toBeChecked/.test(stmt)) {
      return asStep({ action: "assert-checked", selector: target });
    }
    if (/toBeAttached/.test(stmt)) {
      return asStep({ action: "assert-attached", selector: target });
    }
    if (/toHaveValue/.test(stmt)) {
      return asStep({
        action: "assert-value",
        selector: target,
        value: terminalStringArg(stmt, "toHaveValue"),
      });
    }
    if (/toHaveCount/.test(stmt)) {
      const num = /toHaveCount\(\s*(\d+)/.exec(stmt)?.[1];
      return asStep({ action: "assert-count", selector: target, value: num });
    }
    if (/toHaveURL/.test(stmt)) {
      return asStep({ action: "assert-url", value: terminalStringArg(stmt, "toHaveURL") });
    }
    if (/toHaveTitle/.test(stmt)) {
      return asStep({ action: "assert-title", value: terminalStringArg(stmt, "toHaveTitle") });
    }
    if (/toHaveAttribute/.test(stmt)) {
      return asStep({
        action: "assert-attribute",
        selector: target,
        value: attributeValueFrom(stmt),
      });
    }
    if (/toBeVisible|toBeEnabled/.test(stmt)) {
      return asStep(
        /toBeEnabled/.test(stmt)
          ? { action: "assert-enabled", selector: target }
          : { action: "assert-visible", selector: target },
      );
    }
    if (/toContainText/.test(stmt)) {
      return asStep({
        action: "assert-text",
        selector: target,
        value: textValueFrom(stmt, "toContainText"),
      });
    }
    if (/toHaveText/.test(stmt)) {
      return asStep({
        action: "assert-text-exact",
        selector: target,
        value: textValueFrom(stmt, "toHaveText"),
      });
    }
    return { kind: "unsupported", entry: unsupportedFor(stmt) };
  }
  // dblclick is first-class (legacy click+value:"dblclick" still runs).
  if (/\.dblclick\(/.test(stmt)) {
    if (/trial:\s*true/.test(stmt)) {
      return unsupportedTrial(stmt, "dblclick");
    }
    return asStep({
      action: "dblclick",
      selector: locatorSource(stmt, "dblclick"),
      // Carry modifiers/button/position and a popup marker: the runner routes
      // double clicks through page.click with clickCount 2, so these apply.
      value: clickValueFrom(stmt, event, "dblclick"),
    });
  }

  // Unrecognised page/expect statement — report it instead of dropping data.
  return { kind: "unsupported", entry: unsupportedFor(stmt) };
}
