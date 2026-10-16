import { describe, expect, it } from "vitest";

import { renderSuiteHtml, type SuiteReport } from "../src/main/reports.js";
import { reportHasFailures } from "../src/renderer/pages/RunReportPage.js";

function makeReport(failed: number): SuiteReport {
  const passed = failed > 0 ? 0 : 1;
  return {
    suiteRunId: "run-1",
    suiteName: "S",
    mode: "unsupervised",
    status: failed > 0 ? "failed" : "passed",
    startedAt: 1000,
    endedAt: 2000,
    summary: { total: 1, passed, failed, skipped: 0 },
    cases: [],
  };
}

describe("reportHasFailures", () => {
  it("returns false for the clean summary row rendered by renderSuiteHtml", () => {
    expect(reportHasFailures(renderSuiteHtml(makeReport(0)))).toBe(false);
  });

  it("returns true for the failed summary row rendered by renderSuiteHtml", () => {
    expect(reportHasFailures(renderSuiteHtml(makeReport(2)))).toBe(true);
  });

  it("falls back to fail cells when the summary row is missing", () => {
    expect(reportHasFailures('<table><tr><td class="x">fail</td></tr></table>')).toBe(true);
  });

  it("falls back to failed spans when the summary row is missing", () => {
    expect(reportHasFailures('<h3>Case — <span class="failed">failed</span></h3>')).toBe(true);
  });

  it("returns false for unrelated html, even when failure words appear without tags", () => {
    expect(reportHasFailures("<h3>failover test</h3><p>all good</p>")).toBe(false);
  });
});
