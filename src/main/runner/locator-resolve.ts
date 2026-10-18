/**
 * Resolve a stored step selector to a Playwright Locator.
 *
 * The recorder keeps codegen chains verbatim (`getByRole('link', …)`,
 * `getByText(…)`, `locator('…')`, `frameLocator('…')`), which
 * `page.locator(string)` cannot parse — it expects CSS/XPath and throws
 * `Unsupported token "{" …`. Plain CSS (or Playwright engine syntax like
 * `text=…`) falls through to `page.locator`.
 *
 * Never `eval`s the selector: the chain name allowlist plus the strict literal
 * parser (`locator-literals.ts`) keep recorder content from becoming code
 * execution in the main process.
 */

import type { FrameLocator, Locator, Page } from "playwright";

import {
  CHAIN_METHODS,
  PAGE_FACTORY_METHODS,
  splitTopLevel,
} from "../../shared/locator-allowlist.js";
import { StepExecutionError, unsupportedSelector } from "./errors.js";
import { LiteralParser } from "./locator-literals.js";
import { isOptions } from "./step-values.js";

/**
 * A chain may enter an iframe (`page.frameLocator('#f')`) but must end on a
 * Locator — a FrameLocator is not actionable, so a chain that stops on the
 * frame fails with guidance.
 */
export function resolveLocator(page: Page, selector: string): Locator {
  const segments = splitLocatorChain(selector);
  if (segments === null) {
    return page.locator(selector);
  }
  const [first, ...rest] = segments;
  if (first === undefined) {
    throw new StepExecutionError(
      `unsupported selector "${selector}": empty — edit the step to a CSS selector or a getByRole/getByText/locator/frameLocator chain`,
    );
  }
  let current: LocatorNode;
  const factory = parseCall(first, selector);
  if (factory.name === "frameLocator") {
    current = {
      kind: "frame",
      value: page.frameLocator(frameLocatorSelector(factory.args, selector)),
    };
  } else {
    current = { kind: "locator", value: applyFactory(page, first, selector) };
  }
  for (const segment of rest) {
    current = applyChainStep(current, segment, selector, page);
  }
  if (current.kind === "frame") {
    throw new StepExecutionError(
      `unsupported selector "${selector}": a frame is not actionable — add a locator inside it (e.g. .getByRole(…))`,
    );
  }
  return current.value;
}

/**
 * Split `getByRole(…).filter(…).first()` on top-level dots, or return null
 * when the selector is plain CSS/engine syntax (no codegen-chain head).
 * Throws StepExecutionError for chains starting with a non-locator call
 * (`page.evaluate(…)`, `frameLocator(…)`, …) so the step fails with guidance
 * instead of a CSS parse error.
 */
function splitLocatorChain(selector: string): string[] | null {
  let text = selector.trim();
  if (text.startsWith("page.")) {
    text = text.slice("page.".length).trim();
  }
  if (text === "") {
    throw new StepExecutionError("step needs a selector");
  }
  const head = /^([A-Za-z_$][\w$]*)/.exec(text)?.[1];
  if (head === undefined) {
    return null;
  }
  if (!PAGE_FACTORY_METHODS.has(head)) {
    if (/^[A-Za-z_$][\w$]*\(/.test(text)) {
      throw unsupportedSelector(selector, `"${head}(…)" is not a locator`);
    }
    return null;
  }
  const segments = splitTopLevel(text, ".");
  for (const segment of segments) {
    if (segment === "") {
      throw unsupportedSelector(selector, "empty chain segment");
    }
    const name = /^([A-Za-z_$][\w$]*)/.exec(segment)?.[1];
    if (name === undefined || !CHAIN_METHODS.has(name)) {
      throw unsupportedSelector(selector, `"${segment}" is not a supported locator step`);
    }
  }
  return segments;
}

interface ParsedCall {
  name: string;
  args: unknown[];
}

function parseCall(segment: string, full: string): ParsedCall {
  const bare = /^([A-Za-z_$][\w$]*)$/.exec(segment)?.[1];
  if (bare !== undefined) {
    return { name: bare, args: [] };
  }
  const call = /^([A-Za-z_$][\w$]*)\((.*)\)$/s.exec(segment);
  if (call?.[1] === undefined || call[2] === undefined) {
    throw unsupportedSelector(full, `cannot parse "${segment}"`);
  }
  return { name: call[1], args: parseArgList(call[2], full) };
}

function parseArgList(argsText: string, full: string): unknown[] {
  if (argsText.trim() === "") {
    return [];
  }
  if (argsText.length > 10000) {
    throw unsupportedSelector(full, "argument list too long");
  }
  return splitTopLevel(argsText, ",").map((arg) => parseJsLiteral(arg, full));
}

function parseJsLiteral(text: string, full: string): unknown {
  return new LiteralParser(text, full).parse();
}

/** A resolved chain node — a Locator (actionable) or a FrameLocator (waypoint). */
type LocatorNode = { kind: "frame"; value: FrameLocator } | { kind: "locator"; value: Locator };

/** `frameLocator('css')` needs a non-empty selector string. */
function frameLocatorSelector(args: unknown[], full: string): string {
  const [selector] = args;
  if (typeof selector !== "string" || selector === "") {
    throw unsupportedSelector(full, `frameLocator needs a selector`);
  }
  return selector;
}

/**
 * Dispatch the shared `getBy*` factories on a Page, Locator, or FrameLocator
 * (all three expose identical signatures and return a Locator). Returns null
 * when `name` is not a `getBy*` method so the caller can handle its own steps.
 */
function applyGetBy(
  host: Page | Locator | FrameLocator,
  name: string,
  args: unknown[],
  full: string,
): Locator | null {
  const target = host as Locator;
  switch (name) {
    case "getByRole": {
      const [role, options] = args;
      if (typeof role !== "string" || (options !== undefined && !isOptions(options))) {
        throw unsupportedSelector(full, `getByRole needs (role, options?)`);
      }
      return target.getByRole(
        role as Parameters<Locator["getByRole"]>[0],
        options as Parameters<Locator["getByRole"]>[1],
      );
    }
    case "getByText": {
      const [text, options] = args;
      if (
        (typeof text !== "string" && !(text instanceof RegExp)) ||
        (options !== undefined && !isOptions(options))
      ) {
        throw unsupportedSelector(full, `getByText needs (text, options?)`);
      }
      return target.getByText(text, options as Parameters<Locator["getByText"]>[1]);
    }
    case "getByLabel": {
      const [text, options] = args;
      if (
        (typeof text !== "string" && !(text instanceof RegExp)) ||
        (options !== undefined && !isOptions(options))
      ) {
        throw unsupportedSelector(full, `getByLabel needs (text, options?)`);
      }
      return target.getByLabel(text, options as Parameters<Locator["getByLabel"]>[1]);
    }
    case "getByPlaceholder": {
      const [text, options] = args;
      if (
        (typeof text !== "string" && !(text instanceof RegExp)) ||
        (options !== undefined && !isOptions(options))
      ) {
        throw unsupportedSelector(full, `getByPlaceholder needs (text, options?)`);
      }
      return target.getByPlaceholder(text, options as Parameters<Locator["getByPlaceholder"]>[1]);
    }
    case "getByAltText": {
      const [text, options] = args;
      if (
        (typeof text !== "string" && !(text instanceof RegExp)) ||
        (options !== undefined && !isOptions(options))
      ) {
        throw unsupportedSelector(full, `getByAltText needs (text, options?)`);
      }
      return target.getByAltText(text, options as Parameters<Locator["getByAltText"]>[1]);
    }
    case "getByTitle": {
      const [text, options] = args;
      if (
        (typeof text !== "string" && !(text instanceof RegExp)) ||
        (options !== undefined && !isOptions(options))
      ) {
        throw unsupportedSelector(full, `getByTitle needs (text, options?)`);
      }
      return target.getByTitle(text, options as Parameters<Locator["getByTitle"]>[1]);
    }
    case "getByTestId": {
      const [id] = args;
      if (typeof id !== "string" && !(id instanceof RegExp)) {
        throw unsupportedSelector(full, `getByTestId needs (testId)`);
      }
      return target.getByTestId(id);
    }
    default:
      return null;
  }
}

function applyFactory(page: Page, segment: string, full: string): Locator {
  const { name, args } = parseCall(segment, full);
  const found = applyGetBy(page, name, args, full);
  if (found !== null) {
    return found;
  }
  if (name === "locator") {
    const [sel, options] = args;
    if (typeof sel !== "string" || (options !== undefined && !isOptions(options))) {
      throw unsupportedSelector(full, `locator needs (selector, options?)`);
    }
    return page.locator(
      sel,
      resolveLocatorOptions(options, full, page) as Parameters<Page["locator"]>[1],
    );
  }
  throw unsupportedSelector(full, `"${name}(…)" is not a locator`);
}

/**
 * Apply one chain segment to the current node. A `FrameLocator` chain keeps
 * only the frame methods (`getBy*`, `locator`, nested `frameLocator`, `first`,
 * `last`, `nth` — no `filter`); a `Locator` chain keeps the full set.
 */
function applyChainStep(
  current: LocatorNode,
  segment: string,
  full: string,
  page: Page,
): LocatorNode {
  const { name, args } = parseCall(segment, full);
  if (current.kind === "frame") {
    return applyFrameChainStep(current.value, name, args, full, page);
  }
  return { kind: "locator", value: applyLocatorChainStep(current.value, name, args, full, page) };
}

function applyFrameChainStep(
  current: FrameLocator,
  name: string,
  args: unknown[],
  full: string,
  page: Page,
): LocatorNode {
  if (name === "frameLocator") {
    return { kind: "frame", value: current.frameLocator(frameLocatorSelector(args, full)) };
  }
  if (name === "first") {
    if (args.length !== 0) {
      throw unsupportedSelector(full, `first takes no arguments`);
    }
    return { kind: "frame", value: current.first() };
  }
  if (name === "last") {
    if (args.length !== 0) {
      throw unsupportedSelector(full, `last takes no arguments`);
    }
    return { kind: "frame", value: current.last() };
  }
  if (name === "nth") {
    const [index] = args;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      throw unsupportedSelector(full, `nth needs a non-negative integer`);
    }
    return { kind: "frame", value: current.nth(index) };
  }
  if (name === "locator") {
    const [sel, options] = args;
    if (typeof sel !== "string" || (options !== undefined && !isOptions(options))) {
      throw unsupportedSelector(full, `locator needs (selector, options?)`);
    }
    return {
      kind: "locator",
      value: current.locator(
        sel,
        resolveLocatorOptions(options, full, page) as Parameters<FrameLocator["locator"]>[1],
      ),
    };
  }
  const found = applyGetBy(current, name, args, full);
  if (found !== null) {
    return { kind: "locator", value: found };
  }
  if (name === "filter") {
    throw unsupportedSelector(
      full,
      `a frame cannot be filtered — locate an element inside the frame instead`,
    );
  }
  throw unsupportedSelector(full, `"${name}(…)" is not a supported frame locator step`);
}

function applyLocatorChainStep(
  current: Locator,
  name: string,
  args: unknown[],
  full: string,
  page: Page,
): Locator {
  const found = applyGetBy(current, name, args, full);
  if (found !== null) {
    return found;
  }
  switch (name) {
    case "locator": {
      const [sel, options] = args;
      if (typeof sel !== "string" || (options !== undefined && !isOptions(options))) {
        throw unsupportedSelector(full, `locator needs (selector, options?)`);
      }
      return current.locator(
        sel,
        resolveLocatorOptions(options, full, page) as Parameters<Locator["locator"]>[1],
      );
    }
    case "filter": {
      const [options] = args;
      if (options !== undefined && !isOptions(options)) {
        throw unsupportedSelector(full, `filter needs ({ hasText?, … })`);
      }
      return current.filter(
        resolveLocatorOptions(options, full, page) as Parameters<Locator["filter"]>[0],
      );
    }
    case "first": {
      if (args.length !== 0) {
        throw unsupportedSelector(full, `first takes no arguments`);
      }
      return current.first();
    }
    case "last": {
      if (args.length !== 0) {
        throw unsupportedSelector(full, `last takes no arguments`);
      }
      return current.last();
    }
    case "nth": {
      const [index] = args;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
        throw unsupportedSelector(full, `nth needs a non-negative integer`);
      }
      return current.nth(index);
    }
    case "and":
    case "or":
    case "within": {
      const [chain] = args;
      if (args.length !== 1 || typeof chain !== "string" || chain.trim() === "") {
        throw unsupportedSelector(
          full,
          `${name} needs a locator chain (e.g. ${name}(page.getByText('x')))`,
        );
      }
      const other = resolveLocator(page, chain);
      if (name === "or") {
        return current.or(other);
      }
      return name === "and" ? current.and(other) : current.within(other);
    }
    case "describe": {
      const [description] = args;
      if (args.length !== 1 || typeof description !== "string" || description.trim() === "") {
        throw unsupportedSelector(full, `describe needs a description string`);
      }
      return current.describe(description);
    }
    default:
      throw unsupportedSelector(full, `"${name}(…)" is not a supported locator step`);
  }
}

/** Locator/filter option keys the parser may emit; anything else is rejected. */
const ALLOWED_LOCATOR_OPTION_KEYS: ReadonlySet<string> = new Set([
  "has",
  "hasNot",
  "hasText",
  "hasNotText",
  "visible",
]);

/**
 * `has`/`hasNot` take a Locator, which the literal parser cannot produce — the
 * parser emits a nested locator chain string instead (M15). Resolve that chain
 * against the page (still no eval, same allowlist/parser) and hand Playwright a
 * real Locator. Unknown option keys are still rejected so recorder content
 * cannot smuggle arbitrary options through.
 */
function resolveLocatorOptions(
  options: unknown,
  full: string,
  page: Page,
): Record<string, unknown> | undefined {
  if (options === undefined) {
    return undefined;
  }
  if (!isOptions(options)) {
    throw unsupportedSelector(full, `locator options must be an object`);
  }
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (!ALLOWED_LOCATOR_OPTION_KEYS.has(key)) {
      throw unsupportedSelector(full, `unknown locator option "${key}"`);
    }
    if (key === "has" || key === "hasNot") {
      if (typeof value !== "string" || value.trim() === "") {
        throw unsupportedSelector(
          full,
          `${key} needs a locator chain string (e.g. ${key}: page.getByText('x'))`,
        );
      }
      resolved[key] = resolveLocator(page, value);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}
