import { describe, expect, it } from "vitest";

import { createDatabase } from "../src/main/db.js";
import { inTransaction } from "../src/main/db.js";
import { createProject, listProjects } from "../src/main/ipc-projects.js";

describe("inTransaction (review F8)", () => {
  it("rolls back every write in the transaction", () => {
    const handle = createDatabase(":memory:");
    try {
      expect(() =>
        inTransaction(handle.db, (tx) => {
          createProject(tx, { name: "Half-made" });
          createProject(tx, { name: "Also half-made" });
          throw new Error("boom");
        }),
      ).toThrow(/boom/);
      expect(listProjects(handle.db)).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it("nests as a savepoint: inner failure keeps the outer writes", () => {
    const handle = createDatabase(":memory:");
    try {
      inTransaction(handle.db, (tx) => {
        createProject(tx, { name: "Outer" });
        try {
          inTransaction(tx, (inner) => {
            createProject(inner, { name: "Inner" });
            throw new Error("inner boom");
          });
        } catch {
          // Savepoint rolled back; the outer transaction stays usable.
        }
        createProject(tx, { name: "After inner" });
      });
      expect(
        listProjects(handle.db)
          .map((p) => p.name)
          .sort(),
      ).toEqual(["After inner", "Outer"]);
    } finally {
      handle.close();
    }
  });
});
