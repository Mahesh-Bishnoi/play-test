import { useMemo } from "react";
import { ReactFlow } from "@xyflow/react";
import type { Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { StepRow } from "../../shared/schema.js";
import type { StepStatus } from "../../shared/step-types.js";
import StepNode from "./StepNode.js";
import type { StepNodeType } from "./StepNode.js";
import { nodePosition, toWorkflowData, toWorkflowEdges } from "./workflow-layout.js";

const nodeTypes = { stepNode: StepNode };

interface Props {
  steps: StepRow[];
  /** Latest step_runs status per step id (WS5 fills this; empty until then). */
  statusByStepId?: Record<string, StepStatus>;
  selectedId: string | null;
  onSelect: (stepId: string) => void;
}

/**
 * Linear workflow chain (WS3, PLAN §6). Nodes are draggable for inspection;
 * logical order changes go through the step table (up/down + drag reorder),
 * which calls step:move / step:reorder so `order` stays dense.
 */
export default function StepGraph({
  steps,
  statusByStepId,
  selectedId,
  onSelect,
}: Props): React.JSX.Element {
  const nodes = useMemo<StepNodeType[]>(
    () =>
      toWorkflowData(steps, statusByStepId).map((datum, index) => ({
        id: datum.id,
        type: "stepNode",
        position: nodePosition(index),
        selected: datum.id === selectedId,
        data: {
          order: datum.order,
          action: datum.action,
          subtitle: datum.subtitle,
          status: datum.status,
        },
      })),
    [steps, statusByStepId, selectedId],
  );

  const edges = useMemo<Edge[]>(
    () =>
      toWorkflowEdges(steps).map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
      })),
    [steps],
  );

  if (steps.length === 0) {
    return <p>No steps yet — add one below to start the workflow.</p>;
  }

  return (
    <div style={{ height: 420, border: "1px solid #ddd", borderRadius: 8 }} aria-label="Step graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_event, node) => {
          onSelect(node.id);
        }}
        fitView
      />
    </div>
  );
}
