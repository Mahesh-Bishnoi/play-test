import type { StepRow } from "../../shared/schema.js";
import type { StepStatus } from "../../shared/step-types.js";

/**
 * Pure workflow-graph helpers (WS3, PLAN §6). No React, no xyflow imports —
 * unit-tested in Node. `StepGraph.tsx` maps these data into ReactFlow nodes.
 */

/** Null = no run recorded yet (WS5 fills `statusByStepId` from step_runs). */
export type NodeRunStatus = StepStatus | null;

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
