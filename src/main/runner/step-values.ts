/**
 * Step `value` encodings — the free-text forms a step's `value` column can take
 * (no schema change), plus `{{key}}` substitution. Every encoder here has a
 * matching decoder in the recorder or the step editor, so the two stay in sync
 * in one place. Pure functions, unit-tested directly.
 */

import { substituteTestDataValue } from "../../shared/step-types.js";
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

/**
 * Click `value` encoding (no schema change): empty = plain left-click,
 * legacy `"dblclick"` = double-click, `"right"` / `"middle"` = button,
 * `"shift"` / `"ctrl"` / `"alt"` / `"meta"` (+ `-click` / `+`-joined forms) =
 * modifiers, `"force"` = force click, `"popup"` / `"download"` = adopt the
 * opened page / save the triggered download (M16), or a JSON object like
 * `{"button":"right","modifiers":["Shift"],"force":true,"popup":true}` or
 * `{"position":{"x":10,"y":20}}` to click an offset inside the element (M17).
 * Only the JSON form can express `position` — the token form cannot.
 */
export function parseClickValue(value: string | undefined): {
  double: boolean;
  options: ClickStepOptions;
} {
  const options: ClickStepOptions = {};
  if (value === undefined || value.trim() === "") {
    return { double: false, options };
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    return parseClickJson(trimmed, options);
  }
  return parseClickTokens(trimmed, options);
}

/** JSON click form (`{"button":…,"position":…}`); a malformed object is a plain click. */
function parseClickJson(
  trimmed: string,
  options: ClickStepOptions,
): { double: boolean; options: ClickStepOptions } {
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const out: ClickStepOptions = {};
    if (parsed["button"] === "right" || parsed["button"] === "middle") {
      out.button = parsed["button"];
    }
    if (Array.isArray(parsed["modifiers"])) {
      const mods = (parsed["modifiers"] as unknown[]).filter(
        (m): m is NonNullable<ClickStepOptions["modifiers"]>[number] =>
          m === "Alt" || m === "Control" || m === "ControlOrMeta" || m === "Meta" || m === "Shift",
      );
      if (mods.length > 0) {
        out.modifiers = mods;
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
    if (
      typeof position === "object" &&
      position !== null &&
      typeof (position as Record<string, unknown>)["x"] === "number" &&
      typeof (position as Record<string, unknown>)["y"] === "number"
    ) {
      const { x, y } = position as { x: number; y: number };
      out.position = { x, y };
    }
    const count = parsed["clickCount"];
    if (typeof count === "number" && Number.isInteger(count) && count >= 1) {
      out.clickCount = count;
    }
    if (parsed["double"] === true || parsed["clickCount"] === 2) {
      return { double: true, options: out };
    }
    return { double: false, options: out };
  } catch {
    return { double: false, options };
  }
}

/** Token click form (`"shift+right"`, `"dblclick"`, `"popup"`, …). */
function parseClickTokens(
  trimmed: string,
  options: ClickStepOptions,
): { double: boolean; options: ClickStepOptions } {
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
  const { options } = parseClickValue(value);
  return options.popup === true || options.download === true;
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

/**
 * `/pattern/flags` → RegExp; anything else is the literal string the matcher
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
