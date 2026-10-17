/**
 * Generic worker pool for suite execution (M6): N workers drain a shared case
 * queue, each owning one lazily created browser. No error handling here — a
 * worker throw propagates to the caller's `Promise.all`.
 */

import { cpus } from "node:os";

import type { BrowserHandle } from "../runner/seams.js";

/** Default pool size: `min(cpu/2, cases)`, at least 1 (PLAN §2). */
export function defaultWorkerCount(caseCount: number): number {
  const half = Math.floor(cpus().length / 2);
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
        if (caseRunId !== undefined) {
          await o.runCase(getBrowser, caseId, caseRunId);
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
  await Promise.all(workers);
}
