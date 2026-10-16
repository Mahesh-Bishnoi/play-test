import type { StepRow } from "../../shared/schema.js";
import type { StepStatus } from "../../shared/step-types.js";

/**
 * Pure workflow-graph helpers (WS3, PLAN §6). No React, no xyflow imports —
 * unit-tested in Node. `StepGraph.tsx` maps these data into ReactFlow nodes.
 */

/** Null = no run recorded yet (WS5 fills `statusByStepId` from step_runs). */
export type NodeRunStatus = StepStatus | null;

export interface StatusStyle {
  border: string;
  background: string;
  text: string;
}

/**
 * Node colors (PLAN §2): green=pass, red=fail, grey=skipped, blue=running.
 * `null` (never run) renders as a neutral card.
 */
export function statusStyle(status: NodeRunStatus): StatusStyle {
  switch (status) {
    case "pass":
      return { border: "#16a34a", background: "#f0fdf4", text: "#166534" };
    case "fail":
      return { border: "#dc2626", background: "#fef2f2", text: "#991b1b" };
    case "running":
      return { border: "#2563eb", background: "#eff6ff", text: "#1d4ed8" };
    case "skipped":
      return { border: "#9ca3af", background: "#f9fafb", text: "#4b5563" };
    default:
      return { border: "#d1d5db", background: "#ffffff", text: "#111827" };
  }
}

export interface WorkflowNodeDatum {
  id: string;
  order: number;
  action: string;
  /** Compact label, e.g. `s2 · click` (matches the WS5 `test.step` naming). */
  title: string;
  /** Selector preferred, else value, truncated for the card. */
  subtitle: string;
  status: NodeRunStatus;
}

export interface WorkflowEdgeDatum {
  id: string;
  source: string;
  target: string;
}

const SUBTITLE_MAX = 60;

function truncate(raw: string): string {
  return raw.length > SUBTITLE_MAX ? `${raw.slice(0, SUBTITLE_MAX - 1)}…` : raw;
}

/** Linear chain data in array order (callers pass steps sorted by `order`). */
export function toWorkflowData(
  steps: StepRow[],
  statusByStepId?: Record<string, StepStatus>,
): WorkflowNodeDatum[] {
  return steps.map((step) => {
    const status: NodeRunStatus = statusByStepId?.[step.id] ?? null;
    const detail = step.selector ?? step.value ?? "";
    return {
      id: step.id,
      order: step.order,
      action: step.action,
      title: `s${step.order} · ${step.action}`,
      subtitle: truncate(detail),
      status,
    };
  });
}

/** One edge per consecutive pair — the graph is always a linear chain. */
export function toWorkflowEdges(steps: StepRow[]): WorkflowEdgeDatum[] {
  const edges: WorkflowEdgeDatum[] = [];
  for (let i = 1; i < steps.length; i++) {
    const source = steps[i - 1]?.id;
    const target = steps[i]?.id;
    if (source !== undefined && target !== undefined) {
      edges.push({ id: `e${i - 1}-${i}`, source, target });
    }
  }
  return edges;
}

/** Vertical linear layout: fixed column, even spacing per index. */
export function nodePosition(index: number): { x: number; y: number } {
  return { x: 0, y: index * 120 };
}
