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

  it("passes the suite id through for re-run-last-failed (M12)", async () => {
    const calls = stubPlaytest(() => Promise.resolve({ suiteRunId: "s" }));
    await expect(api.rerunLastFailed("suite-1")).resolves.toEqual({ suiteRunId: "s" });
    expect(calls).toEqual([{ channel: "runner:rerunLastFailed", payload: { suiteId: "suite-1" } }]);
  });

  it("polls runner:getProgress and parses the live snapshot (M21)", async () => {
    const snapshot = {
      suiteRunId: "run-1",
      suiteId: "suite-1",
      suiteName: "Tax flows",
      mode: "unsupervised",
      status: "running",
      startedAt: 1000,
      endedAt: null,
      cases: [
        {
          caseRunId: "cr-0",
          caseId: "c-0",
          caseName: "Login",
          status: "pending",
          durationMs: null,
        },
      ],
      summary: {
        total: 1,
        completed: 0,
        pending: 1,
        running: 0,
        passed: 0,
        failed: 0,
        cancelled: 0,
        skipped: 0,
      },
    };
    const calls = stubPlaytest(() => Promise.resolve(snapshot));
    await expect(api.getRunProgress("run-1")).resolves.toEqual(snapshot);
    expect(calls).toEqual([{ channel: "runner:getProgress", payload: { suiteRunId: "run-1" } }]);
  });

  it("rejects malformed progress responses", async () => {
    stubPlaytest(() => Promise.resolve({ suiteRunId: "run-1", status: "running" }));
    await expect(api.getRunProgress("run-1")).rejects.toThrow();
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

  it("exports PDFs through report:exportPdf and parses the save outcome", async () => {
    const calls = stubPlaytest(() => Promise.resolve({ saved: true, path: "/tmp/report.pdf" }));
    await expect(api.exportReportPdf("run-1")).resolves.toEqual({
      saved: true,
      path: "/tmp/report.pdf",
    });
    expect(calls).toEqual([{ channel: "report:exportPdf", payload: { suiteRunId: "run-1" } }]);
  });

  it("accepts a cancelled PDF export and rejects malformed outcomes", async () => {
    stubPlaytest(() => Promise.resolve({ saved: false }));
    await expect(api.exportReportPdf("run-1")).resolves.toEqual({ saved: false });

    stubPlaytest(() => Promise.resolve("/tmp/legacy-path.pdf"));
    await expect(api.exportReportPdf("run-1")).rejects.toThrow();
  });
});

describe("renderer api case-profile wrappers (M14, PLAN §M14 item 7)", () => {
  it("loads the case profile through profile:get and unwraps the envelope", async () => {
    const calls = stubPlaytest((channel) => {
      expect(channel).toBe("profile:get");
      return Promise.resolve({
        profile: {
          caseId: "c1",
          device: "iPhone 11",
          viewportW: 390,
          viewportH: 844,
          colorScheme: "dark",
          locale: "en-GB",
          timezone: "Europe/Rome",
          storageState: "login.json",
          dialogPolicy: "accept",
          updatedAt: 1_700_000_000_000,
        },
      });
    });
    await expect(api.profileGet("c1")).resolves.toMatchObject({
      caseId: "c1",
      viewportW: 390,
      viewportH: 844,
      storageState: "login.json",
      dialogPolicy: "accept",
    });
    expect(calls).toEqual([{ channel: "profile:get", payload: { caseId: "c1" } }]);
  });

  it("returns null when the case has no profile row", async () => {
    const calls = stubPlaytest(() => Promise.resolve({ profile: null }));
    await expect(api.profileGet("c1")).resolves.toBeNull();
    expect(calls).toEqual([{ channel: "profile:get", payload: { caseId: "c1" } }]);
  });

  it("writes the profile through profile:set and parses the stored row", async () => {
    const calls = stubPlaytest((channel, payload) => {
      expect(channel).toBe("profile:set");
      expect(payload).toEqual({ caseId: "c1", profile: { viewportW: 1280, viewportH: 720 } });
      return Promise.resolve({
        caseId: "c1",
        viewportW: 1280,
        viewportH: 720,
        updatedAt: 42,
      });
    });
    await expect(api.profileSet("c1", { viewportW: 1280, viewportH: 720 })).resolves.toMatchObject({
      caseId: "c1",
      viewportW: 1280,
      updatedAt: 42,
    });
    expect(calls).toHaveLength(1);
  });

  it("treats an all-default write as cleared (null)", async () => {
    stubPlaytest(() => Promise.resolve(null));
    await expect(api.profileSet("c1", {})).resolves.toBeNull();
  });

  it("rejects malformed profile responses", async () => {
    stubPlaytest(() => Promise.resolve({ profile: { caseId: 42 } }));
    await expect(api.profileGet("c1")).rejects.toThrow();
  });
});

describe("renderer api case wrappers (M14)", () => {
  it("sends the case URL through case:update and parses the stored case", async () => {
    const calls = stubPlaytest((channel, payload) => {
      expect(channel).toBe("case:update");
      expect(payload).toEqual({ id: "c1", url: "https://shop.test/checkout" });
      return Promise.resolve({
        id: "c1",
        projectId: "p1",
        name: "Checkout",
        url: "https://shop.test/checkout",
        createdAt: 1_700_000_000_000,
      });
    });
    const updated = await api.updateCase("c1", { url: "https://shop.test/checkout" });
    expect(updated).toMatchObject({ id: "c1", url: "https://shop.test/checkout" });
    expect(calls).toEqual([
      { channel: "case:update", payload: { id: "c1", url: "https://shop.test/checkout" } },
    ]);
  });

  it("carries a null url to clear the case URL", async () => {
    const calls = stubPlaytest(() =>
      Promise.resolve({ id: "c1", projectId: "p1", name: "Checkout", createdAt: 1 }),
    );
    await expect(api.updateCase("c1", { url: null })).resolves.toMatchObject({ id: "c1" });
    expect(calls).toEqual([{ channel: "case:update", payload: { id: "c1", url: null } }]);
  });

  it("rejects a malformed case response", async () => {
    stubPlaytest(() => Promise.resolve({ id: 42 }));
    await expect(api.updateCase("c1", { url: null })).rejects.toThrow();
  });
});

describe("renderer api recorder wrappers (M9/M14/M15, PLAN §18.2)", () => {
  it("starts the recorder from the case id only (M14)", async () => {
    const calls = stubPlaytest(() => Promise.resolve({ pid: 4242 }));
    await expect(api.startRecorder("c1")).resolves.toEqual({ pid: 4242 });
    expect(calls).toEqual([{ channel: "recorder:start", payload: { caseId: "c1" } }]);
  });

  it("rejects a malformed recorder response", async () => {
    stubPlaytest(() => Promise.resolve({ pid: "nope" }));
    await expect(api.startRecorder("c1")).rejects.toThrow();
  });

  it("stops the recorder and parses steps + unsupported + raw (M15)", async () => {
    const calls = stubPlaytest((channel) => {
      expect(channel).toBe("recorder:stop");
      return Promise.resolve({
        steps: [{ order: 0, action: "goto", value: "https://shop.test" }],
        unsupported: [
          {
            line: "page.request.get('https://api.test')",
            reason: "page.request.get(...) is not supported — add a manual step",
          },
        ],
        raw: "await page.goto('https://shop.test');",
      });
    });
    const result = await api.stopRecorder();
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.action).toBe("goto");
    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0]?.line).toContain("page.request.get");
    expect(result.raw).toContain("page.goto");
    expect(calls).toEqual([{ channel: "recorder:stop", payload: {} }]);
  });

  it("rejects a malformed unsupported entry", async () => {
    stubPlaytest(() =>
      Promise.resolve({ steps: [], unsupported: [{ line: 42, reason: "x" }], raw: "" }),
    );
    await expect(api.stopRecorder()).rejects.toThrow();
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
