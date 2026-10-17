import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/main/db.js";
import type { DatabaseHandle } from "../src/main/db.js";
import type { IpcHandleFn } from "../src/main/ipc/handle.js";
import { registerCrudHandlers } from "../src/main/ipc/crud.js";
import { createCase, deleteCase, getCase, listCases } from "../src/main/ipc-cases.js";
import { getCaseProfile, setCaseProfile } from "../src/main/ipc-profiles.js";
import { createProject } from "../src/main/ipc-projects.js";
import {
  deleteStep,
  getTestData,
  listSteps,
  moveStep,
  reorderSteps,
  setTestData,
  upsertStep,
} from "../src/main/ipc-steps.js";
import {
  SuiteCaseNotFoundError,
  SuiteCaseProjectMismatchError,
  createSuite,
  deleteSuite,
  getSuiteCaseIds,
  listSuites,
  setSuiteCases,
  updateSuite,
} from "../src/main/ipc-suites.js";

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

describe("suite service (WS2)", () => {
  let handle!: DatabaseHandle;

  afterEach(() => {
    handle?.close();
  });

  it("creates, lists, renames, and deletes suites", () => {
    handle = createDatabase(":memory:");
    const project = createProject(handle.db, { name: "P" });
    const suite = createSuite(handle.db, { projectId: project.id, name: "Smoke" });
    expect(listSuites(handle.db, project.id)).toHaveLength(1);
    expect(updateSuite(handle.db, { id: suite.id, name: "Smoke 2" }).name).toBe("Smoke 2");
    deleteSuite(handle.db, suite.id);
    expect(listSuites(handle.db, project.id)).toHaveLength(0);
  });

  it("sets membership, dedupes, and validates project scope", () => {
    handle = createDatabase(":memory:");
    const project = createProject(handle.db, { name: "P" });
    const other = createProject(handle.db, { name: "Other" });
    const suite = createSuite(handle.db, { projectId: project.id, name: "S" });
    const a = createCase(handle.db, { projectId: project.id, name: "A" });
    const b = createCase(handle.db, { projectId: project.id, name: "B" });
    const foreign = createCase(handle.db, { projectId: other.id, name: "F" });

    expect(setSuiteCases(handle.db, suite.id, [a.id, b.id, a.id]).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(getSuiteCaseIds(handle.db, suite.id).sort()).toEqual([a.id, b.id].sort());

    expect(() => setSuiteCases(handle.db, suite.id, ["missing"])).toThrow(SuiteCaseNotFoundError);
    expect(() => setSuiteCases(handle.db, suite.id, [foreign.id])).toThrow(
      SuiteCaseProjectMismatchError,
    );
  });

  it("case delete drops steps, test-data, suite joins, and the profile but keeps the suite", () => {
    handle = createDatabase(":memory:");
    const project = createProject(handle.db, { name: "P" });
    const suite = createSuite(handle.db, { projectId: project.id, name: "S" });
    const testCase = createCase(handle.db, { projectId: project.id, name: "C" });
    upsertStep(handle.db, {
      caseId: testCase.id,
      step: { order: 0, action: "goto", value: "https://x.test" },
    });
    setTestData(handle.db, { caseId: testCase.id, data: { user: "ada" } });
    setCaseProfile(handle.db, testCase.id, { device: "iPhone 11" });
    setSuiteCases(handle.db, suite.id, [testCase.id]);

    deleteCase(handle.db, testCase.id);
    expect(listCases(handle.db, project.id)).toHaveLength(0);
    expect(getSuiteCaseIds(handle.db, suite.id)).toHaveLength(0);
    expect(getCaseProfile(handle.db, testCase.id)).toBeNull();
    expect(() => getCase(handle.db, testCase.id)).toThrow();
  });
});

describe("step service (WS2)", () => {
  let handle!: DatabaseHandle;

  afterEach(() => {
    handle?.close();
  });

  it("keeps orders dense across upsert, move, delete, and reorder", () => {
    handle = createDatabase(":memory:");
    const project = createProject(handle.db, { name: "P" });
    const testCase = createCase(handle.db, { projectId: project.id, name: "C" });

    const s0 = upsertStep(handle.db, {
      caseId: testCase.id,
      step: { order: 0, action: "goto", value: "https://x.test" },
    });
    const s1 = upsertStep(handle.db, {
      caseId: testCase.id,
      step: { order: 1, action: "click", selector: "#a" },
    });
    // Insert in the middle shifts the successor down.
    const sMid = upsertStep(handle.db, {
      caseId: testCase.id,
      step: { order: 1, action: "fill", selector: "#b", value: "hi" },
    });
    expect(listSteps(handle.db, testCase.id).map((s) => s.id)).toEqual([s0.id, sMid.id, s1.id]);
    expect(listSteps(handle.db, testCase.id).map((s) => s.order)).toEqual([0, 1, 2]);

    moveStep(handle.db, { caseId: testCase.id, id: s0.id, toOrder: 2 });
    expect(listSteps(handle.db, testCase.id).map((s) => s.id)).toEqual([sMid.id, s1.id, s0.id]);

    reorderSteps(handle.db, { caseId: testCase.id, orderedIds: [s0.id, sMid.id, s1.id] });
    expect(listSteps(handle.db, testCase.id).map((s) => s.id)).toEqual([s0.id, sMid.id, s1.id]);

    deleteStep(handle.db, { caseId: testCase.id, id: sMid.id });
    expect(listSteps(handle.db, testCase.id).map((s) => s.order)).toEqual([0, 1]);
  });

  it("rejects reorder with a mismatched id set", () => {
    handle = createDatabase(":memory:");
    const project = createProject(handle.db, { name: "P" });
    const testCase = createCase(handle.db, { projectId: project.id, name: "C" });
    const s0 = upsertStep(handle.db, { caseId: testCase.id, step: { order: 0, action: "wait" } });
    expect(() =>
      reorderSteps(handle.db, { caseId: testCase.id, orderedIds: [s0.id, "ghost"] }),
    ).toThrow();
    expect(() => reorderSteps(handle.db, { caseId: testCase.id, orderedIds: [] })).toThrow();
  });

  it("replaces KV test data wholesale", () => {
    handle = createDatabase(":memory:");
    const project = createProject(handle.db, { name: "P" });
    const testCase = createCase(handle.db, { projectId: project.id, name: "C" });
    expect(getTestData(handle.db, { caseId: testCase.id })).toEqual({});
    setTestData(handle.db, { caseId: testCase.id, data: { user: "ada", pass: "s3cret" } });
    expect(getTestData(handle.db, { caseId: testCase.id })).toEqual({
      user: "ada",
      pass: "s3cret",
    });
    setTestData(handle.db, { caseId: testCase.id, data: { user: "grace" } });
    expect(getTestData(handle.db, { caseId: testCase.id })).toEqual({ user: "grace" });
  });
});

describe("crud IPC wiring (WS2)", () => {
  it("round-trips suites, cases, steps, and test-data through the fake IPC surface", () => {
    const dbHandle = createDatabase(":memory:");
    try {
      const ipc = fakeIpc();
      registerCrudHandlers(ipc.handle, dbHandle.db);

      const project = ipc.call("project:create", { name: "P" }) as { id: string };
      const suite = ipc.call("suite:create", { projectId: project.id, name: "S" }) as {
        id: string;
      };
      const testCase = ipc.call("case:create", { projectId: project.id, name: "C" }) as {
        id: string;
      };

      const members = ipc.call("suite:setCases", {
        suiteId: suite.id,
        caseIds: [testCase.id],
      }) as string[];
      expect(members).toEqual([testCase.id]);

      const detail = ipc.call("suite:get", { id: suite.id }) as {
        suite: { id: string };
        caseIds: string[];
      };
      expect(detail.suite.id).toBe(suite.id);
      expect(detail.caseIds).toEqual([testCase.id]);

      const step = ipc.call("step:upsert", {
        caseId: testCase.id,
        step: { order: 0, action: "goto", value: "https://x.test" },
      }) as { id: string; order: number };
      expect(step.order).toBe(0);

      const caseDetail = ipc.call("case:get", { id: testCase.id }) as {
        case: { id: string };
        steps: { id: string }[];
      };
      expect(caseDetail.case.id).toBe(testCase.id);
      expect(caseDetail.steps.map((s) => s.id)).toEqual([step.id]);

      const stored = ipc.call("testdata:set", {
        caseId: testCase.id,
        data: { user: "ada" },
      }) as Record<string, string>;
      expect(stored).toEqual({ user: "ada" });
      expect(ipc.call("testdata:get", { caseId: testCase.id })).toEqual({ user: "ada" });

      expect(() =>
        ipc.call("step:upsert", { caseId: testCase.id, step: { order: 0, action: "nope" } }),
      ).toThrow();
      expect(() => ipc.call("suite:setCases", { suiteId: suite.id, caseIds: ["ghost"] })).toThrow();
    } finally {
      dbHandle.close();
    }
  });
});
