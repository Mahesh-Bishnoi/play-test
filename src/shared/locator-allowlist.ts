/**
 * Shared Playwright locator allowlist (single source of truth).
 *
 * Both `src/main/runner.ts` (execution) and
 * `src/renderer/components/pick-locator.ts` (paste pre-check) validate
 * codegen locator chains against these sets plus `splitTopLevel` /
 * `isRegexStart`. Keep this module dependency-free so main, renderer, and
 * tests can all import it.
 */

/** Factory methods codegen emits directly on `page.` (plus bare `locator(`). */
export const PAGE_FACTORY_METHODS: ReadonlySet<string> = new Set([
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
export const CHAIN_METHODS: ReadonlySet<string> = new Set([
  ...PAGE_FACTORY_METHODS,
  "filter",
  "first",
  "last",
  "nth",
]);

/** Split on a separator at nesting depth 0, ignoring strings/regex/parens. */
export function splitTopLevel(text: string, separator: "." | ","): string[] {
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
export function isRegexStart(text: string, index: number): boolean {
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
