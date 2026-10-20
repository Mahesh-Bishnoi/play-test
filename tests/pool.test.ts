import { describe, expect, it } from "vitest";

import type { BrowserHandle, RunContext } from "../src/main/runner/seams.js";
import { defaultWorkerCount, runCasePool } from "../src/main/suite-runner/pool.js";

function fakeBrowser(onClose: () => void): BrowserHandle {
  return {
    newContext: (): Promise<RunContext> => {
      throw new Error("not used in this test");
    },
    close: (): Promise<void> => {
      onClose();
      return Promise.resolve();
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("runCasePool failure isolation (review F6)", () => {
  it("catches a case throw, keeps draining, and relaunches after dropping the browser", async () => {
    const launched: BrowserHandle[] = [];
    const closed: BrowserHandle[] = [];
    const ran: string[] = [];
    const errors: { caseId: string; caseRunId: string }[] = [];
    const caseRunIds = new Map([
      ["a", "cr-a"],
      ["b", "cr-b"],
      ["c", "cr-c"],
    ]);
    await runCasePool({
      caseIds: ["a", "b", "c"],
      caseRunIds,
      workerCount: 1,
      isCancelled: () => false,
      launchBrowser: () => {
        let browser!: BrowserHandle;
        browser = fakeBrowser(() => {
          closed.push(browser);
        });
        launched.push(browser);
        return Promise.resolve(browser);
      },
      runCase: async (getBrowser, caseId) => {
        await getBrowser();
        ran.push(caseId);
        if (caseId === "a") {
          throw new Error("case row deleted");
        }
      },
      onCaseError: (caseId, caseRunId) => {
        errors.push({ caseId, caseRunId });
      },
    });

    expect(ran).toEqual(["a", "b", "c"]);
    expect(errors).toEqual([{ caseId: "a", caseRunId: "cr-a" }]);
    // The crashed worker's browser was dropped; `b` launched a fresh one, and
    // `c` reused it rather than launching per case.
    expect(launched).toHaveLength(2);
    expect(closed).toHaveLength(2); // crashed browser + final teardown
  });

  it("does not resolve until every worker stops", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const pool = runCasePool({
      caseIds: ["a", "b"],
      caseRunIds: new Map([
        ["a", "cr-a"],
        ["b", "cr-b"],
      ]),
      workerCount: 2,
      isCancelled: () => false,
      launchBrowser: () => Promise.resolve(fakeBrowser(() => {})),
      runCase: (_getBrowser, caseId) => {
        if (caseId === "a") {
          return Promise.reject(new Error("boom"));
        }
        return gate;
      },
      onCaseError: () => {},
    });
    void pool.then(() => {
      settled = true;
    });
    await tick();
    await tick();
    expect(settled).toBe(false);
    release();
    await pool;
    expect(settled).toBe(true);
  });

  it("computes the locked worker rule from an injectable CPU count", () => {
    expect(defaultWorkerCount(20, 8)).toBe(4);
    expect(defaultWorkerCount(2, 8)).toBe(2);
    expect(defaultWorkerCount(20, 1)).toBe(1);
    expect(defaultWorkerCount(1, 8)).toBe(1);
    expect(defaultWorkerCount(0, 8)).toBe(1);
  });
});
