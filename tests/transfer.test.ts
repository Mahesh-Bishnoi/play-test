import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/main/db.js";
import type { DatabaseHandle } from "../src/main/db.js";
import type { IpcHandleFn } from "../src/main/ipc/handle.js";
import { registerTransferHandlers } from "../src/main/ipc/transfer.js";
import { createCase, getCase, listCases } from "../src/main/ipc-cases.js";
import { getCaseProfile, setCaseProfile } from "../src/main/ipc-profiles.js";
import { createProject, getProject, listProjects } from "../src/main/ipc-projects.js";
import { getTestData, listSteps, setTestData, upsertStep } from "../src/main/ipc-steps.js";
import { createSuite, getSuiteCaseIds, listSuites, setSuiteCases } from "../src/main/ipc-suites.js";
import {
  buildCaseExport,
  buildProjectExport,
  buildSuiteExport,
  importCaseBundle,
  importProjectBundle,
  importSuiteBundle,
} from "../src/main/transfer/bundles.js";
import { ExportScopeMismatchError } from "../src/main/transfer/types.js";
import type { TransferIoDeps } from "../src/main/transfer/types.js";
import { exportFileName, parseExportText, type ExportFile } from "../src/shared/export-format.js";

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

/** In-memory file dialogs + fs: tests control paths and file contents. */
function fakeIo(opts?: { saveTo?: string | null; openPath?: string | null }): {
  io: TransferIoDeps;
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  return {
    files,
    io: {
      showSaveDialog: () =>
        Promise.resolve(opts?.saveTo === undefined ? "/tmp/out.playtest.json" : opts.saveTo),
      showOpenDialog: () =>
        Promise.resolve(opts?.openPath === undefined ? "/tmp/in.playtest.json" : opts.openPath),
      readTextFile: (path) => {
        const text = files.get(path);
        return text === undefined
          ? Promise.reject(new Error(`no such file: ${path}`))
          : Promise.resolve(text);
      },
      writeTextFile: (path, text) => {
        files.set(path, text);
        return Promise.resolve();
      },
    },
  };
}

/** Seed: Shop project + Login case (steps, KV, url) + stray case + suite of Login. */
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
    url: "https://shop.test/login",
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
  const stray = createCase(db, { projectId: project.id, name: "Stray" });
  void stray;
  const suite = createSuite(db, { projectId: project.id, name: "Smoke" });
  setSuiteCases(db, suite.id, [login.id]);
  return { projectId: project.id, suiteId: suite.id, loginId: login.id };
}

/** File-transfer simulation: serialize + re-parse, like a real save/load cycle. */
function viaFile(file: ExportFile): ExportFile {
  return parseExportText(JSON.stringify(file));
}

describe("transfer: project round-trip", () => {
  let handle!: DatabaseHandle;

  afterEach(() => {
    handle?.close();
  });

  it("exports everything and re-imports it as a new project with fresh ids", () => {
    handle = createDatabase(":memory:");
    const seed = seedShop(handle.db);

    const summary = importProjectBundle(
      handle.db,
      viaFile(buildProjectExport(handle.db, seed.projectId)),
    );

    expect(listProjects(handle.db)).toHaveLength(2);
    const imported = getProject(handle.db, summary.projectId);
    expect(imported.id).not.toBe(seed.projectId);
    expect(imported.name).toBe("Shop");
    expect(imported.baseUrl).toBe("https://shop.test");
    expect(summary.caseCount).toBe(2);
    expect(summary.stepCount).toBe(2);

    const names = listCases(handle.db, summary.projectId)
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(["Login", "Stray"]);
    for (const c of listCases(handle.db, summary.projectId)) {
      expect(c.id).not.toBe(seed.loginId);
    }
    const login = listCases(handle.db, summary.projectId).find((c) => c.name === "Login");
    expect(login?.description).toBe("Sign in flow");
    expect(login?.url).toBe("https://shop.test/login");
    expect(listSteps(handle.db, login?.id ?? "").map((s) => s.action)).toEqual(["goto", "fill"]);
    expect(getTestData(handle.db, { caseId: login?.id ?? "" })).toEqual({ user: "ada" });

    const suites = listSuites(handle.db, summary.projectId);
    expect(suites.map((s) => s.name)).toEqual(["Smoke"]);
    const memberNames = getSuiteCaseIds(handle.db, suites[0]?.id ?? "").map(
      (id) => getCase(handle.db, id).name,
    );
    expect(memberNames).toEqual(["Login"]);
  });

  it("rolls back the half-created project when a suite references nothing importable", () => {
    handle = createDatabase(":memory:");
    const seed = seedShop(handle.db);
    const file = viaFile(buildProjectExport(handle.db, seed.projectId));
    // Corrupt membership beyond repair is impossible (names just miss), so
    // force failure with an invalid step action caught by validation at insert.
    file.cases[0] = {
      ...file.cases[0],
      name: "Login",
      steps: [{ order: 0, action: "drag-and-drop" }],
    } as unknown as ExportFile["cases"][number];
    expect(() => importProjectBundle(handle.db, file)).toThrow();
    expect(listProjects(handle.db)).toHaveLength(1);
  });
});

describe("transfer: case profiles", () => {
  let handle!: DatabaseHandle;

  afterEach(() => {
    handle?.close();
  });

  it("round-trips the profile onto a fresh case id (filenames only, no auth contents)", () => {
    handle = createDatabase(":memory:");
    const seed = seedShop(handle.db);
    setCaseProfile(handle.db, seed.loginId, {
      device: "Desktop Chrome",
      viewportW: 1440,
      viewportH: 900,
      colorScheme: "dark",
      locale: "en-GB",
      timezone: "Europe/Rome",
      storageState: "login.json",
      saveStorageState: "saved.json",
      dialogPolicy: "accept",
    });

    const file = viaFile(buildProjectExport(handle.db, seed.projectId));
    const exportedLogin = file.cases.find((c) => c.name === "Login");
    // Filenames only — the auth-state FILE CONTENTS never travel.
    expect(exportedLogin?.profile).toEqual({
      device: "Desktop Chrome",
      viewportW: 1440,
      viewportH: 900,
      colorScheme: "dark",
      locale: "en-GB",
      timezone: "Europe/Rome",
      storageState: "login.json",
      saveStorageState: "saved.json",
      dialogPolicy: "accept",
    });
    // A case with no profile row carries no profile key.
    expect(file.cases.find((c) => c.name === "Stray")?.profile).toBeUndefined();

    const summary = importProjectBundle(handle.db, file);
    const importedLogin = listCases(handle.db, summary.projectId).find((c) => c.name === "Login");
    expect(importedLogin?.id).not.toBe(seed.loginId);
    expect(getCaseProfile(handle.db, importedLogin?.id ?? "")).toMatchObject({
      device: "Desktop Chrome",
      viewportW: 1440,
      viewportH: 900,
      colorScheme: "dark",
      locale: "en-GB",
      timezone: "Europe/Rome",
      storageState: "login.json",
      saveStorageState: "saved.json",
      dialogPolicy: "accept",
    });
    const importedStray = listCases(handle.db, summary.projectId).find((c) => c.name === "Stray");
    expect(getCaseProfile(handle.db, importedStray?.id ?? "")).toBeNull();
  });

  it("keeps a cleared profile cleared across export/import", () => {
    handle = createDatabase(":memory:");
    const seed = seedShop(handle.db);
    setCaseProfile(handle.db, seed.loginId, { locale: "en-GB" });
    setCaseProfile(handle.db, seed.loginId, {}); // cleared → no row
    expect(getCaseProfile(handle.db, seed.loginId)).toBeNull();

    const file = viaFile(buildProjectExport(handle.db, seed.projectId));
    expect(file.cases.find((c) => c.name === "Login")?.profile).toBeUndefined();

    const summary = importProjectBundle(handle.db, file);
    const importedLogin = listCases(handle.db, summary.projectId).find((c) => c.name === "Login");
    expect(getCaseProfile(handle.db, importedLogin?.id ?? "")).toBeNull();
  });

  it("applies the profile through the case-import path with fresh ids", () => {
    handle = createDatabase(":memory:");
    const seed = seedShop(handle.db);
    setCaseProfile(handle.db, seed.loginId, { locale: "fr-FR", storageState: "login.json" });

    const summary = importCaseBundle(
      handle.db,
      viaFile(buildCaseExport(handle.db, seed.loginId)),
      seed.projectId,
    );

    const imported = getCase(handle.db, summary.caseIds[0] ?? "");
    expect(imported.id).not.toBe(seed.loginId);
    expect(getCaseProfile(handle.db, imported.id)).toMatchObject({
      locale: "fr-FR",
      storageState: "login.json",
    });
  });
});

describe("transfer: suite and case bundles", () => {
  let handle!: DatabaseHandle;

  afterEach(() => {
    handle?.close();
  });

  it("imports a suite into another project with fresh ids and target baseUrl intact", () => {
    handle = createDatabase(":memory:");
    const seed = seedShop(handle.db);
    const target = createProject(handle.db, { name: "Target", baseUrl: "https://target.test" });

    const summary = importSuiteBundle(
      handle.db,
      viaFile(buildSuiteExport(handle.db, seed.suiteId)),
      target.id,
    );

    expect(getProject(handle.db, target.id).baseUrl).toBe("https://target.test");
    expect(summary.caseCount).toBe(1);
    const login = listCases(handle.db, target.id).find((c) => c.name === "Login");
    expect(login).toBeDefined();
    expect(login?.id).not.toBe(seed.loginId);
    expect(listSteps(handle.db, login?.id ?? "")).toHaveLength(2);
    expect(getTestData(handle.db, { caseId: login?.id ?? "" })).toEqual({ user: "ada" });
    expect(
      getSuiteCaseIds(handle.db, summary.suiteIds[0] ?? "").map(
        (id) => getCase(handle.db, id).name,
      ),
    ).toEqual(["Login"]);
  });

  it("appends imported cases to chosen suites without dropping existing members", () => {
    handle = createDatabase(":memory:");
    const seed = seedShop(handle.db);
    const existing = createCase(handle.db, { projectId: seed.projectId, name: "Existing" });
    const suite = createSuite(handle.db, { projectId: seed.projectId, name: "Extra" });
    setSuiteCases(handle.db, suite.id, [existing.id]);

    const file = viaFile(buildCaseExport(handle.db, seed.loginId));
    expect(file.scope).toBe("case");
    const summary = importCaseBundle(handle.db, file, seed.projectId, [suite.id]);

    expect(summary.caseCount).toBe(1);
    const memberNames = getSuiteCaseIds(handle.db, suite.id)
      .map((id) => getCase(handle.db, id).name)
      .sort();
    expect(memberNames).toEqual(["Existing", "Login"]);
  });

  it("rejects wrong-scope files at each importer", () => {
    handle = createDatabase(":memory:");
    const seed = seedShop(handle.db);
    const projectFile = viaFile(buildProjectExport(handle.db, seed.projectId));
    const suiteFile = viaFile(buildSuiteExport(handle.db, seed.suiteId));
    const caseFile = viaFile(buildCaseExport(handle.db, seed.loginId));

    expect(() => importSuiteBundle(handle.db, projectFile, seed.projectId)).toThrow(
      ExportScopeMismatchError,
    );
    expect(() => importCaseBundle(handle.db, suiteFile, seed.projectId)).toThrow(
      ExportScopeMismatchError,
    );
    expect(() => importProjectBundle(handle.db, caseFile)).toThrow(ExportScopeMismatchError);
  });
});

describe("transfer: file parsing", () => {
  it("rejects non-JSON, wrong format, wrong version, and oversized text", () => {
    expect(() => parseExportText("nope")).toThrow(/not valid JSON/);
    expect(() => parseExportText(JSON.stringify({ format: "other", version: 1 }))).toThrow(
      /not a PlayTest export/,
    );
    expect(() =>
      parseExportText(JSON.stringify({ format: "playtest-export", version: 999 })),
    ).toThrow(/not a PlayTest export/);
    expect(() => parseExportText("x".repeat(10 * 1024 * 1024 + 1))).toThrow(/too large/);
  });

  it("builds safe default filenames", () => {
    expect(exportFileName("My Shop!", "project")).toBe("my-shop.project.playtest.json");
    expect(exportFileName("  ", "case")).toBe("case.case.playtest.json");
  });
});

describe("registerTransferHandlers", () => {
  let handle!: DatabaseHandle;

  afterEach(() => {
    handle?.close();
  });

  it("exports through the save dialog and re-imports through the open dialog", async () => {
    handle = createDatabase(":memory:");
    const seed = seedShop(handle.db);
    const { io, files } = fakeIo();
    const ipc = fakeIpc();
    registerTransferHandlers(ipc.handle, handle.db, io);

    const saved = (await ipc.call("transfer:exportProject", { id: seed.projectId })) as {
      saved: boolean;
      path?: string;
    };
    expect(saved.saved).toBe(true);
    expect(saved.path).toBe("/tmp/out.playtest.json");
    expect(files.get("/tmp/out.playtest.json") ?? "").toContain("playtest-export");

    const target = createProject(handle.db, { name: "Target" });
    void target;
    // Re-import the project file as a new project through the open dialog.
    const { io: io3, files: files3 } = fakeIo({ openPath: "/tmp/in.playtest.json" });
    files3.set("/tmp/in.playtest.json", files.get("/tmp/out.playtest.json") as string);
    const ipc3 = fakeIpc();
    registerTransferHandlers(ipc3.handle, handle.db, io3);
    const result = (await ipc3.call("transfer:importProject", {})) as {
      imported: boolean;
      summary?: { projectId: string; caseCount: number };
    };
    expect(result.imported).toBe(true);
    expect(result.summary?.caseCount).toBe(2);
    expect(listProjects(handle.db)).toHaveLength(3);
    void target;
  });

  it("treats cancelled dialogs as no-ops, not errors", async () => {
    handle = createDatabase(":memory:");
    const seed = seedShop(handle.db);
    const cancelled = fakeIo({ saveTo: null, openPath: null });
    const ipc = fakeIpc();
    registerTransferHandlers(ipc.handle, handle.db, cancelled.io);

    await expect(ipc.call("transfer:exportProject", { id: seed.projectId })).resolves.toEqual({
      saved: false,
    });
    await expect(ipc.call("transfer:importProject", {})).resolves.toEqual({ imported: false });
  });
});
