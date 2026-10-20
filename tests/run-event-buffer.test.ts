import { describe, expect, it } from "vitest";

import { RunEventBuffer } from "../src/renderer/pages/case-detail/run-event-buffer.js";

const ids = { caseRunId: "cr-1", suiteRunId: "sr-1" };

describe("RunEventBuffer (review F7)", () => {
  it("holds events emitted before the run ids arrive and replays them in order", () => {
    const buffer = new RunEventBuffer();
    buffer.push({
      kind: "step",
      event: { caseRunId: "cr-1", order: 0, status: "fail" },
    });
    buffer.push({ kind: "log", event: { level: "error", msg: "missing test-data key: user" } });
    buffer.push({
      kind: "finished",
      event: { suiteRunId: "sr-1", summary: { total: 1, passed: 0, failed: 1, skipped: 0 } },
    });

    const drained = buffer.drain(ids);
    expect(drained.map((e) => e.kind)).toEqual(["step", "log", "finished"]);
    // The buffer is empty after a drain.
    expect(buffer.drain(ids)).toEqual([]);
  });

  it("drops events from an unrelated run and keeps logs", () => {
    const buffer = new RunEventBuffer();
    buffer.push({ kind: "step", event: { caseRunId: "other", order: 0, status: "pass" } });
    buffer.push({
      kind: "finished",
      event: { suiteRunId: "other", summary: { total: 0, passed: 0, failed: 0, skipped: 0 } },
    });
    buffer.push({ kind: "log", event: { level: "info", msg: "hello" } });
    expect(buffer.drain(ids)).toEqual([{ kind: "log", event: { level: "info", msg: "hello" } }]);
  });

  it("is bounded and clears explicitly", () => {
    const buffer = new RunEventBuffer(2);
    for (let order = 0; order < 4; order++) {
      buffer.push({ kind: "step", event: { caseRunId: "cr-1", order, status: "running" } });
    }
    expect(buffer.drain(ids).map((e) => (e.kind === "step" ? e.event.order : -1))).toEqual([2, 3]);
    buffer.push({ kind: "log", event: { level: "info", msg: "x" } });
    buffer.clear();
    expect(buffer.drain(ids)).toEqual([]);
  });
});
