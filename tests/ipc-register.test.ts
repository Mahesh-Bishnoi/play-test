import { describe, expect, it } from "vitest";

import { createDatabase } from "../src/main/db.js";
import type { IpcHandleFn } from "../src/main/ipc-register.js";
import { registerProfileHandlers, registerProjectHandlers } from "../src/main/ipc-register.js";
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
