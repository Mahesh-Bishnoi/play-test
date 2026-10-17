/**
 * M16 popup/download bookkeeping: the multi-line shapes codegen emits for
 * `page.waitForEvent('popup'|'download')` stay out of the step list, and an
 * adopted popup page is rewritten onto the run page. Pure text helpers — the
 * state machine that drives them lives in `codegen-output.ts`.
 */

import { splitTopLevel } from "../../shared/locator-allowlist.js";
import { balancedCallInner } from "./literals.js";
import type { ClickEventMarker } from "./statement.js";

/** `page.waitForEvent('popup')` / `('download')` — the codegen popup/download wait. */
const WAIT_FOR_EVENT_RE = /\.waitForEvent\(\s*['"](popup|download)['"]\s*\)/;

/** The popup/download marker a `waitForEvent(…)` line waits for, if any. */
export function eventMarkerFrom(stmt: string): ClickEventMarker | undefined {
  const kind = WAIT_FOR_EVENT_RE.exec(stmt)?.[1];
  return kind === "popup" || kind === "download" ? kind : undefined;
}

/**
 * Promise bookkeeping that must not become a step (M16): the
 * `const page1Promise = page.waitForEvent('popup');` line that precedes the
 * click, and the `page.waitForEvent('popup'),` element of an inline
 * `Promise.all`. Returns the promise variable to settle on (null when the line
 * declares none, e.g. the inline element), or null when the line is not a wait.
 */
export function pendingEventFrom(
  line: string,
): { promiseVar: string | null; marker: ClickEventMarker } | null {
  const marker = eventMarkerFrom(line);
  if (marker === undefined) {
    return null;
  }
  const promiseVar =
    /^\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:await\s+)?/.exec(line)?.[1] ??
    null;
  return { promiseVar, marker };
}

/**
 * `const page1 = await page1Promise;` → the assigned page variable plus the
 * promise it settles (the one a `waitForEvent` booking armed).
 */
export function settledPromise(line: string): { target: string; promiseVar: string } | undefined {
  const match =
    /^\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*await\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*;?\s*$/.exec(
      line,
    );
  const target = match?.[1];
  const promiseVar = match?.[2];
  return target === undefined || promiseVar === undefined ? undefined : { target, promiseVar };
}

/**
 * Rewrite an adopted popup-page alias to the `page` run page (M16 item 2) in the
 * only two positions codegen uses it as the statement subject: a line starting
 * `[await ]<alias>.…` and one starting `[await ]expect(<alias>.…`. Every other
 * occurrence — mid-statement, or a `download.` object — is left untouched.
 */
export function rewriteAdoptedPage(line: string, aliases: ReadonlySet<string>): string {
  if (aliases.size === 0) {
    return line;
  }
  const trimmed = line.trim();
  const awaitPrefix = /^await\s+/.exec(trimmed)?.[0] ?? "";
  const stmt = trimmed.slice(awaitPrefix.length);
  const expectPrefix = "expect(";
  const isExpect = stmt.startsWith(expectPrefix);
  const subject = isExpect ? stmt.slice(expectPrefix.length) : stmt;
  for (const alias of aliases) {
    if (!subject.startsWith(`${alias}.`)) {
      continue;
    }
    const head = `${awaitPrefix}${isExpect ? expectPrefix : ""}`;
    return `${head}page.${subject.slice(alias.length + 1)}`;
  }
  return line;
}

/**
 * Single-line `const [page1] = await Promise.all([page.waitForEvent('popup'),
 * page.getByRole(…).click()]);` → the marker plus the click sub-statement
 * (re-parsed as an ordinary click). A `Promise.all` split over several lines is
 * instead picked up by the per-line `waitForEvent` booking in
 * `codegen-output.ts`. `target` is the destructured page variable the
 * marker's element settles into (adopted for later steps), or null.
 */
export function inlinePromiseAllClick(
  stmt: string,
): { marker: ClickEventMarker; click: string; target: string | null } | null {
  const marker = "Promise.all(";
  const idx = stmt.indexOf(marker);
  if (idx === -1) {
    return null;
  }
  const inner = balancedCallInner(stmt, idx + marker.length);
  if (inner === undefined) {
    return null;
  }
  const trimmed = inner.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }
  let event: ClickEventMarker | undefined;
  let eventIndex = -1;
  let click: string | undefined;
  for (const [index, part] of splitTopLevel(trimmed.slice(1, -1), ",").entries()) {
    if (event === undefined) {
      const partEvent = eventMarkerFrom(part);
      if (partEvent !== undefined) {
        event = partEvent;
        eventIndex = index;
      }
    }
    if (click === undefined && part.includes("page.") && /\.click\(/.test(part)) {
      click = part.trim();
    }
  }
  if (event === undefined || click === undefined) {
    return null;
  }
  return { marker: event, click, target: destructuredBinding(stmt, eventIndex) };
}

/**
 * The array-destructured binding name of `const [a, b] = ...` for the
 * initialiser array's `index`-th element (`Promise.all` preserves input order).
 * `""` marks an elision (`[, b]`); anything unusable yields null.
 */
function destructuredBinding(stmt: string, index: number): string | null {
  if (index < 0) {
    return null;
  }
  const names = /^\s*(?:const|let|var)\s+\[([^\]]*)\]\s*=/.exec(stmt)?.[1];
  const binding = names?.split(",")[index]?.trim();
  return binding === undefined || binding === "" ? null : binding;
}

/**
 * `const [page1] = await Promise.all([` opening a `Promise.all` whose array
 * elements sit on the following lines -> the destructured binding names. The
 * single-line form never matches here (a trailing element is left on the line).
 */
export function promiseAllOpener(line: string): string[] | null {
  const names =
    /^\s*(?:const|let|var)\s+\[([^\]]*)\]\s*=\s*(?:await\s+)?Promise\.all\(\s*\[?\s*$/.exec(
      line,
    )?.[1];
  return names === undefined ? null : names.split(",").map((name) => name.trim());
}
