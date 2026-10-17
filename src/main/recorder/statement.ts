/**
 * Statement-level extraction for one codegen line. Codegen emits one call per
 * statement (`page.getByRole('button').click({ button: 'right' })`), so these
 * helpers pull the terminal call's arguments, the locator chain before it, and
 * the option/encoding each runner action expects.
 */

import type { RecorderUnsupported } from "../../shared/ipc-contract.js";
import { splitTopLevel } from "../../shared/locator-allowlist.js";
import {
  balancedCallInner,
  firstStringArg,
  isQuotedLiteral,
  literalText,
  selectObjectLiteral,
  stringArrayLiteral,
  unquote,
} from "./literals.js";

/** Text inside the *terminal* call's parentheses (`''` for a bare call). */
export function terminalArgs(stmt: string, terminal: string): string | undefined {
  const marker = `.${terminal}(`;
  const idx = stmt.lastIndexOf(marker);
  if (idx === -1) {
    return undefined;
  }
  const start = idx + marker.length;
  // The terminal call closes the statement (codegen emits one call per line),
  // so its argument text ends at the final `)`.
  const end = stmt.lastIndexOf(")");
  return (end > start ? stmt.slice(start, end) : stmt.slice(start)).trim();
}

/**
 * First quoted string argument of the *terminal* call, e.g.
 * `page.getByLabel('Email').fill('ada@x')` → `ada@x` (not `Email`).
 * Reading the whole statement would return the selector's string.
 */
export function terminalStringArg(stmt: string, terminal: string): string | undefined {
  const marker = `.${terminal}(`;
  const idx = stmt.lastIndexOf(marker);
  if (idx === -1) {
    return undefined;
  }
  return firstStringArg(stmt.slice(idx + marker.length - 1));
}

/**
 * Select value: a JSON array for multi-select, else a JSON object for the
 * `{ label | value | index }` form, else the first quoted string.
 * A JSON array may mix plain strings and `{ … }` option objects; each element
 * round-trips to `parseSelectValue` in the runner.
 */
export function terminalSelectValue(stmt: string): string | undefined {
  const raw = terminalArgs(stmt, "selectOption");
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") {
      return undefined;
    }
    const values: Array<string | Record<string, string | number>> = [];
    for (const part of splitTopLevel(inner, ",")) {
      const object = selectObjectLiteral(part);
      if (object !== undefined) {
        values.push(object);
        continue;
      }
      const text = part.trim();
      if (!isQuotedLiteral(text)) {
        // Not a shape the runner understands — fall back to the legacy
        // single-string extraction so nothing is silently dropped.
        return terminalStringArg(stmt, "selectOption");
      }
      values.push(unquote(text));
    }
    if (values.length > 0) {
      return JSON.stringify(values);
    }
  }
  const object = selectObjectLiteral(trimmed);
  if (object !== undefined) {
    return JSON.stringify(object);
  }
  return terminalStringArg(stmt, "selectOption");
}

/**
 * Locator source inside `expect(page.<chain>)` — the full chain including its
 * closing `)` (e.g. `locator('#x')`), or undefined when the subject is not a
 * `page.` locator.
 */
export function expectTarget(stmt: string): string | undefined {
  const marker = "expect(";
  const idx = stmt.indexOf(marker);
  if (idx === -1) {
    return undefined;
  }
  const inner = balancedCallInner(stmt, idx + marker.length);
  if (inner === undefined) {
    return undefined;
  }
  const trimmed = inner.trim();
  if (!trimmed.startsWith("page.")) {
    return undefined;
  }
  return pageChainSource(trimmed);
}

/** The `page.`-relative locator chain of an expression, e.g. a `dragTo` target. */
export function pageChainSource(expr: string): string | undefined {
  const trimmed = expr.trim();
  if (trimmed === "") {
    return undefined;
  }
  const pageIdx = trimmed.indexOf("page.");
  const source = (pageIdx === -1 ? trimmed : trimmed.slice(pageIdx + "page.".length)).trim();
  return source === "" ? undefined : source;
}

/**
 * Playwright locator source for `page.<chain>.<terminal>(...)`, e.g.
 * `page.getByRole('button').click()` → `getByRole('button')`,
 * `page.locator('#id').fill('x')` → `locator('#id')`.
 * Returns undefined for bare `page.<terminal>(...)` calls.
 */
export function locatorSource(stmt: string, terminal: string): string | undefined {
  const idx = stmt.lastIndexOf(`.${terminal}(`);
  if (idx === -1) {
    return undefined;
  }
  const head = stmt.slice(0, idx);
  if (!head.includes("page.")) {
    return undefined;
  }
  return pageChainSource(head);
}

/** Click modifiers the runner accepts (kept in sync with `parseClickValue`). */
const CLICK_MODIFIERS: ReadonlySet<string> = new Set([
  "Alt",
  "Control",
  "ControlOrMeta",
  "Meta",
  "Shift",
]);

/** Cross-line click marker for a recorded popup/download wait (M16). */
export type ClickEventMarker = "popup" | "download";

/**
 * Click option encoding: a JSON object (`{"button":"right","modifiers":…,
 * "clickCount":2,"force":true,"position":{"x":10,"y":20}}`) when any option is
 * present, else undefined so a plain `.click()` stays value-less (runner's
 * `parseClickValue`). An `event` marker (M16) merges into the same object, e.g.
 * `{"button":"right","popup":true}`.
 */
export function clickValueFrom(stmt: string, event?: ClickEventMarker): string | undefined {
  const args = terminalArgs(stmt, "click") ?? "";
  if (event === undefined && !/button:|modifiers:|force:|clickCount:|position:/.test(args)) {
    return undefined;
  }
  const options: Record<string, unknown> = {};
  const button = /button:\s*['"](right|middle)['"]/.exec(args)?.[1];
  if (button !== undefined) {
    options["button"] = button;
  }
  if (/force:\s*true/.test(args)) {
    options["force"] = true;
  }
  const position = /position:\s*\{\s*x:\s*(-?\d+(?:\.\d+)?)\s*,\s*y:\s*(-?\d+(?:\.\d+)?)\s*\}/.exec(
    args,
  );
  if (position !== null) {
    options["position"] = { x: Number(position[1]), y: Number(position[2]) };
  }
  const count = /clickCount:\s*(\d+)/.exec(args)?.[1];
  if (count !== undefined && Number(count) >= 1) {
    options["clickCount"] = Number(count);
  }
  const modifiers = /modifiers:\s*\[([^\]]*)\]/.exec(args)?.[1];
  if (modifiers !== undefined) {
    const valid = modifiers
      .split(",")
      .map((m) => literalText(m))
      .filter((m) => CLICK_MODIFIERS.has(m));
    if (valid.length > 0) {
      options["modifiers"] = valid;
    }
  }
  if (event !== undefined) {
    options[event] = true;
  }
  return Object.keys(options).length === 0 ? undefined : JSON.stringify(options);
}

/** `toHaveAttribute('name', 'value' | /re/)` → `name=value` / `name=/re/flags`. */
export function attributeValueFrom(stmt: string): string | undefined {
  const args = terminalArgs(stmt, "toHaveAttribute");
  if (args === undefined) {
    return undefined;
  }
  const parts = splitTopLevel(args, ",");
  const name = parts[0] === undefined ? "" : literalText(parts[0]);
  if (name === "") {
    return undefined;
  }
  const expected = (parts[1] ?? "").trim();
  return expected === "" ? name : `${name}=${literalText(expected)}`;
}

/** Text matcher value: a JSON array for multi-element, else the first string. */
export function textValueFrom(stmt: string, terminal: string): string | undefined {
  const raw = terminalArgs(stmt, terminal);
  if (raw === undefined) {
    return undefined;
  }
  const list = stringArrayLiteral(raw);
  if (list !== undefined) {
    return JSON.stringify(list);
  }
  return terminalStringArg(stmt, terminal);
}

/**
 * `type` value: `{"text":"…","delay":N}` when a per-keystroke `delay` option is
 * recorded, else the plain string (runner's `parseTypeValue`).
 */
export function typeValueFrom(stmt: string, terminal: string): string | undefined {
  const text = terminalStringArg(stmt, terminal);
  if (text === undefined) {
    return undefined;
  }
  const delay = /delay:\s*(\d+)/.exec(terminalArgs(stmt, terminal) ?? "")?.[1];
  return delay === undefined ? text : JSON.stringify({ text, delay: Number(delay) });
}

/** Upload value: a path, or a JSON array of paths (`setInputFiles`). */
export function uploadValueFrom(stmt: string): string | undefined {
  const raw = terminalArgs(stmt, "setInputFiles");
  if (raw === undefined) {
    return undefined;
  }
  const list = stringArrayLiteral(raw);
  return list !== undefined ? JSON.stringify(list) : literalText(raw);
}

/**
 * Short human reason for an unmapped line (M15): names the offending call so
 * the user knows what to add as a manual step.
 */
export function unsupportedFor(stmt: string): RecorderUnsupported {
  if (stmt.includes("expect(")) {
    const matcher = /\)\.([A-Za-z][A-Za-z0-9]*)\s*\(/.exec(stmt)?.[1];
    if (matcher !== undefined) {
      return {
        line: stmt,
        reason: `expect(...).${matcher}() is not supported — add a manual step`,
      };
    }
  }
  const pageCall = /\b(page\.[A-Za-z0-9_$.]+?)\s*\(/.exec(stmt)?.[1];
  if (pageCall !== undefined) {
    return { line: stmt, reason: `${pageCall}(...) is not supported — add a manual step` };
  }
  return { line: stmt, reason: "statement is not supported — add a manual step" };
}
