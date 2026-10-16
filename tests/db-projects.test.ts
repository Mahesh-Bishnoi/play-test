import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/main/db.js";
import type { DatabaseHandle } from "../src/main/db.js";
import {
  ProjectNotFoundError,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from "../src/main/ipc-projects.js";

describe("project service (WS1)", () => {
  let handle: DatabaseHandle | undefined;

  afterEach(() => {
    handle?.close();
    handle = undefined;
  });

  it("creates, lists, gets, updates, and deletes projects", () => {
    handle = createDatabase(":memory:");
    const { db } = handle;

    const created = createProject(db, {
      name: "Shop",
      baseUrl: "https://example.com",
    });
    expect(created.name).toBe("Shop");
    expect(created.baseUrl).toBe("https://example.com");

    expect(listProjects(db)).toHaveLength(1);
    expect(getProject(db, created.id).name).toBe("Shop");

    const renamed = updateProject(db, { id: created.id, name: "Shop 2" });
    expect(renamed.name).toBe("Shop 2");
    expect(renamed.baseUrl).toBe("https://example.com");

    deleteProject(db, created.id);
    expect(listProjects(db)).toHaveLength(0);
  });

  it("stores projects without a baseUrl as undefined", () => {
    handle = createDatabase(":memory:");
    const created = createProject(handle.db, { name: "No URL" });
    expect(created.baseUrl).toBeUndefined();
  });

  it("throws ProjectNotFoundError for unknown ids", () => {
    handle = createDatabase(":memory:");
    expect(() => getProject(handle?.db as never, "nope")).toThrow(ProjectNotFoundError);
    expect(() => deleteProject(handle?.db as never, "nope")).toThrow(ProjectNotFoundError);
  });

  it("rejects empty names at the boundary", () => {
    handle = createDatabase(":memory:");
    expect(() => createProject(handle?.db as never, { name: "  " })).toThrow();
  });
});
