import { describe, expect, it } from "vitest";

import type { StepRow } from "../src/shared/schema.js";
import {
  nodePosition,
  statusStyle,
  toWorkflowData,
  toWorkflowEdges,
} from "../src/renderer/components/workflow-layout.js";

function step(id: string, order: number, extra?: Partial<StepRow>): StepRow {
  return {
    id,
    caseId: "case-1",
    order,
    action: "click",
    selector: "#submit",
    editedAt: 1,
    ...extra,
  };
}

describe("workflow-layout (WS3)", () => {
  it("maps an empty case to no nodes and no edges", () => {
    expect(toWorkflowData([])).toEqual([]);
    expect(toWorkflowEdges([])).toEqual([]);
  });

  it("builds titles from order+action and prefers selector for subtitles", () => {
    const [first] = toWorkflowData([step("a", 0)]);
    expect(first?.title).toBe("s0 · click");
    expect(first?.subtitle).toBe("#submit");
    expect(first?.status).toBeNull();
  });

  it("falls back to value when selector is absent, truncating long text", () => {
    const long = `v=${"x".repeat(100)}`;
    const [node] = toWorkflowData([step("a", 3, { selector: undefined, value: long })]);
    expect(node?.title).toBe("s3 · click");
    expect(node?.subtitle?.length).toBeLessThanOrEqual(60);
    expect(node?.subtitle?.endsWith("…")).toBe(true);
  });

  it("resolves per-step run status, defaulting to null (never run)", () => {
    const nodes = toWorkflowData([step("a", 0), step("b", 1)], { b: "fail" });
    expect(nodes[0]?.status).toBeNull();
    expect(nodes[1]?.status).toBe("fail");
  });

  it("links consecutive steps and skips nothing in a linear chain", () => {
    const steps = [step("a", 0), step("b", 1), step("c", 2)];
    expect(toWorkflowEdges(steps)).toEqual([
      { id: "e0-1", source: "a", target: "b" },
      { id: "e1-2", source: "b", target: "c" },
    ]);
    expect(toWorkflowEdges([step("a", 0)])).toEqual([]);
  });

  it("uses the PLAN §2 palette: green pass, red fail, blue running, grey skipped", () => {
    expect(statusStyle("pass").border).toBe("#16a34a");
    expect(statusStyle("fail").border).toBe("#dc2626");
    expect(statusStyle("running").border).toBe("#2563eb");
    expect(statusStyle("skipped").border).toBe("#9ca3af");
    expect(statusStyle(null).background).toBe("#ffffff");
  });

  it("lays nodes out in a vertical column with even spacing", () => {
    expect(nodePosition(0)).toEqual({ x: 0, y: 0 });
    expect(nodePosition(2)).toEqual({ x: 0, y: 240 });
  });
});
