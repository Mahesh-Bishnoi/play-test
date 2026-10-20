import type { RunVisualState } from "./run-progress/progress-model.js";

export type ProgressBarState = RunVisualState | "paused";

interface Props {
  label: string;
  state: ProgressBarState;
  completed: number;
  total: number;
  /** Optional human sentence under the bar (step counts, pause hint, …). */
  detail?: string;
}

function toneOf(state: ProgressBarState): string {
  switch (state) {
    case "passed":
      return "pass";
    case "failed":
      return "fail";
    case "paused":
      return "warn";
    case "cancelled":
      return "mute";
    default:
      return "run";
  }
}

/**
 * Accessible run-progress bar (M21). Determinate once both counts are known and
 * the run has started; indeterminate while a browser/suite is spinning up.
 * Text always carries the state — colour is a secondary cue.
 */
export default function RunProgressBar({
  label,
  state,
  completed,
  total,
  detail,
}: Props): React.JSX.Element {
  const determinate = total > 0 && state !== "starting";
  const safeCompleted = Math.max(0, Math.min(completed, total));
  const percent =
    total <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((safeCompleted / total) * 100)));
  const valueText = determinate
    ? `${safeCompleted} of ${total} complete (${percent}%)`
    : state === "starting"
      ? "Starting…"
      : "Waiting for progress…";

  return (
    <div className="pt-progress">
      <div className="pt-progress-head">
        <span className="pt-progress-label">{label}</span>
        <span className="pt-progress-value">
          {determinate ? `${safeCompleted} / ${total} · ${percent}%` : "Starting…"}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuemax={determinate ? total : undefined}
        aria-valuenow={determinate ? safeCompleted : undefined}
        aria-valuetext={valueText}
        className={`pt-progress-track pt-progress-${toneOf(state)}${
          determinate ? "" : " pt-progress-indeterminate"
        }`}
      >
        <span
          className="pt-progress-fill"
          style={determinate ? { inlineSize: `${percent}%` } : undefined}
        />
      </div>
      {detail !== undefined && detail !== "" && <p className="pt-progress-detail">{detail}</p>}
    </div>
  );
}
