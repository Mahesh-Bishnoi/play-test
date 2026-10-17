import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../src/main/db.js";
import type { DatabaseHandle } from "../src/main/db.js";
import type { IpcHandleFn } from "../src/main/ipc-register.js";
import { registerTransferHandlers } from "../src/main/ipc-register.js";
import { createCase, getCase, listCases } from "../src/main/ipc-cases.js";
import { getCaseProfile, setCaseProfile } from "../src/main/ipc-profiles.js";
import { createProject, getProject } from "../src/main/ipc-projects.js";
import { getTestData, listSteps, setTestData, upsertStep } from "../src/main/ipc-steps.js";
import { createSuite, getSuiteCaseIds, listSuites, setSuiteCases } from "../src/main/ipc-suites.js";
import type { TransferIoDeps } from "../src/main/transfer.js";
import { parseExportText } from "../src/shared/export-format.js";
import type { ExportFile } from "../src/shared/export-format.js";

/**
 * End-to-end validation of file import/export through REAL bytes on disk.
 * Complements tests/transfer.test.ts (which uses an in-memory fake fs):
 * here the TransferIoDeps talk to node:fs in a temp dir, the IPC handlers
 * run the full save/open flow, and the "other machine" is a separate
 * database handle. Only the Electron dialogs are canned (no headless way
 * to click them) — everything else is production code and real I/O.
 *
 * Opt-in like the other e2e suites (fast and hermetic, but file-shaped):
 *
 *   PLAYTEST_E2E=1 npx vitest run tests/e2e-transfer.test.ts
 *
 * Covers: project export → disk → import as a new project with fresh ids
 * (definitions + steps + KV + unmembered cases + membership intact);
 * suite/case exports imported into an existing project (target baseUrl
 * wins); re-exports differ only in exportedAt (git-friendly, no spurious
 * diffs); truncated and oversized files on disk are rejected cleanly.
 */
const describeE2E = describe.skipIf(!process.env.PLAYTEST_E2E);

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

/** Production-shaped I/O: real fs, canned dialog answers (headless). */
function diskIo(saveTo: string, openPath: string): TransferIoDeps {
  return {
    showSaveDialog: () => Promise.resolve(saveTo),
    showOpenDialog: () => Promise.resolve(openPath),
    readTextFile: (path) => readFile(path, "utf8"),
    writeTextFile: (path, text) => writeFile(path, text, "utf8"),
  };
}

/** Seed: Shop project + Login case (steps, KV, url) + stray case + suite. */
function seedShop(db: DatabaseHandle["db"]): {
  projectId: string;
  suiteId: string;
  loginId: string;
} {
  const project = createProject(db, { name: "Shop", baseUrl: "https://shop.test" });
  const login = createCase(db, {
    projectId: project.id,
    name: "Login",
    description: "Sign in flow",
    url: "/login",
  });
  upsertStep(db, {
    caseId: login.id,
    step: { order: 0, action: "goto", value: "{{baseUrl}}/login" },
  });
  upsertStep(db, {
    caseId: login.id,
    step: { order: 1, action: "fill", selector: "#user", value: "{{user}}" },
  });
  setTestData(db, { caseId: login.id, data: { user: "ada" } });
  createCase(db, { projectId: project.id, name: "Stray" });
  const suite = createSuite(db, { projectId: project.id, name: "Smoke" });
  setSuiteCases(db, suite.id, [login.id]);
  return { projectId: project.id, suiteId: suite.id, loginId: login.id };
}

describeE2E("e2e transfer: real files on disk", () => {
  let scratch: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "e2e-transfer-"));
  });

  it("project export -> disk bytes -> import on a fresh db", async () => {
    const machineA = createDatabase(":memory:");
    const machineB = createDatabase(":memory:");
    try {
      const seed = seedShop(machineA.db);
      const filePath = join(scratch, "shop.project.playtest.json");

      const ipcA = fakeIpc();
      registerTransferHandlers(ipcA.handle, machineA.db, diskIo(filePath, filePath));
      const saved = (await ipcA.call("transfer:exportProject", { id: seed.projectId })) as {
        saved: boolean;
        path?: string;
      };
      expect(saved).toEqual({ saved: true, path: filePath });

      // Real bytes: complete UTF-8 JSON document, format marker present.
      const bytes = await readFile(filePath, "utf8");
      expect(bytes).toContain("playtest-export");
      expect(bytes.trimEnd().endsWith("}")).toBe(true);

      // The other machine reads the same bytes off disk and imports them.
      const ipcB = fakeIpc();
      registerTransferHandlers(ipcB.handle, machineB.db, diskIo(filePath, filePath));
      const result = (await ipcB.call("transfer:importProject", {})) as {
        imported: boolean;
        summary?: { projectId: string; caseCount: number; stepCount: number };
      };
      expect(result.imported).toBe(true);
      expect(result.summary).toMatchObject({ caseCount: 2, stepCount: 2 });

      const projectId = result.summary?.projectId ?? "";
      const imported = getProject(machineB.db, projectId);
      expect(imported.id).not.toBe(seed.projectId);
      expect(imported.name).toBe("Shop");
      expect(imported.baseUrl).toBe("https://shop.test");

      const names = listCases(machineB.db, projectId)
        .map((c) => c.name)
        .sort();
      expect(names).toEqual(["Login", "Stray"]);
      for (const c of listCases(machineB.db, projectId)) {
        expect(c.id).not.toBe(seed.loginId);
      }
      const login = listCases(machineB.db, projectId).find((c) => c.name === "Login");
      expect(login?.description).toBe("Sign in flow");
      expect(login?.url).toBe("/login");
      expect(listSteps(machineB.db, login?.id ?? "").map((s) => s.action)).toEqual([
        "goto",
        "fill",
      ]);
      expect(getTestData(machineB.db, { caseId: login?.id ?? "" })).toEqual({ user: "ada" });

      const suites = listSuites(machineB.db, projectId);
      expect(suites.map((s) => s.name)).toEqual(["Smoke"]);
      const memberNames = getSuiteCaseIds(machineB.db, suites[0]?.id ?? "").map(
        (id) => getCase(machineB.db, id).name,
      );
      expect(memberNames).toEqual(["Login"]);

      // Evidence listing (printed for the human log)
      console.log(JSON.stringify({ filePath, bytes: bytes.length }, null, 2));
    } finally {
      machineA.close();
      machineB.close();
    }
  });

  it("carries the case profile (filenames only) across real disk bytes", async () => {
    const machineA = createDatabase(":memory:");
    const machineB = createDatabase(":memory:");
    try {
      const seed = seedShop(machineA.db);
      setCaseProfile(machineA.db, seed.loginId, {
        device: "Desktop Chrome",
        viewportW: 1440,
        viewportH: 900,
        colorScheme: "dark",
        locale: "en-GB",
        storageState: "login.json",
        saveStorageState: "saved.json",
        dialogPolicy: "accept",
      });
      const filePath = join(scratch, "profile.project.playtest.json");

      const ipcA = fakeIpc();
      registerTransferHandlers(ipcA.handle, machineA.db, diskIo(filePath, filePath));
      const saved = (await ipcA.call("transfer:exportProject", { id: seed.projectId })) as {
        saved: boolean;
      };
      expect(saved.saved).toBe(true);

      // The bundle names the auth state file but never embeds its contents.
      const bytes = await readFile(filePath, "utf8");
      expect(bytes).toContain('"profile"');
      expect(bytes).toContain("login.json");

      const ipcB = fakeIpc();
      registerTransferHandlers(ipcB.handle, machineB.db, diskIo(filePath, filePath));
      const result = (await ipcB.call("transfer:importProject", {})) as {
        imported: boolean;
        summary?: { projectId: string };
      };
      expect(result.imported).toBe(true);
      const projectId = result.summary?.projectId ?? "";
      const login = listCases(machineB.db, projectId).find((c) => c.name === "Login");
      expect(getCaseProfile(machineB.db, login?.id ?? "")).toMatchObject({
        device: "Desktop Chrome",
        viewportW: 1440,
        viewportH: 900,
        colorScheme: "dark",
        locale: "en-GB",
        storageState: "login.json",
        saveStorageState: "saved.json",
        dialogPolicy: "accept",
      });
      const stray = listCases(machineB.db, projectId).find((c) => c.name === "Stray");
      expect(getCaseProfile(machineB.db, stray?.id ?? "")).toBeNull();
    } finally {
      machineA.close();
      machineB.close();
    }
  });

  it("suite/case exports land in an existing project with the target baseUrl winning", async () => {
    const machineA = createDatabase(":memory:");
    const machineB = createDatabase(":memory:");
    try {
      const seed = seedShop(machineA.db);
      const suitePath = join(scratch, "smoke.suite.playtest.json");
      const casePath = join(scratch, "login.case.playtest.json");

      const ipcA = fakeIpc();
      registerTransferHandlers(ipcA.handle, machineA.db, diskIo(suitePath, suitePath));
      await ipcA.call("transfer:exportSuite", { id: seed.suiteId });
      const ipcA2 = fakeIpc();
      registerTransferHandlers(ipcA2.handle, machineA.db, diskIo(casePath, casePath));
      await ipcA2.call("transfer:exportCase", { id: seed.loginId });

      const target = createProject(machineB.db, { name: "Target", baseUrl: "https://target.test" });
      const ipcB = fakeIpc();
      registerTransferHandlers(ipcB.handle, machineB.db, diskIo(suitePath, suitePath));
      const suiteResult = (await ipcB.call("transfer:importSuite", {
        projectId: target.id,
      })) as {
        imported: boolean;
        summary?: { caseCount: number; suiteIds: string[] };
      };
      expect(suiteResult.imported).toBe(true);
      expect(suiteResult.summary?.caseCount).toBe(1);

      const ipcB2 = fakeIpc();
      registerTransferHandlers(ipcB2.handle, machineB.db, diskIo(casePath, casePath));
      const caseResult = (await ipcB2.call("transfer:importCase", {
        projectId: target.id,
        suiteIds: suiteResult.summary?.suiteIds ?? [],
      })) as { imported: boolean; summary?: { caseCount: number } };
      expect(caseResult.imported).toBe(true);

      // Target baseUrl untouched by either import; cases got fresh ids.
      expect(getProject(machineB.db, target.id).baseUrl).toBe("https://target.test");
      const logins = listCases(machineB.db, target.id).filter((c) => c.name === "Login");
      expect(logins).toHaveLength(2);
      for (const c of logins) {
        expect(c.id).not.toBe(seed.loginId);
      }
      const memberNames = getSuiteCaseIds(machineB.db, suiteResult.summary?.suiteIds[0] ?? "")
        .map((id) => getCase(machineB.db, id).name)
        .sort();
      expect(memberNames).toEqual(["Login", "Login"]);
    } finally {
      machineA.close();
      machineB.close();
    }
  });

  it("re-exports differ only in exportedAt; truncated and oversized files are rejected", async () => {
    const machineA = createDatabase(":memory:");
    try {
      const seed = seedShop(machineA.db);
      const first = join(scratch, "first.project.playtest.json");
      const second = join(scratch, "second.project.playtest.json");
      const ipcA = fakeIpc();
      registerTransferHandlers(ipcA.handle, machineA.db, diskIo(first, first));
      await ipcA.call("transfer:exportProject", { id: seed.projectId });
      const ipcA2 = fakeIpc();
      registerTransferHandlers(ipcA2.handle, machineA.db, diskIo(second, second));
      await ipcA2.call("transfer:exportProject", { id: seed.projectId });

      // Git-friendly: same content, only the timestamp moves.
      const a = { ...parseExportText(await readFile(first, "utf8")), exportedAt: 0 };
      const b = { ...parseExportText(await readFile(second, "utf8")), exportedAt: 0 };
      expect(a satisfies ExportFile).toEqual(b satisfies ExportFile);

      // Truncated bytes off disk: clean rejection, nothing imported.
      const bytes = await readFile(first, "utf8");
      const cut = join(scratch, "cut.project.playtest.json");
      await writeFile(cut, bytes.slice(0, Math.floor(bytes.length / 2)), "utf8");
      const ipcCut = fakeIpc();
      registerTransferHandlers(ipcCut.handle, machineA.db, diskIo(cut, cut));
      await expect(ipcCut.call("transfer:importProject", {})).rejects.toThrow();

      // Oversized file: rejected by the size cap before parsing.
      const big = join(scratch, "big.project.playtest.json");
      await writeFile(big, "x".repeat(10 * 1024 * 1024 + 1), "utf8");
      const ipcBig = fakeIpc();
      registerTransferHandlers(ipcBig.handle, machineA.db, diskIo(big, big));
      await expect(ipcBig.call("transfer:importProject", {})).rejects.toThrow(/too large/);
    } finally {
      machineA.close();
    }
  });
});
