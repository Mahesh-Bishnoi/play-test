import { describe, expect, it } from "vitest";

import type { Page } from "playwright";
import { devices } from "playwright";

import { attachPageDiagnostics } from "../src/main/runner/playwright-page.js";
import { resolveRecordVideoSize } from "../src/main/runner/playwright-context.js";

describe("resolveRecordVideoSize (M18)", () => {
  it("uses the explicit viewport when set", () => {
    expect(resolveRecordVideoSize({ viewport: { width: 800, height: 600 } })).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("uses the device preset's viewport instead of the 1280×720 default", () => {
    const preset = devices["iPhone 13"];
    expect(preset).toBeDefined();
    expect(resolveRecordVideoSize({ device: "iPhone 13" })).toEqual({
      width: preset?.viewport?.width,
      height: preset?.viewport?.height,
    });
  });

  it("prefers an explicit viewport over the device preset", () => {
    expect(
      resolveRecordVideoSize({ device: "iPhone 13", viewport: { width: 500, height: 700 } }),
    ).toEqual({ width: 500, height: 700 });
  });

  it("falls back to 1280×720 when neither is configured", () => {
    expect(resolveRecordVideoSize({})).toEqual({ width: 1280, height: 720 });
  });
});

describe("attachPageDiagnostics (M18)", () => {
  it("logs an uncaught page exception at the error level", () => {
    let handler: ((error: Error) => void) | undefined;
    const fakePage = {
      on: (event: string, callback: (error: Error) => void) => {
        if (event === "pageerror") {
          handler = callback;
        }
      },
    };
    const logs: Array<{ level: string; message: string }> = [];
    attachPageDiagnostics(fakePage as unknown as Page, (level, message) => {
      logs.push({ level, message });
    });
    handler?.(new Error("boom"));
    expect(logs).toEqual([{ level: "error", message: "page error: boom" }]);
  });
});
