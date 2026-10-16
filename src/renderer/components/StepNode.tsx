import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";

import type { NodeRunStatus } from "./workflow-layout.js";
import { statusStyle } from "./workflow-layout.js";

export type StepNodeDataPayload = {
  order: number;
  action: string;
  subtitle: string;
  status: NodeRunStatus;
};

export type StepNodeType = Node<StepNodeDataPayload, "stepNode">;

/**
 * Workflow card for one test step (WS3, PLAN §6). Border/background follow the
 * PLAN §2 run palette; the parent passes `selected` via ReactFlow.
 */
export default function StepNode({ data, selected }: NodeProps<StepNodeType>): React.JSX.Element {
  const style = statusStyle(data.status);
  return (
    <div
      style={{
        width: 220,
        padding: "8px 10px",
        border: `2px solid ${style.border}`,
        borderLeftWidth: 6,
        borderRadius: 8,
        background: style.background,
        color: style.text,
        outline: selected === true ? "2px solid #2563eb" : "none",
        outlineOffset: 2,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <Handle type="target" position={Position.Top} />
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <strong>#{data.order + 1}</strong>
        <span
          style={{
            fontSize: 12,
            padding: "1px 6px",
            borderRadius: 10,
            border: `1px solid ${style.border}`,
            whiteSpace: "nowrap",
          }}
        >
          {data.action}
        </span>
      </div>
      {data.subtitle !== "" && (
        <div
          style={{
            marginTop: 4,
            fontSize: 12,
            fontFamily: "ui-monospace, monospace",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={data.subtitle}
        >
          {data.subtitle}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
