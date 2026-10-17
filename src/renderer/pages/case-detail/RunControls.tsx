import type { RunMode } from "../../../shared/schema.js";
import type { ActiveRun } from "./use-case-run.js";

/** Pre-run pacing presets for supervised runs (ms between steps). */
const SUPERVISED_SPEEDS = [
  { label: "Instant", ms: 0 },
  { label: "Normal (0.6s)", ms: 600 },
  { label: "Slow (1.5s)", ms: 1500 },
  { label: "Very slow (3s)", ms: 3000 },
] as const;

interface Props {
  activeRun: ActiveRun | null;
  paused: boolean;
  failedOrder: number | null;
  runBusy: boolean;
  busy: boolean;
  recording: boolean;
  hasSteps: boolean;
  runSpeedMs: number;
  onSpeedChange: (ms: number) => void;
  onStart: (mode: RunMode) => void;
  onResume: () => void;
  onCancel: () => void;
  onFullRerun: (mode: RunMode) => void;
}

/**
 * Idle run controls (speed preset + start buttons) or the controls for a run in
 * flight (resume when paused, full re-run, cancel).
 */
export default function RunControls({
  activeRun,
  paused,
  failedOrder,
  runBusy,
  busy,
  recording,
  hasSteps,
  runSpeedMs,
  onSpeedChange,
  onStart,
  onResume,
  onCancel,
  onFullRerun,
}: Props): React.JSX.Element {
  const startDisabled = busy || runBusy || recording || !hasSteps;
  if (activeRun === null) {
    return (
      <>
        <label className="pt-label-inline">
          Speed
          <select
            aria-label="Supervised run speed"
            className="pt-select"
            value={runSpeedMs}
            disabled={startDisabled}
            onChange={(e) => {
              onSpeedChange(Number(e.target.value));
            }}
            title="Delay between steps in supervised runs"
          >
            {SUPERVISED_SPEEDS.map((s) => (
              <option key={s.label} value={s.ms}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="pt-btn pt-btn-primary pt-btn-sm"
          onClick={() => {
            onStart("supervised");
          }}
          disabled={startDisabled}
          title="Headed, pauses on failure — resume from the failed step"
        >
          Run supervised
        </button>
        <button
          type="button"
          className="pt-btn pt-btn-sm"
          onClick={() => {
            onStart("unsupervised");
          }}
          disabled={startDisabled}
          title="Headless, never pauses"
        >
          Run unsupervised
        </button>
      </>
    );
  }
  return (
    <>
      {paused && failedOrder !== null && (
        <>
          <button
            type="button"
            className="pt-btn pt-btn-primary pt-btn-sm"
            onClick={onResume}
            disabled={runBusy}
            title="Edit the failed step above, then continue in the same browser"
          >
            Resume from step {failedOrder + 1}
          </button>
          <button
            type="button"
            className="pt-btn pt-btn-sm"
            onClick={() => {
              onFullRerun(activeRun.mode);
            }}
            disabled={runBusy}
          >
            Full re-run
          </button>
        </>
      )}
      <button
        type="button"
        className="pt-btn pt-btn-danger pt-btn-sm"
        onClick={onCancel}
        disabled={runBusy}
      >
        Cancel run
      </button>
      <span className="pt-hint">
        {paused
          ? `Paused at step ${(failedOrder ?? 0) + 1} — edit the step, then Resume.`
          : `Running (${activeRun.mode})… steps color live in the graph.`}
      </span>
    </>
  );
}
