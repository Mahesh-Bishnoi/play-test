import type { StepRow } from "../../../shared/schema.js";
import type { StepStatus } from "../../../shared/step-types.js";

interface Props {
  steps: StepRow[];
  selectedId: string | null;
  dragId: string | null;
  busy: boolean;
  /** Live run status per step id (empty when no run is active). */
  statusByStepId: Record<string, StepStatus>;
  onSelect: (id: string) => void;
  onDragStart: (id: string) => void;
  onDrop: (id: string) => void;
  onMove: (id: string, toOrder: number) => void;
}

/** The step list table: drag-to-reorder rows, live status badges, ↑/↓ move. */
export default function StepTable({
  steps,
  selectedId,
  dragId,
  busy,
  statusByStepId,
  onSelect,
  onDragStart,
  onDrop,
  onMove,
}: Props): React.JSX.Element {
  if (steps.length === 0) {
    return <p className="pt-empty">No steps yet — add the first one above.</p>;
  }
  return (
    <div className="pt-table-wrap">
      <table className="pt-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Action</th>
            <th>Selector</th>
            <th>Value</th>
            <th>Status</th>
            <th className="pt-text-end">Order</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((step, index) => {
            const live = statusByStepId[step.id];
            return (
              <tr
                key={step.id}
                draggable
                onDragStart={() => {
                  onDragStart(step.id);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                }}
                onDrop={() => {
                  onDrop(step.id);
                }}
                onClick={() => {
                  onSelect(step.id);
                }}
                className={step.id === selectedId ? "pt-drag-row pt-row-selected" : "pt-drag-row"}
                data-dragging={dragId === step.id}
              >
                <td>{index + 1}</td>
                <td>
                  <span className="pt-badge">{step.action}</span>
                </td>
                <td className="pt-mono">{step.selector ?? "—"}</td>
                <td className="pt-mono">{step.value ?? "—"}</td>
                <td>
                  {live === undefined ? (
                    <span className="pt-badge pt-badge-mute">—</span>
                  ) : live === "pass" ? (
                    <span className="pt-badge pt-badge-pass">pass</span>
                  ) : live === "fail" ? (
                    <span className="pt-badge pt-badge-fail">fail</span>
                  ) : live === "running" ? (
                    <span className="pt-badge pt-badge-run">running</span>
                  ) : (
                    <span className="pt-badge pt-badge-mute">skipped</span>
                  )}
                </td>
                <td className="pt-text-end pt-nowrap">
                  <button
                    type="button"
                    aria-label={`Move step ${index + 1} up`}
                    className="pt-btn pt-btn-ghost pt-btn-sm"
                    disabled={busy || index === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      onMove(step.id, index - 1);
                    }}
                  >
                    ↑
                  </button>{" "}
                  <button
                    type="button"
                    aria-label={`Move step ${index + 1} down`}
                    className="pt-btn pt-btn-ghost pt-btn-sm"
                    disabled={busy || index === steps.length - 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      onMove(step.id, index + 1);
                    }}
                  >
                    ↓
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
