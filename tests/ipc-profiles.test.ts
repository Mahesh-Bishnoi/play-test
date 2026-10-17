import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";

import { createDatabase } from "../src/main/db.js";
import type { AppDatabase, DatabaseHandle } from "../src/main/db.js";
import { createCase, deleteCase, getCase } from "../src/main/ipc-cases.js";
import {
  authStateDir,
  deleteCaseProfile,
  getCaseProfile,
  MissingAuthStateError,
  resolveAuthStatePath,
  setCaseProfile,
} from "../src/main/ipc-profiles.js";
import { createProject, deleteProject, listProjects } from "../src/main/ipc-projects.js";
import { caseProfiles } from "../src/main/schema.js";

// Case profile service (M14, SPECS §4): CRUD + validation + lifecycle. The
// table is additive (no migration runner), so an existing DB must gain it on
// open without disturbing its rows.

let handles: DatabaseHandle[] = [];
afterEach(() => {
  for (const handle of handles) {
    handle.close();
  }
  handles = [];
});

function open(): { db: AppDatabase; caseId: string } {
  const handle = createDatabase(":memory:");
  handles.push(handle);
  const project = createProject(handle.db, { name: "P" });
  const testCase = createCase(handle.db, { projectId: project.id, name: "C" });
  return { db: handle.db, caseId: testCase.id };
}

describe("case profile service (M14)", () => {
  it("gets null, sets, reads back, and clears via an all-empty profile", () => {
    const { db, caseId } = open();
    expect(getCaseProfile(db, caseId)).toBeNull();

    const saved = setCaseProfile(db, caseId, { device: "iPhone 11", locale: "en-GB" }, 1234);
    expect(saved).toMatchObject({ caseId, device: "iPhone 11", locale: "en-GB", updatedAt: 1234 });
    expect(getCaseProfile(db, caseId)?.device).toBe("iPhone 11");

    // `{}` (no configured field) means "no profile" → row deleted, returns null.
    expect(setCaseProfile(db, caseId, {})).toBeNull();
    expect(getCaseProfile(db, caseId)).toBeNull();
  });

  it("upserts and replaces fields (absent fields clear to null)", () => {
    const { db, caseId } = open();
    setCaseProfile(db, caseId, {
      device: "iPhone 11",
      locale: "en-GB",
      timezone: "Europe/Rome",
      viewportW: 390,
      viewportH: 844,
    });

    // A second write replaces the row wholesale — locale/timezone are cleared.
    const updated = setCaseProfile(db, caseId, { viewportW: 800, viewportH: 600 });
    expect(updated).toMatchObject({ viewportW: 800, viewportH: 600 });
    expect(updated?.device).toBeUndefined();
    expect(updated?.locale).toBeUndefined();
    expect(updated?.timezone).toBeUndefined();
    // Still one row.
    expect(getCaseProfile(db, caseId)?.viewportW).toBe(800);
  });

  it("round-trips the run-only sessionState filename (M17)", () => {
    const { db, caseId } = open();
    expect(setCaseProfile(db, caseId, { sessionState: "session.json" })?.sessionState).toBe(
      "session.json",
    );
    expect(getCaseProfile(db, caseId)?.sessionState).toBe("session.json");
    // A later write without it clears the column to NULL.
    expect(setCaseProfile(db, caseId, { dialogPolicy: "accept" })?.sessionState).toBeUndefined();
  });

  it("rejects invalid viewports, filenames, devices, locales and policies", () => {
    const { db, caseId } = open();
    expect(() => setCaseProfile(db, caseId, { viewportW: 5, viewportH: 600 })).toThrow();
    expect(() => setCaseProfile(db, caseId, { viewportW: 800, viewportH: 9000 })).toThrow();
    // Auth state is a bare filename — no traversal, no separators.
    expect(() => setCaseProfile(db, caseId, { storageState: "../secret.json" })).toThrow();
    expect(() => setCaseProfile(db, caseId, { storageState: "sub/dir.json" })).toThrow();
    expect(() => setCaseProfile(db, caseId, { saveStorageState: "" })).toThrow();
    expect(() => setCaseProfile(db, caseId, { sessionState: "../secret.json" })).toThrow();
    expect(() => setCaseProfile(db, caseId, { sessionState: "sub/dir.json" })).toThrow();
    expect(() => setCaseProfile(db, caseId, { device: "--output /evil" })).toThrow();
    expect(() => setCaseProfile(db, caseId, { locale: "not a locale!!" })).toThrow();
    expect(() => setCaseProfile(db, caseId, { colorScheme: "sepia" })).toThrow();
    expect(() => setCaseProfile(db, caseId, { dialogPolicy: "always" })).toThrow();
    // Nothing was written by the rejected attempts.
    expect(getCaseProfile(db, caseId)).toBeNull();
  });

  it("resolves auth state under the project auth dir and rejects traversal", () => {
    const root = "/root/data";
    expect(authStateDir(root, "proj")).toBe(join(root, "proj", "auth"));
    expect(resolveAuthStatePath(root, "proj", "login.json")).toBe(
      join(root, "proj", "auth", "login.json"),
    );
    expect(() => resolveAuthStatePath(root, "proj", "../evil.json")).toThrow(
      /invalid auth state filename/,
    );
  });

  it("deleteCase removes the case's profile row", () => {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    const project = createProject(handle.db, { name: "P" });
    const testCase = createCase(handle.db, { projectId: project.id, name: "C" });
    setCaseProfile(handle.db, testCase.id, { device: "iPhone 11" });
    expect(getCaseProfile(handle.db, testCase.id)).not.toBeNull();

    deleteCase(handle.db, testCase.id);
    expect(getCaseProfile(handle.db, testCase.id)).toBeNull();
    expect(() => getCase(handle.db, testCase.id)).toThrow();
  });

  it("deleteCaseProfile is a no-op when no row exists", () => {
    const { db, caseId } = open();
    expect(() => deleteCaseProfile(db, caseId)).not.toThrow();
    expect(getCaseProfile(db, caseId)).toBeNull();
  });

  it("deleteProject removes its cases' profile rows (no orphans)", () => {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    const project = createProject(handle.db, { name: "P" });
    const a = createCase(handle.db, { projectId: project.id, name: "A" });
    const b = createCase(handle.db, { projectId: project.id, name: "B" });
    setCaseProfile(handle.db, a.id, { device: "iPhone 11" });
    setCaseProfile(handle.db, b.id, { locale: "en-GB" });
    expect(handle.db.select().from(caseProfiles).all()).toHaveLength(2);

    deleteProject(handle.db, project.id);
    expect(getCaseProfile(handle.db, a.id)).toBeNull();
    expect(getCaseProfile(handle.db, b.id)).toBeNull();
    // No orphaned rows left behind in the table.
    expect(handle.db.select().from(caseProfiles).all()).toHaveLength(0);
  });

  it("throws MissingAuthStateError with actionable text", () => {
    const error = new MissingAuthStateError("login.json");
    expect(error.message).toContain("auth state missing: login.json");
    expect(error.message).toContain("clear the profile field");
  });

  it("creates case_profiles on an existing DB without touching its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "playtest-profile-db-"));
    const file = join(dir, "legacy.db");

    // A DB created before this feature: the old schema, one project row.
    const raw = new Database(file);
    raw.exec(
      `CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT, created_at INTEGER NOT NULL)`,
    );
    raw
      .prepare(`INSERT INTO projects (id, name, base_url, created_at) VALUES (?, ?, ?, ?)`)
      .run("legacy", "Legacy", "https://legacy.test", 1);
    raw.close();

    const handle = createDatabase(file);
    handles.push(handle);
    try {
      // Old rows survive the additive bootstrap.
      expect(listProjects(handle.db)).toEqual([
        { id: "legacy", name: "Legacy", baseUrl: "https://legacy.test", createdAt: 1 },
      ]);
      // The new table exists and is usable without any migration step.
      const saved = setCaseProfile(handle.db, "case-1", { viewportW: 800, viewportH: 600 });
      expect(saved?.viewportW).toBe(800);
      expect(getCaseProfile(handle.db, "case-1")?.viewportH).toBe(600);
    } finally {
      handle.close();
      handles = handles.filter((h) => h !== handle);
    }
  });
});
