import { describe, expect, it } from "vitest";

import { createDatabase } from "../src/main/db.js";
import type { IpcHandleFn } from "../src/main/ipc-register.js";
import {
  registerProfileHandlers,
  registerProjectHandlers,
  registerRecorderHandlers,
} from "../src/main/ipc-register.js";
import { CodegenRecorder } from "../src/main/recorder.js";
import type { CodegenChild, RecorderDeps } from "../src/main/recorder.js";
import { createCase } from "../src/main/ipc-cases.js";
import { createProject } from "../src/main/ipc-projects.js";
import { ProjectSchema } from "../src/shared/schema.js";

/** In-memory fake for ipcMain.handle: captures listeners per channel. */
function fakeIpc(): { handle: IpcHandleFn; call: (channel: string, payload: unknown) => unknown } {
  const listeners = new Map<string, (payload: unknown) => unknown>();
  return {
    handle: (channel, listener) => {
      listeners.set(channel, listener);
    },
    call: (channel, payload) => {
      const listener = listeners.get(channel);
      if (listener === undefined) {
        throw new Error(`no handler for ${channel}`);
      }
      return listener(payload);
    },
  };
}

/** Minimal live codegen child (never exits) for the recorder fakes. */
function fakeChild(): CodegenChild {
  return {
    pid: 7,
    kill: () => true,
    hasExited: () => false,
    stderrTail: () => "",
  };
}

describe("registerProjectHandlers", () => {
  it("round-trips create/list/get/update/delete through the fake IPC surface", () => {
    const dbHandle = createDatabase(":memory:");
    try {
      const ipc = fakeIpc();
      registerProjectHandlers(ipc.handle, dbHandle.db);

      const created = ProjectSchema.parse(ipc.call("project:create", { name: "Smoke" }));
      expect(created.name).toBe("Smoke");

      const listed = ipc.call("project:list", {}) as unknown[];
      expect(listed).toHaveLength(1);

      const fetched = ProjectSchema.parse(ipc.call("project:get", { id: created.id }));
      expect(fetched.id).toBe(created.id);

      const updated = ProjectSchema.parse(
        ipc.call("project:update", { id: created.id, name: "Renamed" }),
      );
      expect(updated.name).toBe("Renamed");

      expect(ipc.call("project:delete", { id: created.id })).toBeNull();
      expect(ipc.call("project:list", {}) as unknown[]).toHaveLength(0);
    } finally {
      dbHandle.close();
    }
  });

  it("rejects invalid payloads and unknown ids with errors", () => {
    const dbHandle = createDatabase(":memory:");
    try {
      const ipc = fakeIpc();
      registerProjectHandlers(ipc.handle, dbHandle.db);

      expect(() => ipc.call("project:create", { name: "" })).toThrow();
      expect(() => ipc.call("project:get", { id: "missing" })).toThrow(/not found/);
    } finally {
      dbHandle.close();
    }
  });
});

describe("registerProfileHandlers (M14)", () => {
  it("registers profile:get/profile:set and round-trips a profile", () => {
    const dbHandle = createDatabase(":memory:");
    try {
      const ipc = fakeIpc();
      registerProfileHandlers(ipc.handle, dbHandle.db);
      const project = createProject(dbHandle.db, { name: "P" });
      const testCase = createCase(dbHandle.db, { projectId: project.id, name: "C" });

      expect(ipc.call("profile:get", { caseId: testCase.id })).toEqual({ profile: null });

      const saved = ipc.call("profile:set", {
        caseId: testCase.id,
        profile: { device: "iPhone 11", colorScheme: "dark" },
      }) as { device?: string; colorScheme?: string };
      expect(saved).toMatchObject({ device: "iPhone 11", colorScheme: "dark" });

      const fetched = ipc.call("profile:get", { caseId: testCase.id }) as {
        profile: { device?: string } | null;
      };
      expect(fetched.profile?.device).toBe("iPhone 11");

      // An all-empty profile clears the row (back to defaults).
      expect(ipc.call("profile:set", { caseId: testCase.id, profile: {} })).toBeNull();
      expect(ipc.call("profile:get", { caseId: testCase.id })).toEqual({ profile: null });

      // A profile hangs off a case — an unknown id must not write a row.
      expect(() => ipc.call("profile:set", { caseId: "ghost", profile: {} })).toThrow(/not found/);
      expect(() => ipc.call("profile:get", {})).toThrow();
    } finally {
      dbHandle.close();
    }
  });
});

describe("registerRecorderHandlers (M15)", () => {
  const CODE = [
    "await page.goto('https://example.com');",
    "await page.request.get('https://api.test/health');",
  ].join("\n");

  /** A real recorder over injected fakes so the handler envelope is exercised. */
  function recorderWith(code: string): CodegenRecorder {
    const deps: RecorderDeps = {
      spawnCodegen: () => fakeChild(),
      readOutput: () => code,
      discardOutput: () => undefined,
      makeOutputPath: () => "/tmp/playtest-codegen-ipc.js",
      waitMs: () => Promise.resolve(),
      startGracePeriodMs: 0,
    };
    return new CodegenRecorder(deps);
  }

  it("resolves recorder:start async and returns steps + unsupported + raw from recorder:stop", async () => {
    const dbHandle = createDatabase(":memory:");
    try {
      const ipc = fakeIpc();
      const project = createProject(dbHandle.db, { name: "P", baseUrl: "https://example.com" });
      const testCase = createCase(dbHandle.db, { projectId: project.id, name: "C" });
      const recorder = recorderWith(CODE);
      registerRecorderHandlers(ipc.handle, dbHandle.db, {
        artifactsRoot: "/tmp/playtest-artifacts",
        recorder,
      });

      await expect(ipc.call("recorder:start", { caseId: testCase.id })).resolves.toEqual({
        pid: 7,
      });

      const stopped = ipc.call("recorder:stop", {}) as {
        steps: unknown[];
        unsupported: Array<{ line: string; reason: string }>;
        raw: string;
      };
      expect(stopped.steps).toHaveLength(1);
      expect(stopped.unsupported).toHaveLength(1);
      expect(stopped.unsupported[0]?.line).toContain("page.request.get");
      expect(stopped.unsupported[0]?.reason).toContain("is not supported");
      expect(stopped.raw).toContain("page.goto");
    } finally {
      dbHandle.close();
    }
  });
});
