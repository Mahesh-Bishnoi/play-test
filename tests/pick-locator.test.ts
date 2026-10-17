import { describe, expect, it } from "vitest";

import { validatePastedLocator } from "../src/renderer/components/pick-locator.js";

describe("validatePastedLocator (M10 pick-locator)", () => {
  it("accepts the DoD getByRole chain", () => {
    const result = validatePastedLocator("getByRole('button', { name: 'File' })");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selector).toBe("getByRole('button', { name: 'File' })");
    }
  });

  it("accepts a page.-prefixed chain plus filter/first/nth positionals", () => {
    expect(validatePastedLocator("page.getByRole('link', { name: 'Blog' })").ok).toBe(true);
    const chained = validatePastedLocator("locator('#a').filter({ hasText: 'x' }).first()");
    expect(chained.ok).toBe(true);
    expect(validatePastedLocator("locator('li').nth(2)").ok).toBe(true);
    expect(validatePastedLocator("getByText(/hello/i)").ok).toBe(true);
  });

  it("accepts plain CSS / engine syntax as-is (runner falls through to page.locator)", () => {
    for (const css of ["#login", ".btn-primary", "text=Sign in", "div.submit"]) {
      const result = validatePastedLocator(css);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.selector).toBe(css);
      }
    }
  });

  it("strips a pasted statement shell (await / trailing semicolon)", () => {
    const result = validatePastedLocator("await page.getByRole('button', { name: 'File' });");
    expect(result).toEqual({
      ok: true,
      selector: "page.getByRole('button', { name: 'File' })",
    });
  });

  it("rejects the DoD page.evaluate paste with edit guidance and no selector", () => {
    const result = validatePastedLocator("page.evaluate(() => 1)");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/unsupported selector/);
      expect(result.error).toMatch(/CSS selector/);
    }
  });

  it("accepts frameLocator chains (page-level and nested, M15)", () => {
    const pageLevel = "page.frameLocator('#payment-frame').getByRole('button', { name: 'Pay' })";
    expect(validatePastedLocator(pageLevel)).toEqual({ ok: true, selector: pageLevel });
    expect(validatePastedLocator("frameLocator('iframe').getByText('Continue')").ok).toBe(true);
    expect(
      validatePastedLocator("page.frameLocator('#outer').frameLocator('#inner').locator('button')")
        .ok,
    ).toBe(true);
  });

  it("rejects an unsupported segment inside a frameLocator chain", () => {
    const result = validatePastedLocator(
      "frameLocator('#f').getByRole('button').evaluate(() => 1)",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/unsupported selector/);
    }
  });

  it("rejects non-locator chains instead of executing them", () => {
    for (const bad of [
      "frameLocator('#f').evaluate(() => 1)",
      "locator('#a').evaluate(() => 1)",
      "getByRole('x'); process.exit(1)",
    ]) {
      const result = validatePastedLocator(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/unsupported selector/);
      }
    }
  });

  it("rejects empty and multi-line pastes without creating a step", () => {
    expect(validatePastedLocator("   ").ok).toBe(false);
    const multi = validatePastedLocator("getByRole('a')\ngetByRole('b')");
    expect(multi.ok).toBe(false);
    if (!multi.ok) {
      expect(multi.error).toMatch(/single locator|locator only/);
    }
  });
});
