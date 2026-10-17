/**
 * Pick-locator paste validation (M10, PLAN §18.3). Pure: no React, no IO —
 * unit-tested in Node.
 *
 * Mirrors the allowlist in `src/main/runner.ts` (`PAGE_FACTORY_METHODS` /
 * `CHAIN_METHODS` + `splitLocatorChain`): the runner stays the source of
 * truth at execution time, this is a fail-fast pre-check so a bad paste is
 * rejected in the UI with the same edit guidance instead of creating a step
 * that can only fail at run time. Unknown-but-CSS selectors fall through to
 * `page.locator` exactly like the runner, so they are accepted as-is.
 */

export type PickLocatorResult = { ok: true; selector: string } | { ok: false; error: string };

/** Factory methods codegen emits directly on `page.` (plus bare `locator(`). */
const PAGE_FACTORY_METHODS = new Set([
  "getByRole",
  "getByText",
  "getByLabel",
  "getByPlaceholder",
  "getByAltText",
  "getByTitle",
  "getByTestId",
  "locator",
]);

/** Chainable methods supported after the factory call. */
const CHAIN_METHODS = new Set([...PAGE_FACTORY_METHODS, "filter", "first", "last", "nth"]);

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

/** Split on a separator at nesting depth 0, ignoring strings/regex/parens. */
function splitTopLevel(text: string, separator: "." | ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let quote: string | null = null;
  let inRegex = false;
  let inRegexClass = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote !== null) {
      current += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (inRegex) {
      current += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "[") {
        inRegexClass = true;
      } else if (ch === "]") {
        inRegexClass = false;
      } else if (ch === "/" && !inRegexClass) {
        while (i + 1 < text.length && /[a-z]/i.test(text[i + 1] as string)) {
          current += text[i + 1];
          i++;
        }
        inRegex = false;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "/" && isRegexStart(text, i)) {
      inRegex = true;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
    }
    if (ch === separator && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts;
}

/** A `/` starts a regex literal when the previous token cannot end an expression. */
function isRegexStart(text: string, index: number): boolean {
  if (text[index + 1] === "/" || text[index + 1] === "*") {
    return false;
  }
  let j = index - 1;
  while (j >= 0 && /\s/.test(text[j] as string)) {
    j--;
  }
  if (j < 0) {
    return true;
  }
  return "([,{=:!&|?;".includes(text[j] as string);
}
