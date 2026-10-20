import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import RunProgressBar from "../src/renderer/components/RunProgressBar.js";

describe("RunProgressBar (M21 accessibility)", () => {
  it("renders a determinate progressbar with a valid value range and text", () => {
    const html = renderToStaticMarkup(
      createElement(RunProgressBar, {
        label: "Case run progress",
        state: "running",
        completed: 2,
        total: 4,
        detail: "2 of 4 steps complete",
      }),
    );
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="Case run progress"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="4"');
    expect(html).toContain('aria-valuenow="2"');
    expect(html).toContain('aria-valuetext="2 of 4 complete (50%)"');
    expect(html).toContain("pt-progress-run");
    expect(html).toContain("2 of 4 steps complete");
  });

  it("drops aria-valuenow while starting (indeterminate)", () => {
    const html = renderToStaticMarkup(
      createElement(RunProgressBar, {
        label: "Suite run",
        state: "starting",
        completed: 0,
        total: 0,
      }),
    );
    expect(html).toContain("pt-progress-indeterminate");
    expect(html).not.toContain("aria-valuenow");
    expect(html).not.toContain("aria-valuemax");
    expect(html).toContain('aria-valuetext="Starting…"');
  });

  it("uses the verdict tone and clamps impossible counts", () => {
    const html = renderToStaticMarkup(
      createElement(RunProgressBar, {
        label: "Cases",
        state: "failed",
        completed: 9,
        total: 4,
      }),
    );
    expect(html).toContain("pt-progress-fail");
    expect(html).toContain('aria-valuenow="4"');
    expect(html).toContain('aria-valuetext="4 of 4 complete (100%)"');
  });
});
