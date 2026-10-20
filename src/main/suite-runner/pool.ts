/**
 * Generic worker pool for suite execution (M6): N workers drain a shared case
 * queue, each owning one lazily created browser. Failures are contained per
 * case — one broken case/browser must not reject the pool while sibling
 * workers still run (review F6).
 */

import { cpus } from "node:os";

import type { BrowserHandle } from "../runner/seams.js";

/** Default pool size: `min(cpu/2, cases)`, at least 1 (PLAN §2). */
export function defaultWorkerCount(caseCount: number, cpuCount: number = cpus().length): number {
  const half = Math.floor(cpuCount / 2);
  return Math.max(1, Math.min(half <= 0 ? 1 : half, Math.max(1, caseCount)));
}

export interface CasePoolOptions {
  caseIds: string[];
  caseRunIds: Map<string, string>;
  workerCount: number;
  isCancelled: () => boolean;
  launchBrowser: () => Promise<BrowserHandle>;
  runCase: (
    getBrowser: () => Promise<BrowserHandle>,
    caseId: string,
    caseRunId: string,
  ) => Promise<void>;
  /** Called once per case whose run threw outside its own failure paths. */
  onCaseError?: (caseId: string, caseRunId: string, error: unknown) => void;
}

export async function runCasePool(o: CasePoolOptions): Promise<void> {
  const queue = [...o.caseIds];
  const workers = Array.from({ length: o.workerCount }, async (): Promise<void> => {
    // One browser per worker (M14); every case gets a fresh context so
    // profiles never leak across cases. Created lazily so an empty or
    // fail-fast case never pays for a browser.
    const browsers: BrowserHandle[] = [];
    const getBrowser = async (): Promise<BrowserHandle> => {
      const existing = browsers[0];
      if (existing !== undefined) {
        return existing;
      }
      const created = await o.launchBrowser();
      browsers.push(created);
      return created;
    };
    try {
      while (queue.length > 0) {
        if (o.isCancelled()) {
          return;
        }
        const caseId = queue.shift();
        if (caseId === undefined) {
          return;
        }
        const caseRunId = o.caseRunIds.get(caseId);
        if (caseRunId === undefined) {
          continue;
        }
        try {
          await o.runCase(getBrowser, caseId, caseRunId);
        } catch (err) {
          // Settle just this case and drop the worker's cached browser: a
          // crashed handle must not poison every later case on this worker.
          o.onCaseError?.(caseId, caseRunId, err);
          for (const owned of browsers) {
            try {
              await owned.close();
            } catch {
              // Already closing — continue with a fresh browser next case.
            }
          }
          browsers.length = 0;
        }
      }
    } finally {
      for (const owned of browsers) {
        try {
          await owned.close();
        } catch {
          // Already closing — the suite still settles.
        }
      }
    }
  });
  // Wait for every worker: `allSettled` cannot end the suite while a sibling
  // is still writing run rows.
  await Promise.allSettled(workers);
}
