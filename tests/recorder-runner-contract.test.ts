import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCodegenOutput } from "../src/main/recorder/codegen-output";
import { executeStep } from "../src/main/runner/execute-step";
import type { RunPage } from "../src/main/runner/seams";

/**
 * M15 acceptance (PLAN §M15 "Done when"): a recorded flow with an iframe, an
 * upload, a drag, and a reload must import into steps the runner actually
 * accepts, and an unsupported statement must be surfaced rather than dropped.
 *
 * The recorder and runner are unit-tested separately with the same pinned
 * encodings; this ties the two halves together so a drift in either side's
 * encoding contract fails here.
 */
function recordingPage(): { page: RunPage; calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  const page = new Proxy({} as RunPage, {
    get: (_target, prop) => {
      return (...args: unknown[]): Promise<unknown> => {
        calls.push({ method: String(prop), args });
        // Navigation history steps signal success so executeStep does not throw.
        return Promise.resolve(prop === "goBack" || prop === "goForward" ? true : undefined);
      };
    },
  });
  return { page, calls };
}

describe("M15 recorder → runner contract", () => {
  it("turns a recorded iframe/upload/drag/reload flow into runnable steps", async () => {
    const uploadPath = join(mkdtempSync(join(tmpdir(), "playtest-m15-")), "receipt.pdf");
    writeFileSync(uploadPath, "pdf");

    const codegen = [
      "await page.goto('https://example.com/checkout');",
      "await page.getByLabel('Search').fill('widget');",
      "await page.reload();",
      "await page.getByRole('button', { name: 'Next' }).click({ clickCount: 3 });",
      "await page.goBack();",
      "await page.frameLocator('#pay-frame').getByLabel('Card number').fill('4242');",
      `await page.locator('input[type="file"]').setInputFiles('${uploadPath}');`,
      "await page.getByRole('listitem').filter({ has: page.getByText('Product 2') }).dragTo(page.locator('#drop'));",
      "await page.getByLabel('Country').selectOption({ label: 'India' });",
      "await expect(page.getByRole('heading')).toHaveText('Checkout');",
      "await page.waitForLoadState('networkidle');",
    ].join("\n");

    const { steps, unsupported } = parseCodegenOutput(codegen);

    // The unsupported statement is reported (normalised), never silently converted.
    expect(unsupported.map((u) => u.line)).toEqual(["page.waitForLoadState('networkidle')"]);

    expect(steps.map((s) => s.action)).toEqual([
      "goto",
      "fill",
      "reload",
      "click",
      "go-back",
      "fill",
      "upload",
      "drag",
      "select",
      "assert-text-exact",
    ]);

    // Every parsed step passes the runner's own validation and dispatches.
    const { page } = recordingPage();
    for (const step of steps) {
      await expect(executeStep(page, step)).resolves.toBeUndefined();
    }
  });
});

describe("M16 recorder → runner contract", () => {
  it("turns a recorded popup flow into runnable steps that adopt the new page", async () => {
    const codegen = [
      "const page1Promise = page.waitForEvent('popup');",
      "await page.getByRole('link', { name: 'Sign in' }).click();",
      "const page1 = await page1Promise;",
      "await page1.getByRole('textbox', { name: 'Password' }).fill('pw');",
      "await page1.getByRole('button', { name: 'Sign in' }).click();",
    ].join("\n");

    const { steps, unsupported } = parseCodegenOutput(codegen);

    // The two bookkeeping lines are boilerplate: no extra steps, no noise.
    expect(unsupported).toEqual([]);
    expect(steps.map((s) => s.action)).toEqual(["click", "fill", "click"]);

    // The click that opens the popup carries the marker the runner adopts on.
    expect(JSON.parse(steps[0]!.value ?? "{}")).toMatchObject({ popup: true });

    // Subsequent steps recorded on the popup page (`page1.`) survive parsing and
    // dispatch against the adopted page like any other step.
    expect(steps[1]!.selector).toContain("getByRole('textbox'");
    expect(steps[2]!.selector).toContain("getByRole('button'");

    const { page } = recordingPage();
    for (const step of steps) {
      await expect(executeStep(page, step)).resolves.toBeUndefined();
    }
  });

  it("marks a recorded download click and keeps the wait pattern out of the steps", async () => {
    const codegen = [
      "const downloadPromise = page.waitForEvent('download');",
      "await page.getByRole('link', { name: 'Download' }).click();",
      "const download = await downloadPromise;",
    ].join("\n");

    const { steps, unsupported } = parseCodegenOutput(codegen);

    expect(unsupported).toEqual([]);
    expect(steps.map((s) => s.action)).toEqual(["click"]);
    expect(JSON.parse(steps[0]!.value ?? "{}")).toMatchObject({ download: true });

    const { page } = recordingPage();
    await expect(executeStep(page, steps[0]!)).resolves.toBeUndefined();
  });
});
