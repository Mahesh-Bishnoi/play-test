/**
 * Step `value` encodings — the free-text forms a step's `value` column can take
 * (no schema change), plus `{{key}}` substitution. Every encoder here has a
 * matching decoder in the recorder or the step editor, so the two stay in sync
 * in one place. Pure functions, unit-tested directly.
 */

import { MissingTestDataKeyError, substituteTestDataValue } from "../../shared/step-types.js";
import type { StepRow } from "../../shared/schema.js";
import type { ClickStepOptions, SelectOptionInput, SelectOptionValue } from "./seams.js";

/** `{{key}}` substitution applies to step `value` only (PLAN §10). */
export function substituteStepValue(
  template: string | undefined,
  data: Record<string, string>,
): string | undefined {
  if (template === undefined) {
    return undefined;
  }
  return substituteTestDataValue(template, data);
}

/** A plain object (`{}`), as opposed to an array or `null` — a JSON options bag. */
export function isOptions(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Click modifiers Playwright accepts (canonical names only). */
const CLICK_MODIFIERS = ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"] as const;

/** Click JSON keys the runner understands; anything else is a typo, not a no-op. */
const CLICK_JSON_KEYS = new Set([
  "button",
  "modifiers",
  "force",
  "popup",
  "download",
  "position",
  "clickCount",
  "double",
]);

/** A parsed click value: `error` is set when the value must fail the step. */
export interface ParsedClickValue {
  double: boolean;
  options: ClickStepOptions;
  error?: string;
}

/**
 * Click `value` encoding (no schema change): empty = plain left-click,
 * legacy `"dblclick"` = double-click, `"right"` / `"middle"` = button,
 * `"shift"` / `"ctrl"` / `"alt"` / `"meta"` (+ `-click` / `+`-joined forms) =
 * modifiers, `"force"` = force click, `"popup"` / `"download"` = adopt the
 * opened page / save the triggered download (M16), or a JSON object like
 * `{"button":"right","modifiers":["Shift"],"force":true,"popup":true}` or
 * `{"position":{"x":10,"y":20}}` to click an offset inside the element (M17).
 * Only the JSON form can express `position` — the token form cannot.
 *
 * A JSON object that does not validate returns an `error` (never a silent
 * plain click): a wrong click that still reports "passed" is worse than a
 * failed step that names the bad value.
 */
export function parseClickValue(value: string | undefined): ParsedClickValue {
  if (value === undefined || value.trim() === "") {
    return { double: false, options: {} };
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    return parseClickJson(trimmed);
  }
  return parseClickTokens(trimmed);
}

function clickError(message: string): ParsedClickValue {
  return { double: false, options: {}, error: message };
}

function isKnownModifier(value: string): value is (typeof CLICK_MODIFIERS)[number] {
  return (CLICK_MODIFIERS as readonly string[]).includes(value);
}

/** JSON click form; returns an `error` instead of falling back to a left click. */
function parseClickJson(trimmed: string): ParsedClickValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return clickError("click value is not valid JSON");
  }
  if (!isOptions(parsed)) {
    return clickError("click value must be a JSON object");
  }
  const unknownKeys = Object.keys(parsed).filter((key) => !CLICK_JSON_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return clickError(`unknown click option(s): ${unknownKeys.join(", ")}`);
  }
  const out: ClickStepOptions = {};

  const button = parsed["button"];
  if (button !== undefined) {
    if (button !== "left" && button !== "right" && button !== "middle") {
      return clickError(`unknown click button ${JSON.stringify(button)}`);
    }
    out.button = button;
  }

  const modifiers = parsed["modifiers"];
  if (modifiers !== undefined) {
    if (!Array.isArray(modifiers)) {
      return clickError("click modifiers must be an array");
    }
    const invalid = modifiers.filter(
      (modifier): boolean => typeof modifier !== "string" || !isKnownModifier(modifier),
    );
    if (invalid.length > 0) {
      return clickError(`unknown click modifier(s): ${invalid.map(String).join(", ")}`);
    }
    out.modifiers = modifiers as NonNullable<ClickStepOptions["modifiers"]>;
  }

  for (const key of ["force", "popup", "download", "double"] as const) {
    const flag = parsed[key];
    if (flag !== undefined && typeof flag !== "boolean") {
      return clickError(`click option "${key}" must be true or false`);
    }
  }
  if (parsed["force"] === true) {
    out.force = true;
  }
  if (parsed["popup"] === true) {
    out.popup = true;
  }
  if (parsed["download"] === true) {
    out.download = true;
  }

  const position = parsed["position"];
  if (position !== undefined) {
    const point = isOptions(position) ? position : null;
    const x = point?.["x"];
    const y = point?.["y"];
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      return clickError("click position must be {x, y} numbers");
    }
    out.position = { x, y };
  }

  const count = parsed["clickCount"];
  if (count !== undefined) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
      return clickError("clickCount must be a positive integer");
    }
    out.clickCount = count;
  }

  const double = parsed["double"] === true || count === 2;
  return { double, options: out };
}

/** Token click form (`"shift+right"`, `"dblclick"`, `"popup"`, …). */
function parseClickTokens(trimmed: string): ParsedClickValue {
  const options: ClickStepOptions = {};
  const tokens = trimmed
    .toLowerCase()
    .split(/[\s+,]+/)
    .flatMap((t) => t.split("-"));
  let double = false;
  const modifiers = new Set<NonNullable<ClickStepOptions["modifiers"]>[number]>();
  for (const token of tokens) {
    if (token === "" || token === "click") {
      continue;
    }
    if (token === "dblclick" || token === "double") {
      double = true;
    } else if (token === "right") {
      options.button = "right";
    } else if (token === "middle") {
      options.button = "middle";
    } else if (token === "shift") {
      modifiers.add("Shift");
    } else if (token === "ctrl" || token === "control") {
      modifiers.add("Control");
    } else if (token === "alt") {
      modifiers.add("Alt");
    } else if (token === "meta" || token === "mod" || token === "cmd") {
      modifiers.add("Meta");
    } else if (token === "force") {
      options.force = true;
    } else if (token === "popup") {
      options.popup = true;
    } else if (token === "download") {
      options.download = true;
    }
  }
  if (modifiers.size > 0) {
    options.modifiers = [...modifiers];
  }
  return { double, options };
}

/**
 * True when a click's `value` opts into the popup/download patterns (M16).
 * Used to scope the "opened a new tab" warning to plain clicks: a click that
 * already follows or saves the event needs no hint.
 */
export function clickFollowsPageEvent(value: string | undefined): boolean {
  const parsed = parseClickValue(value);
  if (parsed.error !== undefined) {
    return false;
  }
  return parsed.options.popup === true || parsed.options.download === true;
}

/**
 * Shared value encoding for `select` (multi-select) and `assert-value`
 * (`toHaveValues`): a JSON array of strings when the value looks like one,
 * else the raw string.
 */
export function parseStringList(value: string): string | string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
        return parsed as string[];
      }
    } catch {
      // Not JSON — fall through to the single-value form.
    }
  }
  return value;
}

/**
 * `type` value encoding (M17): a JSON object `{"text":"…","delay":50}` types
 * `text` with a per-keystroke `delay`; anything else is the literal text. A
 * malformed object falls back to the literal so a stray brace never breaks a run.
 */
export function parseTypeValue(value: string | undefined): { text: string; delayMs?: number } {
  if (value === undefined) {
    return { text: "" };
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isOptions(parsed) && typeof parsed["text"] === "string") {
        const delay = parsed["delay"];
        if (typeof delay === "number" && Number.isInteger(delay) && delay >= 0) {
          return { text: parsed["text"], delayMs: delay };
        }
        return { text: parsed["text"] };
      }
    } catch {
      // Not JSON — fall through to the literal form.
    }
  }
  return { text: value };
}

function isSelectOptionValue(value: unknown): value is SelectOptionValue {
  if (!isOptions(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((k) => k !== "label" && k !== "value" && k !== "index")) {
    return false;
  }
  if ("label" in value && typeof value["label"] !== "string") {
    return false;
  }
  if ("value" in value && typeof value["value"] !== "string") {
    return false;
  }
  if (
    "index" in value &&
    (typeof value["index"] !== "number" || !Number.isInteger(value["index"]))
  ) {
    return false;
  }
  return true;
}

/**
 * Select `value` encoding (no schema change): a JSON array of strings selects
 * multiple options (`["a", "b"]`), a JSON object / array of objects selects by
 * `{label|value|index}` (M15, parser encoding), anything else selects the single
 * named value/label.
 */
export function parseSelectValue(value: string): SelectOptionInput {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        if (parsed.every((v) => typeof v === "string")) {
          return parsed as string[];
        }
        if (parsed.length > 0 && parsed.every(isSelectOptionValue)) {
          return parsed as SelectOptionValue[];
        }
      } else if (isSelectOptionValue(parsed)) {
        return parsed;
      }
    } catch {
      // Not JSON — fall through to the single-value form.
    }
  }
  return value;
}

/** `/pattern/flags` → RegExp; anything else is the literal string the matcher
 * compares against. Playwright 1.64 matches plain URL/title strings exactly
 * (no glob expansion) — patterns need the `/…/flags` form.
 */
export function parseAssertMatcher(value: string): string | RegExp {
  if (value.length >= 2 && value.startsWith("/") && value.lastIndexOf("/") > 0) {
    const lastSlash = value.lastIndexOf("/");
    try {
      return new RegExp(value.slice(1, lastSlash), value.slice(lastSlash + 1));
    } catch {
      return value;
    }
  }
  return value;
}

/** First step whose `{{key}}` has no test-data entry (fail-fast pre-scan). */
export function firstMissingKey(
  steps: StepRow[],
  data: Record<string, string>,
): { stepId: string; order: number; key: string } | null {
  for (const step of steps) {
    try {
      substituteStepValue(step.value, data);
    } catch (err) {
      if (err instanceof MissingTestDataKeyError) {
        return { stepId: step.id, order: step.order, key: err.key };
      }
      throw err;
    }
  }
  return null;
}
