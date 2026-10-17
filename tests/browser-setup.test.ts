import { describe, expect, it } from "vitest";

import { BrowserSetupError, getBrowserStatus, installChromium } from "../src/main/browser-setup.js";
import type { BrowserSetupDeps } from "../src/main/browser-setup.js";
import type { IpcHandleFn } from "../src/main/ipc/handle.js";
import { registerSystemHandlers } from "../src/main/ipc/system.js";

function fakeDeps(overrides: Partial<BrowserSetupDeps> = {}): BrowserSetupDeps {
  return {
    executablePath: () => "/browsers/chromium-1200/chrome-linux/chrome",
    pathExists: () => true,
    runInstall: () => Promise.resolve({ code: 0, stderr: "" }),
    ...overrides,
  };
}

function fakeIpc(): {
  handle: IpcHandleFn;
  call: (channel: string, payload: unknown) => unknown;
} {
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

describe("browser presence check (PLAN §11)", () => {
  it("reports installed when the executable exists", () => {
    const status = getBrowserStatus(fakeDeps());
    expect(status.installed).toBe(true);
    expect(status.executablePath).toBe("/browsers/chromium-1200/chrome-linux/chrome");
  });

  it("reports missing when the executable is absent", () => {
    const status = getBrowserStatus(fakeDeps({ pathExists: () => false }));
    expect(status).toEqual({
      installed: false,
      executablePath: "/browsers/chromium-1200/chrome-linux/chrome",
    });
  });

  it("reports missing (not throw) when playwright cannot resolve a path", () => {
    const status = getBrowserStatus(
      fakeDeps({
        executablePath: () => {
          throw new Error("unresolvable");
        },
      }),
    );
    expect(status).toEqual({ installed: false, executablePath: "" });
  });
});

describe("browser install (PLAN §11)", () => {
  it("returns installed status after a clean install", async () => {
    let calls = 0;
    const status = await installChromium(
      fakeDeps({
        pathExists: () => true,
        runInstall: () => {
          calls += 1;
          return Promise.resolve({ code: 0, stderr: "" });
        },
      }),
    );
    expect(calls).toBe(1);
    expect(status.installed).toBe(true);
  });

  it("fails loud with the installer stderr tail on a nonzero exit", async () => {
    const deps = fakeDeps({ runInstall: () => Promise.resolve({ code: 1, stderr: "E: boom" }) });
    await expect(installChromium(deps)).rejects.toThrow(BrowserSetupError);
    await expect(installChromium(deps)).rejects.toThrow(/E: boom/);
  });

  it("fails loud when the installer process cannot spawn", async () => {
    await expect(
      installChromium(
        fakeDeps({
          runInstall: () => Promise.reject(new Error("spawn ENOENT")),
        }),
      ),
    ).rejects.toThrow(BrowserSetupError);
  });

  it("fails loud when the binary is still absent after a clean install", async () => {
    await expect(installChromium(fakeDeps({ pathExists: () => false }))).rejects.toThrow(
      BrowserSetupError,
    );
  });
});

describe("system IPC handlers", () => {
  it("serves browserStatus and installBrowser over the fake IPC", async () => {
    const ipc = fakeIpc();
    registerSystemHandlers(ipc.handle, fakeDeps());
    expect(await ipc.call("system:browserStatus", {})).toEqual({
      installed: true,
      executablePath: "/browsers/chromium-1200/chrome-linux/chrome",
    });
    expect(await ipc.call("system:installBrowser", {})).toEqual({
      installed: true,
      executablePath: "/browsers/chromium-1200/chrome-linux/chrome",
    });
  });

  it("rejects malformed payloads at the boundary", () => {
    const ipc = fakeIpc();
    registerSystemHandlers(ipc.handle, fakeDeps());
    expect(() => ipc.call("system:browserStatus", { extra: 1 })).not.toThrow();
    expect(() => ipc.call("system:browserStatus", "nope")).toThrow();
  });
});
