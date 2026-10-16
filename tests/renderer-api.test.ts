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
