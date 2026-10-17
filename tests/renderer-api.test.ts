import { afterEach, describe, expect, it } from "vitest";

import { api } from "../src/renderer/api.js";

interface RecordedCall {
  channel: string;
  payload: unknown;
}

type InvokeStub = (channel: string, payload: unknown) => Promise<unknown>;

/** `api.ts` reads `window.playtest` at call time — stub it (node has no DOM). */
function stubPlaytest(impl: InvokeStub): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const stub = (channel: string, payload: unknown): Promise<unknown> => {
    calls.push({ channel, payload });
    return impl(channel, payload);
  };
  (globalThis as unknown as { window: { playtest: { invoke: InvokeStub } } }).window = {
    playtest: { invoke: stub },
  };
  return calls;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("renderer api test-data wrappers (M7, PLAN §10)", () => {
  it("gets KV data through testdata:get", async () => {
    const calls = stubPlaytest((channel) => {
      expect(channel).toBe("testdata:get");
      return Promise.resolve({ user: "ada" });
    });
    await expect(api.getTestData("c1")).resolves.toEqual({ user: "ada" });
    expect(calls).toEqual([{ channel: "testdata:get", payload: { caseId: "c1" } }]);
  });

  it("sends caseId + data through testdata:set and returns the stored record", async () => {
    const calls = stubPlaytest((channel) => {
      expect(channel).toBe("testdata:set");
      return Promise.resolve({ user: "grace" });
    });
    await expect(api.setTestData("c1", { user: "grace" })).resolves.toEqual({ user: "grace" });
    expect(calls).toEqual([
      { channel: "testdata:set", payload: { caseId: "c1", data: { user: "grace" } } },
    ]);
  });

  it("rejects malformed test-data responses", async () => {
    stubPlaytest(() => Promise.resolve({ user: 42 }));
    await expect(api.getTestData("c1")).rejects.toThrow();
    await expect(api.setTestData("c1", { user: "x" })).rejects.toThrow();
  });
});

describe("renderer api runner wrappers", () => {
  it("sends actionDelayMs only for paced supervised runs", async () => {
    const calls = stubPlaytest(() => Promise.resolve({ suiteRunId: "s", caseRunId: "c" }));
    await expect(api.runSingleCase("c1", "supervised", 600)).resolves.toEqual({
      suiteRunId: "s",
      caseRunId: "c",
    });
    await expect(api.runSingleCase("c1", "unsupervised")).resolves.toEqual({
      suiteRunId: "s",
      caseRunId: "c",
    });
    expect(calls).toEqual([
      {
        channel: "runner:runSingle",
        payload: { caseId: "c1", mode: "supervised", actionDelayMs: 600 },
      },
      { channel: "runner:runSingle", payload: { caseId: "c1", mode: "unsupervised" } },
    ]);
  });
});

describe("renderer api browser-setup wrappers (M7, PLAN §11)", () => {
  it("parses browser status for both system channels", async () => {
    const calls = stubPlaytest((channel) => {
      if (channel === "system:browserStatus") {
        return Promise.resolve({ installed: false, executablePath: "" });
      }
      return Promise.resolve({ installed: true, executablePath: "/browsers/chrome" });
    });
    await expect(api.browserStatus()).resolves.toEqual({ installed: false, executablePath: "" });
    await expect(api.installBrowser()).resolves.toEqual({
      installed: true,
      executablePath: "/browsers/chrome",
    });
    expect(calls.map((c) => c.channel)).toEqual(["system:browserStatus", "system:installBrowser"]);
  });

  it("rejects malformed status responses", async () => {
    stubPlaytest(() => Promise.resolve({ installed: "yes" }));
    await expect(api.browserStatus()).rejects.toThrow();
  });
});

describe("renderer api report wrappers (M8, PLAN §18.1)", () => {
  it("opens traces by caseRunId or explicit path", async () => {
    const calls = stubPlaytest(() => Promise.resolve({ opened: true }));
    await expect(api.openTrace({ caseRunId: "cr-0" })).resolves.toEqual({ opened: true });
    await expect(api.openTrace({ tracePath: "/t/trace.zip" })).resolves.toEqual({ opened: true });
    expect(calls).toEqual([
      { channel: "report:openTrace", payload: { caseRunId: "cr-0" } },
      { channel: "report:openTrace", payload: { tracePath: "/t/trace.zip" } },
    ]);
  });

  it("rejects malformed open-trace responses", async () => {
    stubPlaytest(() => Promise.resolve({ opened: false }));
    await expect(api.openTrace({ caseRunId: "cr-0" })).rejects.toThrow();
  });
});

describe("renderer api transfer wrappers", () => {
  it("exports through transfer channels and parses save outcomes", async () => {
    const calls = stubPlaytest((channel) => {
      if (channel === "transfer:exportProject") {
        return Promise.resolve({ saved: true, path: "/tmp/shop.project.playtest.json" });
      }
      return Promise.resolve({ saved: false });
    });
    await expect(api.exportProject("p1")).resolves.toEqual({
      saved: true,
      path: "/tmp/shop.project.playtest.json",
    });
    await expect(api.exportSuite("s1")).resolves.toEqual({ saved: false });
    await expect(api.exportCase("c1")).resolves.toEqual({ saved: false });
    expect(calls.map((c) => c.channel)).toEqual([
      "transfer:exportProject",
      "transfer:exportSuite",
      "transfer:exportCase",
    ]);
  });

  it("imports through transfer channels and parses summaries", async () => {
    const calls = stubPlaytest((channel, payload) => {
      if (channel === "transfer:importCase") {
        expect(payload).toEqual({ projectId: "p1", suiteIds: ["s1"] });
      }
      return Promise.resolve({
        imported: true,
        summary: { projectId: "p1", suiteIds: ["s1"], caseIds: ["c2"], caseCount: 1, stepCount: 2 },
      });
    });
    const outcome = await api.importCases("p1", ["s1"]);
    expect(outcome.imported).toBe(true);
    expect(outcome.summary?.caseCount).toBe(1);
    await expect(api.importProject()).resolves.toMatchObject({ imported: true });
    await expect(api.importSuite("p1")).resolves.toMatchObject({ imported: true });
    expect(calls.map((c) => c.channel)).toEqual([
      "transfer:importCase",
      "transfer:importProject",
      "transfer:importSuite",
    ]);
  });
});
