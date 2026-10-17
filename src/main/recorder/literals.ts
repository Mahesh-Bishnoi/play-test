/**
 * JS-literal text helpers. Codegen emits JavaScript source, so every value the
 * recorder extracts is first read as a quoted string, a string array, or a small
 * object literal — never `eval`ed. These helpers do that reading; the
 * statement-level extractors build on them.
 */

import { splitTopLevel } from "../../shared/locator-allowlist.js";

/**
 * Strip surrounding single/double/backtick quotes and unescape JS string
 * escapes. Returns the inner text unchanged when not quoted.
 */
export function unquote(literal: string): string {
  const text = literal.trim();
  if (text.length < 2) {
    return text;
  }
  const first = text[0] as string;
  const last = text[text.length - 1] as string;
  const quoted =
    (first === "'" && last === "'") ||
    (first === '"' && last === '"') ||
    (first === "`" && last === "`");
  if (!quoted) {
    return text;
  }
  const inner = text.slice(1, -1);
  // Unescape `\\` first (via a placeholder): otherwise a literal backslash-n
  // in the recorded value would become a real newline below.
  return inner
    .replace(/\\\\/g, "\uE000")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\`/g, "`")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\uE000/g, "\\");
}

/** True when `text` is a single/double/backtick-quoted literal. */
export function isQuotedLiteral(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) {
    return false;
  }
  const first = trimmed[0] as string;
  const last = trimmed[trimmed.length - 1] as string;
  return (
    (first === "'" && last === "'") ||
    (first === '"' && last === '"') ||
    (first === "`" && last === "`")
  );
}

/** A JS literal as its string value: quoted → unescaped, otherwise verbatim. */
export function literalText(text: string): string {
  const trimmed = text.trim();
  return isQuotedLiteral(trimmed) ? unquote(trimmed) : trimmed;
}

/** First quoted string argument in a call, e.g. `fill('hi')` → `hi`. */
export function firstStringArg(call: string): string | undefined {
  const match = /\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/.exec(call);
  return match?.[1] === undefined ? undefined : unquote(match[1]);
}

/** `['a', 'b']` → `['a', 'b']` (strings only); undefined for other literals. */
export function stringArrayLiteral(raw: string): string[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return undefined;
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") {
    return [];
  }
  const out: string[] = [];
  for (const part of splitTopLevel(inner, ",")) {
    const text = part.trim();
    if (!isQuotedLiteral(text)) {
      return undefined;
    }
    out.push(unquote(text));
  }
  return out;
}

/** `{ label: 'IN', index: 2 }` → `{ label: "IN", index: 2 }` (JS object literal). */
export function selectObjectLiteral(raw: string): Record<string, string | number> | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  const inner = trimmed.slice(1, -1).trim();
  const out: Record<string, string | number> = {};
  if (inner === "") {
    return out;
  }
  for (const part of splitTopLevel(inner, ",")) {
    const colon = part.indexOf(":");
    if (colon === -1) {
      return undefined;
    }
    const key = literalText(part.slice(0, colon));
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
      return undefined;
    }
    const valueText = part.slice(colon + 1).trim();
    if (isQuotedLiteral(valueText)) {
      out[key] = unquote(valueText);
    } else if (/^-?\d+(?:\.\d+)?$/.test(valueText)) {
      out[key] = Number(valueText);
    } else {
      return undefined;
    }
  }
  return out;
}

/** Inner text of a call, quote-aware, given the index just after its `(`. */
export function balancedCallInner(text: string, start: number): string | undefined {
  let depth = 1;
  let quote: string | null = null;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i);
      }
    }
  }
  return undefined;
}
