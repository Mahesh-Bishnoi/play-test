import { describe, expect, it } from "vitest";

import type { Page } from "playwright";

import { resolveLocator } from "../src/main/runner/locator-resolve.js";

// Minimal recording stand-in for a Playwright Page/Locator chain. The
// resolver only calls allowlisted factory/filter/positional methods, so the
// fake implements exactly those and records how it was reached.
class FakeLocator {
  readonly steps: string[] = [];
  filterArgs: unknown[] = [];
  combinatorArgs: unknown[] = [];
  nthArgs: unknown[] = [];

  private record(step: string): this {
    this.steps.push(step);
    return this;
  }

  getByRole(role: unknown, options?: unknown): this {
    return this.record(`getByRole(${JSON.stringify(role)},${JSON.stringify(options ?? null)})`);
  }
  getByText(text: unknown, options?: unknown): this {
    return this.record(`getByText(${JSON.stringify(text)},${JSON.stringify(options ?? null)})`);
  }
  getByTestId(id: unknown): this {
    return this.record(`getByTestId(${JSON.stringify(id)})`);
  }
  locator(sel: unknown): this {
    return this.record(`locator(${JSON.stringify(sel)})`);
  }
  frameLocator(sel: unknown): this {
    return this.record(`frameLocator(${JSON.stringify(sel)})`);
  }
  filter(options: unknown): this {
    this.filterArgs.push(options);
    return this.record("filter");
  }
  and(other: unknown): this {
    this.combinatorArgs.push(other);
    return this.record("and");
  }
  or(other: unknown): this {
    this.combinatorArgs.push(other);
    return this.record("or");
  }
  within(other: unknown): this {
    this.combinatorArgs.push(other);
    return this.record("within");
  }
  describe(description: unknown): this {
    return this.record(`describe(${JSON.stringify(description)})`);
  }
  first(): this {
    return this.record("first");
  }
  last(): this {
    return this.record("last");
  }
  nth(index: unknown): this {
    this.nthArgs.push(index);
    return this.record(`nth(${String(index)})`);
  }
}

class FakePage extends FakeLocator {
  pageCalls: string[] = [];

  override locator(sel: unknown): this {
    this.pageCalls.push(`page.locator(${JSON.stringify(sel)})`);
    return super.locator(sel);
  }
  override getByRole(role: unknown, options?: unknown): this {
    this.pageCalls.push("page.getByRole");
    return super.getByRole(role, options);
  }
  override getByText(text: unknown, options?: unknown): this {
    this.pageCalls.push("page.getByText");
    return super.getByText(text, options);
  }
  override frameLocator(sel: unknown): this {
    this.pageCalls.push(`page.frameLocator(${JSON.stringify(sel)})`);
    return super.frameLocator(sel);
  }
}

function resolve(selector: string): FakePage {
  const page = new FakePage();
  resolveLocator(page as unknown as Page, selector);
  return page;
}

describe("resolveLocator (recorder getBy* chains)", () => {
  it("passes plain CSS through to page.locator", () => {
    const page = resolve("#go");
    expect(page.pageCalls).toEqual(['page.locator("#go")']);
  });

  it("dispatches the recorded Blog click to getByRole instead of CSS", () => {
    const page = resolve("getByRole('link', { name: 'Blog', exact: true })");
    expect(page.pageCalls).toEqual(["page.getByRole"]);
    expect(page.steps).toEqual(['getByRole("link",{"name":"Blog","exact":true})']);
  });

  it("dispatches getByText and locator() factories", () => {
    const textPage = resolve("getByText('Hello world')");
    expect(textPage.pageCalls).toEqual(["page.getByText"]);

    const cssPage = resolve("locator('#main')");
    expect(cssPage.pageCalls).toEqual(['page.locator("#main")']);
  });

  it("resolves chained filter/first/nth without executing code", () => {
    const page = resolve("locator('#a').filter({ hasText: 'x' }).first()");
    expect(page.steps).toEqual(['locator("#a")', "filter", "first"]);
  });

  it("rejects non-locator JS instead of executing it", () => {
    expect(() => resolve("page.evaluate(() => 1)")).toThrow(/unsupported selector/);
    expect(() => resolve("contentFrame()")).toThrow(/unsupported selector/);
    // Would exit the process if ever eval'd — must throw instead.
    expect(() => resolve("getByRole('x'); process.exit(1)")).toThrow(/unsupported selector/);
    expect(() => resolve("locator('#a').evaluate(() => 1)")).toThrow(/unsupported selector/);
  });

  it("handles escapes, regex, page. prefix, and positional chains", () => {
    const escaped = resolve("getByRole('link', { name: 'O\\'Brien' })");
    expect(escaped.pageCalls).toEqual(["page.getByRole"]);

    const regex = new FakePage();
    let seen: unknown;
    regex.getByText = ((text: unknown) => {
      seen = text;
      return regex;
    }) as FakePage["getByText"];
    resolveLocator(regex as unknown as Page, "getByText(/hello/i)");
    expect(seen).toBeInstanceOf(RegExp);

    const prefixed = resolve("page.getByRole('link', { name: 'Blog' })");
    expect(prefixed.pageCalls).toEqual(["page.getByRole"]);

    const positional = resolve("locator('li').nth(2)");
    expect(positional.steps).toEqual(['locator("li")', "nth(2)"]);
  });

  it("resolves frameLocator chains, including nested frames and positional steps", () => {
    const page = resolve("page.frameLocator('#f').getByRole('button')");
    expect(page.pageCalls).toEqual(['page.frameLocator("#f")', "page.getByRole"]);
    expect(page.steps).toEqual(['frameLocator("#f")', 'getByRole("button",null)']);

    const nested = resolve("frameLocator('#f').frameLocator('#g').locator('.row')");
    expect(nested.steps).toEqual(['frameLocator("#f")', 'frameLocator("#g")', 'locator(".row")']);

    const positional = resolve("frameLocator('#f').first().getByText('Hi')");
    expect(positional.steps).toEqual(['frameLocator("#f")', "first", 'getByText("Hi",null)']);

    const nth = resolve("frameLocator('#f').nth(1).getByTestId('x')");
    expect(nth.nthArgs).toEqual([1]);
  });

  it("rejects a chain that ends on a frame instead of an element", () => {
    // A FrameLocator is a waypoint, not actionable.
    expect(() => resolve("frameLocator('#f')")).toThrow(/add a locator inside/i);
    expect(() => resolve("frameLocator('#f').frameLocator('#g')")).toThrow(/add a locator inside/i);
  });

  it("resolves a nested locator chain passed to filter({ has | hasNot })", () => {
    const page = resolve("getByRole('listitem').filter({ has: page.getByText('Product 2') })");
    expect(page.steps).toContain("filter");
    // The inner chain was resolved against the page (recorded as a page call),
    // not passed through as a raw string.
    expect(page.pageCalls).toEqual(["page.getByRole", "page.getByText"]);
    const options = page.filterArgs[0] as { has: unknown };
    expect(options.has).toBeInstanceOf(FakeLocator);

    const css = resolve("locator('.row').filter({ hasNot: page.locator('.hidden') })");
    expect(css.pageCalls).toEqual(['page.locator(".row")', 'page.locator(".hidden")']);
  });

  it("rejects a non-chain value for has/hasNot and unknown locator options", () => {
    expect(() => resolve("locator('.row').filter({ has: 3 })")).toThrow(/locator chain/);
    expect(() => resolve("locator('.row').filter({ mystery: true })")).toThrow(
      /unknown locator option/,
    );
  });

  it("resolves locator combinator chains (and/or) to real locators (M18)", () => {
    const either = resolve("locator('#a').or(page.getByText('b'))");
    // The fake returns itself from every factory, so the nested chain's call
    // appears on the same recorder before the combinator (real Playwright
    // hands back a separate Locator).
    expect(either.steps).toEqual(['locator("#a")', 'getByText("b",null)', "or"]);
    expect(either.pageCalls).toEqual(['page.locator("#a")', "page.getByText"]);
    expect(either.combinatorArgs[0]).toBe(either);

    const both = resolve("getByRole('button').and(locator('.primary'))");
    expect(both.steps).toEqual(['getByRole("button",null)', 'locator(".primary")', "and"]);
    expect(both.combinatorArgs[0]).toBe(both);

    const scoped = resolve("getByRole('cell').nth(2).within(page.getByRole('row'))");
    expect(scoped.steps).toEqual([
      'getByRole("cell",null)',
      "nth(2)",
      'getByRole("row",null)',
      "within",
    ]);

    const described = resolve("getByRole('button').describe('Subscribe button')");
    expect(described.steps).toEqual(['getByRole("button",null)', 'describe("Subscribe button")']);

    expect(() => resolve("locator('#a').or(3)")).toThrow(/locator chain/);
    expect(() => resolve("locator('#a').describe(3)")).toThrow(/description string/);
    expect(() => resolve("frameLocator('#f').or(locator('.x'))")).toThrow(/frame locator/);
  });
});
