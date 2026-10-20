import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/main/db.js";
import type { DatabaseHandle } from "../src/main/db.js";
import { deleteCase } from "../src/main/ipc-cases.js";
import { deleteSuite } from "../src/main/ipc-suites.js";
import { createProject } from "../src/main/ipc-projects.js";
import { createSuite } from "../src/main/ipc-suites.js";
import { createCase } from "../src/main/ipc-cases.js";
import { caseRuns, suiteRuns } from "../src/main/schema.js";

describe("deleteCase/deleteSuite artifact cleanup (review counted #5)", () => {
  let handle!: DatabaseHandle;
  afterEach(() => {
    handle?.close();
  });

  it("removes the case and suite run folders on a user delete", () => {
    handle = createDatabase(":memory:");
    const root = mkdtempSync(join(tmpdir(), "playtest-artifacts-"));
    const project = createProject(handle.db, { name: "P" });
    const suite = createSuite(handle.db, { projectId: project.id, name: "S" });
    const testCase = createCase(handle.db, { projectId: project.id, name: "C" });
    handle.db
      .insert(suiteRuns)
      .values({ id: "sr", suiteId: suite.id, mode: "unsupervised", status: "passed", startedAt: 1 })
      .run();
    handle.db
      .insert(caseRuns)
      .values({ id: "cr", suiteRunId: "sr", caseId: testCase.id, status: "passed" })
      .run();
    const caseDir = join(root, project.id, "sr", testCase.id);
    const suiteDir = join(root, project.id, "sr");
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(join(caseDir, "step-00.png"), "png");

    deleteCase(handle.db, testCase.id, { artifactsRoot: root });
    expect(existsSync(caseDir)).toBe(false);
    // The suite run folder stays while the suite exists.
    expect(existsSync(suiteDir)).toBe(true);

    deleteSuite(handle.db, suite.id, { artifactsRoot: root });
    expect(existsSync(suiteDir)).toBe(false);
  });
});
