import { describe, expect, it } from "vitest";

import type { Page } from "playwright";

import { resolveLocator } from "../src/main/runner.js";

// Minimal recording stand-in for a Playwright Page/Locator chain. The
// resolver only calls allowlisted factory/filter/positional methods, so the
// fake implements exactly those and records how it was reached.
class FakeLocator {
  readonly steps: string[] = [];
  filterArgs: unknown[] = [];
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
  locator(sel: unknown): this {
    return this.record(`locator(${JSON.stringify(sel)})`);
  }
  filter(options: unknown): this {
    this.filterArgs.push(options);
    return this.record("filter");
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
    expect(() => resolve("frameLocator('#f').getByRole('button')")).toThrow(/unsupported selector/);
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
});
