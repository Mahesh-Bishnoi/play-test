/**
 * The codegen-output state machine: turn a whole codegen file into ordered
 * `TestStep[]` plus the lines that mapped to no step. Popup/download waits span
 * two or three lines (M16), so the loop carries a little state between lines;
 * everything else is delegated to `parse-line.ts`. Pure: no IO.
 */

import type { RecorderUnsupported } from "../../shared/ipc-contract.js";
import type { TestStep } from "../../shared/step-types.js";
import { parseLine } from "./parse-line.js";
import {
  inlinePromiseAllClick,
  pendingEventFrom,
  promiseAllOpener,
  rewriteAdoptedPage,
  settledPromise,
} from "./popup-download.js";
import type { ClickEventMarker } from "./statement.js";

/**
 * Parse Playwright codegen output into ordered `TestStep[]` plus the lines that
 * mapped to no step (PLAN §7 / M15). Pure: no IO. Orders are dense 0..n-1 in
 * file order; fields a pattern cannot fill are omitted (inner code treats
 * missing as unset).
 *
 * A popup/download wait (M16) spans lines, so the loop keeps one bit of state:
 * `page.waitForEvent('popup'|'download')` arms a marker that the next click
 * carries (merging into its value JSON), and the matching
 * `const page = await pagePromise;` line disarms it. Both bookkeeping lines are
 * neither steps nor `unsupported`.
 *
 * A settled *popup* promise also names the page variable codegen then records
 * against (`const page1 = await page1Promise;`): the loop remembers it as an
 * adopted-page alias and rewrites later `page1.…` subjects to `page.…`, since
 * M16 item 2 adopts the new tab as the run page. Download variables are not
 * pages, so they never become aliases.
 */
export function parseCodegenOutput(code: string): {
  steps: TestStep[];
  unsupported: RecorderUnsupported[];
} {
  const steps: TestStep[] = [];
  const unsupported: RecorderUnsupported[] = [];
  let pending: { promiseVar: string | null; marker: ClickEventMarker } | null = null;
  // A popup booking survives the click it marks, until its own settlement line
  // names the adopted page variable.
  let popupAwait: { promiseVar: string } | null = null;
  const adoptedPages = new Set<string>();
  // Destructured bindings of a multi-line `Promise.all` opener, consumed by the
  // first `waitForEvent` booking that follows it.
  let promiseAllBindings: string[] | null = null;
  for (const line of code.split("\n")) {
    // Single-line inline form: `await Promise.all([page.waitForEvent(…), …click()])`.
    const inline = inlinePromiseAllClick(line);
    if (inline !== null) {
      // The inline form settles its popup element straight into the destructured
      // binding, with no separate `await <promise>` line to catch.
      if (inline.marker === "popup" && inline.target !== null) {
        adoptedPages.add(inline.target);
      }
      const parsed = parseLine(inline.click, inline.marker);
      if (parsed?.kind === "step") {
        steps.push({ ...parsed.step, order: steps.length });
      } else if (parsed?.kind === "unsupported") {
        unsupported.push(parsed.entry);
      }
      pending = null;
      popupAwait = null;
      promiseAllBindings = null;
      continue;
    }
    // A multi-line `Promise.all` opener names its bindings a few lines before the
    // `waitForEvent` element books; remember them until that booking consumes them.
    const opener = promiseAllOpener(line);
    if (opener !== null) {
      promiseAllBindings = opener;
      continue;
    }
    // Bookkeeping: a `waitForEvent` wait arms the marker, its settlement clears it.
    const booking = pendingEventFrom(line);
    if (booking !== null) {
      pending = booking;
      // Codegen puts the waited event first in the array, so the first binding is
      // the popup page variable; a download variable is never adopted.
      const inlineTarget =
        booking.marker === "popup" && booking.promiseVar === null && promiseAllBindings !== null
          ? promiseAllBindings[0]
          : undefined;
      if (inlineTarget !== undefined && inlineTarget !== "") {
        adoptedPages.add(inlineTarget);
      }
      popupAwait =
        booking.marker === "popup" && booking.promiseVar !== null
          ? { promiseVar: booking.promiseVar }
          : null;
      promiseAllBindings = null;
      continue;
    }
    const settled = settledPromise(line);
    if (settled !== undefined) {
      if (popupAwait !== null && popupAwait.promiseVar === settled.promiseVar) {
        adoptedPages.add(settled.target);
        popupAwait = null;
      }
      if (pending !== null && pending.promiseVar === settled.promiseVar) {
        pending = null;
      }
      continue;
    }
    const parsed = parseLine(rewriteAdoptedPage(line, adoptedPages), pending?.marker);
    if (parsed === null) {
      continue;
    }
    if (parsed.kind === "unsupported") {
      unsupported.push(parsed.entry);
      pending = null;
      popupAwait = null;
      promiseAllBindings = null;
      continue;
    }
    steps.push({ ...parsed.step, order: steps.length });
    // The marker rides the click it was armed for; any other step ends the pattern.
    pending = null;
    promiseAllBindings = null;
    if (parsed.step.action !== "click") {
      popupAwait = null;
    }
  }
  return { steps, unsupported };
}
