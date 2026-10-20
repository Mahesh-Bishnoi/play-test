import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/main/db.js";
import type { DatabaseHandle } from "../src/main/db.js";
import { createCase } from "../src/main/ipc-cases.js";
import { createProject } from "../src/main/ipc-projects.js";
import { upsertStep } from "../src/main/ipc-steps.js";
import { registerReportHandlers } from "../src/main/ipc/report.js";
import { caseRuns, stepRuns, suiteRuns } from "../src/main/schema.js";
import { getSuiteReport } from "../src/main/reports/data.js";
import { renderSuiteHtml } from "../src/main/reports/html.js";
import { writeSuiteHtmlReport } from "../src/main/reports/files.js";
import {
  CaseRunNotFoundError,
  TraceViewerError,
  expectedCaseTracePath,
  openTrace,
  openTraceForCase,
  resolveTracePath,
} from "../src/main/trace-viewer.js";
import type { TraceViewerDeps } from "../src/main/trace-viewer.js";
import { buildPlaywrightCliSpawn } from "../src/main/playwright-cli.js";
import { extractTraceCaseRunIds } from "../src/renderer/pages/RunReportPage.js";

let openHandles: DatabaseHandle[] = [];
afterEach(() => {
  for (const handle of openHandles) {
    handle.close();
  }
  openHandles = [];
});

function mkRoot(): string {
  const root = join(
    tmpdir(),
    `playtest-trace-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  return root;
}

function fakeDeps(
  root: string,
  existing: Set<string>,
): { deps: TraceViewerDeps; spawned: string[] } {
  const spawned: string[] = [];
  return {
    spawned,
    deps: {
      artifactsRoot: root,
      pathExists: (p) => existing.has(p),
      spawnShowTrace: (p) => {
        spawned.push(p);
      },
    },
  };
}

function seedRun() {
  const dbHandle = createDatabase(":memory:");
  openHandles.push(dbHandle);
  const db = dbHandle.db;
  const project = createProject(db, { name: "P" });
  const c0 = createCase(db, { projectId: project.id, name: "Login" });
  const s00 = upsertStep(db, {
    caseId: c0.id,
    step: { order: 0, action: "goto", value: "https://x.test" },
  });
  db.insert(suiteRuns)
    .values({ id: "run-1", suiteId: null, mode: "unsupervised", status: "failed", startedAt: 1 })
    .run();
  db.insert(caseRuns)
    .values({ id: "cr-0", suiteRunId: "run-1", caseId: c0.id, status: "failed" })
    .run();
  db.insert(stepRuns)
    .values({ id: "sr-0", caseRunId: "cr-0", stepId: s00.id, order: 0, status: "fail" })
    .run();
  return { db, project, c0 };
}

describe("playwright-cli spawn line (M15)", () => {
  it("runs the resolved CLI through Electron-as-Node for show-trace", () => {
    const built = buildPlaywrightCliSpawn(
      "/app/node_modules/playwright/cli.js",
      ["show-trace", "/tmp/trace.zip"],
      { detached: true },
    );
    expect(built.command).toBe(process.execPath);
    expect(built.args).toEqual([
      "/app/node_modules/playwright/cli.js",
      "show-trace",
      "/tmp/trace.zip",
    ]);
    expect(built.env["ELECTRON_RUN_AS_NODE"]).toBe("1");
    expect(built.env["PATH"]).toBe(process.env["PATH"]);
  });
});

describe("resolveTracePath", () => {
  it("accepts an in-root trace.zip that exists", () => {
    const root = mkRoot();
    const abs = join(root, "proj", "run", "case", "trace.zip");
    const { deps, spawned } = fakeDeps(root, new Set([abs]));
    expect(resolveTracePath(deps, abs)).toBe(abs);
    expect(spawned).toHaveLength(0);
  });

  it("rejects paths escaping the artifacts dir", () => {
    const root = mkRoot();
    const { deps } = fakeDeps(root, new Set());
    expect(() => resolveTracePath(deps, join(root, "..", "evil.zip"))).toThrow(TraceViewerError);
    expect(() => resolveTracePath(deps, "/etc/passwd.zip")).toThrow(TraceViewerError);
  });

  it("rejects non-zip files and missing files", () => {
    const root = mkRoot();
    const { deps } = fakeDeps(root, new Set());
    expect(() => resolveTracePath(deps, join(root, "a", "failed.webm"))).toThrow(TraceViewerError);
    expect(() => resolveTracePath(deps, join(root, "a", "trace.zip"))).toThrow(/not found/);
    expect(() => resolveTracePath(deps, "   ")).toThrow(TraceViewerError);
  });
});

describe("openTrace / openTraceForCase", () => {
  it("spawns the viewer with the absolute path", () => {
    const root = mkRoot();
    const abs = join(root, "p", "r", "c", "trace.zip");
    const { deps, spawned } = fakeDeps(root, new Set([abs]));
    expect(openTrace(deps, abs)).toEqual({ opened: true });
    expect(spawned).toEqual([abs]);
  });

  it("wraps spawn failures with the manual fallback", () => {
    const root = mkRoot();
    const abs = join(root, "p", "trace.zip");
    const deps: TraceViewerDeps = {
      artifactsRoot: root,
      pathExists: () => true,
      spawnShowTrace: () => {
        throw new Error("no display");
      },
    };
    expect(() => openTrace(deps, abs)).toThrow(/npx playwright show-trace/);
  });

  it("derives the case trace path from the artifacts layout", () => {
    const { db, project, c0 } = seedRun();
    const root = mkRoot();
    const abs = join(root, project.id, "run-1", c0.id, "trace.zip");
    const { deps, spawned } = fakeDeps(root, new Set([abs]));
    expect(expectedCaseTracePath(root, project.id, "run-1", c0.id)).toBe(abs);
    expect(openTraceForCase(db, deps, "cr-0")).toEqual({ opened: true });
    expect(spawned).toEqual([abs]);
  });

  it("throws for unknown case runs and missing traces", () => {
    const { db } = seedRun();
    const root = mkRoot();
    const { deps } = fakeDeps(root, new Set());
    expect(() => openTraceForCase(db, deps, "ghost")).toThrow(CaseRunNotFoundError);
    expect(() => openTraceForCase(db, deps, "cr-0")).toThrow(/not found/);
  });
});

describe("report:openTrace IPC", () => {
  function wired() {
    const { db, project, c0 } = seedRun();
    const root = mkRoot();
    const abs = join(root, project.id, "run-1", c0.id, "trace.zip");
    mkdirSync(join(root, project.id, "run-1", c0.id), { recursive: true });
    writeFileSync(abs, "fake-trace");
    const spawned: string[] = [];
    const listeners = new Map<string, (payload: unknown) => unknown>();
    registerReportHandlers(
      (channel, listener) => {
        listeners.set(channel, listener);
      },
      db,
      {
        artifactsRoot: root,
        renderPdf: () => Promise.resolve(new Uint8Array([1])),
        showSaveDialog: () => Promise.resolve(null),
        spawnShowTrace: (p) => {
          spawned.push(p);
        },
      },
    );
    return { listeners, spawned, abs };
  }

  it("opens by caseRunId and by explicit tracePath", () => {
    const { listeners, spawned, abs } = wired();
    expect(listeners.get("report:openTrace")?.({ caseRunId: "cr-0" })).toEqual({ opened: true });
    expect(listeners.get("report:openTrace")?.({ tracePath: abs })).toEqual({ opened: true });
    expect(spawned).toEqual([abs, abs]);
  });

  it("rejects invalid payloads and escaping paths at the boundary", () => {
    const { listeners } = wired();
    expect(() => listeners.get("report:openTrace")?.({ caseRunId: "ghost" })).toThrow(
      CaseRunNotFoundError,
    );
    expect(() => listeners.get("report:openTrace")?.({ nope: 1 })).toThrow();
    expect(() => listeners.get("report:openTrace")?.({ tracePath: "/etc/x.zip" })).toThrow(
      TraceViewerError,
    );
  });
});

describe("SuiteReport trace hint", () => {
  it("populates tracePath only when the file exists; HTML links it with data attrs", () => {
    const { db, project, c0 } = seedRun();
    const root = mkRoot();
    // No file yet → null even with root given.
    expect(getSuiteReport(db, "run-1", root).cases[0]?.tracePath).toBeNull();
    // Without root → null (backward compatible).
    expect(getSuiteReport(db, "run-1").cases[0]?.tracePath).toBeNull();
    const abs = join(root, project.id, "run-1", c0.id, "trace.zip");
    mkdirSync(join(root, project.id, "run-1", c0.id), { recursive: true });
    writeFileSync(abs, "fake-trace");
    const report = getSuiteReport(db, "run-1", root);
    expect(report.cases[0]?.tracePath).toBe(abs);
    const html = renderSuiteHtml(report, undefined, join(root, project.id, "run-1"));
    expect(html).toContain("trace.zip");
    expect(html).toContain('data-caserun="cr-0"');
    expect(extractTraceCaseRunIds(html)).toEqual(["cr-0"]);
    // Persisted HTML carries the hint too.
    const htmlPath = writeSuiteHtmlReport(db, root, "run-1");
    expect(htmlPath.endsWith("report.html")).toBe(true);
  });

  it("extractTraceCaseRunIds ignores reports without traces", () => {
    expect(extractTraceCaseRunIds("<p>no attrs</p>")).toEqual([]);
    expect(
      extractTraceCaseRunIds('<p class="muted" data-caserun="cr-1">no trace attr</p>'),
    ).toEqual([]);
  });
});

// PLAYTEST_E2E-gated: a real failing run writes trace.zip; the handler then
// resolves with a fake spawn (no GUI ever launches in tests).
describe("e2e trace artifact leg", () => {
  it.skipIf(!process.env["PLAYTEST_E2E"])(
    "failing single-case run retains trace.zip and openTrace resolves",
    async () => {
      const { SingleCaseRunner } = await import("../src/main/runner/single-runner.js");
      const { playwrightLauncher } = await import("../src/main/runner/launcher.js");
      const { createDatabase: mkDb } = await import("../src/main/db.js");
      const { createCase: mkCase } = await import("../src/main/ipc-cases.js");
      const { createProject: mkProject } = await import("../src/main/ipc-projects.js");
      const { upsertStep: mkStep } = await import("../src/main/ipc-steps.js");
      const { caseTracePath: tracePathFor } = await import("../src/main/artifacts.js");
      const { eq: eqOrm } = await import("drizzle-orm");
      const { caseRuns: caseRunsTable } = await import("../src/main/schema.js");
      const handle = mkDb(":memory:");
      openHandles.push(handle);
      const root = mkRoot();
      const project = mkProject(handle.db, { name: "P" });
      const c = mkCase(handle.db, { projectId: project.id, name: "Fail" });
      mkStep(handle.db, {
        caseId: c.id,
        step: { order: 0, action: "goto", value: "data:text/html,<h1 id=t>hi</h1>" },
      });
      mkStep(handle.db, {
        caseId: c.id,
        step: { order: 1, action: "click", selector: "#missing" },
      });
      const events: { channel: string; payload: unknown }[] = [];
      const runner = new SingleCaseRunner(handle.db, {
        launchBrowser: playwrightLauncher(),
        emit: (channel, payload) => {
          events.push({ channel, payload });
        },
        artifactsRoot: root,
      });
      const started = runner.runSingle({ caseId: c.id, mode: "unsupervised" });
      await started.done;
      const row = handle.db
        .select()
        .from(caseRunsTable)
        .where(eqOrm(caseRunsTable.id, started.caseRunId))
        .all()[0];
      expect(row?.status).toBe("failed");
      const { existsSync: exists } = await import("node:fs");
      expect(exists(tracePathFor(root, project.id, started.suiteRunId, c.id))).toBe(true);
      const spawned: string[] = [];
      const capturing: TraceViewerDeps = {
        artifactsRoot: root,
        pathExists: (p: string) => exists(p),
        spawnShowTrace: (p) => {
          spawned.push(p);
        },
      };
      expect(openTraceForCase(handle.db, capturing, started.caseRunId)).toEqual({ opened: true });
      expect(spawned).toHaveLength(1);
    },
    60000,
  );
});
