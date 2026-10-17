/**
 * Pick-locator paste validation (M10, PLAN §18.3). Pure: no React, no IO —
 * unit-tested in Node.
 *
 * Uses the shared allowlist in `src/shared/locator-allowlist.ts` (the same
 * rule the runner executes against) as a fail-fast pre-check so a bad paste
 * is rejected in the UI with the same edit guidance instead of creating a
 * step that can only fail at run time. Unknown-but-CSS selectors fall
 * through to `page.locator` exactly like the runner, so they are accepted
 * as-is. Frame chains (`page.frameLocator(...).getByRole(...)`, nested
 * `frameLocator`) validate segment-by-segment like any other factory chain.
 */

import {
  CHAIN_METHODS,
  PAGE_FACTORY_METHODS,
  splitTopLevel,
} from "../../shared/locator-allowlist.js";

export type PickLocatorResult = { ok: true; selector: string } | { ok: false; error: string };

const GUIDANCE = "edit the step to a CSS selector or a getByRole/getByText/locator chain";

function unsupported(display: string, detail: string): PickLocatorResult {
  return { ok: false, error: `unsupported selector "${display}": ${detail} — ${GUIDANCE}` };
}

/** Strip one trailing run of `;` plus surrounding whitespace (pasted statements). */
function normalize(raw: string): string {
  let text = raw.trim();
  while (text.endsWith(";")) {
    text = text.slice(0, -1).trim();
  }
  if (text.startsWith("await ")) {
    text = text.slice("await ".length).trim();
  }
  return text;
}

/**
 * Validate pasted Pick-Locator output. Returns the normalized selector to
 * store (`action: click`, empty value — the caller picks the action) or an
 * edit-guidance error; the caller creates no step on error.
 */
export function validatePastedLocator(raw: string): PickLocatorResult {
  const text = normalize(raw);
  if (text === "") {
    return {
      ok: false,
      error: "Paste a locator first — in the codegen window use Pick Locator → Copy.",
    };
  }
  if (text.length > 10000) {
    return { ok: false, error: "Pasted locator is too long — paste a single locator." };
  }
  if (/[\r\n]/.test(text)) {
    return {
      ok: false,
      error:
        "Paste the locator only, not a multi-line snippet — " +
        "in the codegen window use Pick Locator → Copy a single locator.",
    };
  }
  const display = text.length > 200 ? `${text.slice(0, 199)}…` : text;

  let chain = text;
  if (chain.startsWith("page.")) {
    chain = chain.slice("page.".length).trim();
  }
  if (chain === "") {
    return { ok: false, error: "Paste a locator first — nothing follows `page.`." };
  }
  const head = /^([A-Za-z_$][\w$]*)/.exec(chain)?.[1];
  if (head === undefined) {
    // Plain CSS / engine syntax (`#id`, `.cls`, `text=…`) — runner falls
    // through to `page.locator`, so accept as-is.
    return { ok: true, selector: text };
  }
  if (!PAGE_FACTORY_METHODS.has(head)) {
    if (/^[A-Za-z_$][\w$]*\(/.test(chain)) {
      return unsupported(display, `"${head}(…)" is not a locator`);
    }
    // Bare tag / `text=` / `css=` / XPath — plain selector, accept as-is.
    return { ok: true, selector: text };
  }
  const segments = splitTopLevel(chain, ".");
  for (const segment of segments) {
    if (segment === "") {
      return unsupported(display, "empty chain segment");
    }
    if (segment.includes(";")) {
      return unsupported(display, `"${segment}" is not a supported locator step`);
    }
    const name = /^([A-Za-z_$][\w$]*)/.exec(segment)?.[1];
    if (name === undefined || !CHAIN_METHODS.has(name)) {
      return unsupported(display, `"${segment}" is not a supported locator step`);
    }
    if (segment.includes("(") && !/^[A-Za-z_$][\w$]*\(.*\)$/s.test(segment)) {
      return unsupported(display, `cannot parse "${segment}"`);
    }
  }
  return { ok: true, selector: text };
}
