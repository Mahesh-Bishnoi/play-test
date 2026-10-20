import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { isAllowedAppUrl } from "../src/main/window-guards.js";

describe("window navigation allowlist (review F9)", () => {
  it("allows the dev-server origin in dev", () => {
    const opts = { devServerUrl: "http://localhost:5173", appFileUrl: "file:///app/index.html" };
    expect(isAllowedAppUrl("http://localhost:5173/", opts)).toBe(true);
    expect(isAllowedAppUrl("http://localhost:5173/index.html#x", opts)).toBe(true);
    expect(isAllowedAppUrl("http://127.0.0.1:5173/", opts)).toBe(false);
    expect(isAllowedAppUrl("https://evil.test/", opts)).toBe(false);
    expect(isAllowedAppUrl("file:///app/index.html", opts)).toBe(false);
  });

  it("allows only the packaged renderer entry in production", () => {
    const appFileUrl = pathToFileURL("/opt/playtest/renderer/main_window/index.html").href;
    const opts = { devServerUrl: undefined, appFileUrl };
    expect(isAllowedAppUrl(appFileUrl, opts)).toBe(true);
    expect(isAllowedAppUrl(`${appFileUrl}#/case/1`, opts)).toBe(true);
    expect(isAllowedAppUrl("file:///opt/playtest/renderer/main_window/other.html", opts)).toBe(
      false,
    );
    expect(isAllowedAppUrl("file:///etc/passwd", opts)).toBe(false);
    expect(
      isAllowedAppUrl("file://evil.test/opt/playtest/renderer/main_window/index.html", opts),
    ).toBe(false);
    expect(isAllowedAppUrl("https://example.com/", opts)).toBe(false);
    expect(isAllowedAppUrl("not a url", opts)).toBe(false);
  });
});
