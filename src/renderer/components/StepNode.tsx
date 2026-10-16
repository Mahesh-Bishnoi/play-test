import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";

import type { NodeRunStatus } from "./workflow-layout.js";

export type StepNodeDataPayload = {
  order: number;
  action: string;
  subtitle: string;
  status: NodeRunStatus;
};

export type StepNodeType = Node<StepNodeDataPayload, "stepNode">;

function statusClass(status: NodeRunStatus): string {
  switch (status) {
    case "pass":
      return "pt-status-pass";
    case "fail":
      return "pt-status-fail";
    case "running":
      return "pt-status-running";
    case "skipped":
      return "pt-status-skipped";
    default:
      return "";
  }
}

/**
 * Workflow card for one test step (WS3, PLAN §6). Status drives the tone step;
 * selection draws the accent outline.
 */
export default function StepNode({ data, selected }: NodeProps<StepNodeType>): React.JSX.Element {
  return (
    <div
      className={`pt-stepnode ${statusClass(data.status)}${selected === true ? " pt-stepnode-selected" : ""}`}
    >
      <Handle type="target" position={Position.Top} />
      <div className="pt-stepnode-top">
        <strong>#{data.order + 1}</strong>
        <span className="pt-badge">{data.action}</span>
      </div>
      {data.subtitle !== "" && (
        <div className="pt-stepnode-sub" title={data.subtitle}>
          {data.subtitle}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
