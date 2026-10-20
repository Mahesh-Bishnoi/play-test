import { useEffect, useState } from "react";

import { api, formatApiError } from "../../api.js";
import RunProgressBar from "../RunProgressBar.js";
import {
  caseStatusLabel,
  caseStatusTone,
  elapsedMs,
  formatElapsedMs,
  isSuiteRunFinished,
  runOutcomeLabel,
  runPercent,
  runVisualState,
} from "./progress-model.js";
import type { RunVisualState } from "./progress-model.js";
import { useRunProgress } from "./use-run-progress.js";

interface Props {
  suiteRunId: string;
  variant?: "panel" | "strip";
  /** Report page: disappear once the run settles (the report itself speaks). */
  hideWhenFinished?: boolean;
  /** Extra explanation shown while the run is still active (report preview). */
  note?: string;
  onViewReport?: (suiteRunId: string) => void;
  onDismiss?: (suiteRunId: string) => void;
}

function stateLabel(state: RunVisualState): string {
  switch (state) {
    case "starting":
      return "Starting…";
    case "running":
      return "Running";
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function stateTone(state: RunVisualState): string {
  return state === "starting" || state === "running"
    ? "run"
    : state === "passed"
      ? "pass"
      : state === "failed"
        ? "fail"
        : "warn";
}

function outcomeTone(state: RunVisualState): string {
  return state === "passed" ? "ok" : state === "failed" ? "error" : "warn";
}

/**
 * Live suite-run monitor (M21). Self-contained: it polls `runner:getProgress`,
 * can cancel the run, and is reused as the full suite-page card, the compact
 * global strip, and the in-app report banner. Finished runs stop polling but
 * stay visible until the parent dismisses them (or `hideWhenFinished`).
 */
export default function RunProgressPanel({
  suiteRunId,
  variant = "panel",
  hideWhenFinished = false,
  note,
  onViewReport,
  onDismiss,
}: Props): React.JSX.Element | null {
  const { progress, error, loading, retry } = useRunProgress(suiteRunId);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // A new run id (rerun failed / next suite run) must not inherit the previous
  // run's cancel state.
  useEffect(() => {
    setCancelBusy(false);
    setCancelRequested(false);
    setCancelError(null);
  }, [suiteRunId]);

  const finished = progress !== null && isSuiteRunFinished(progress.status);
  if (hideWhenFinished && finished) {
    return null;
  }
  // Report page: don't flash a "starting" card for a run that finished before
  // the first poll. The iframe is already loading the final report.
  if (hideWhenFinished && progress === null && error === null) {
    return null;
  }

  const cancel = (): void => {
    setCancelBusy(true);
    setCancelError(null);
    api
      .cancelRun(suiteRunId)
      .then(() => {
        setCancelRequested(true);
      })
      .catch((err: unknown) => {
        setCancelError(formatApiError(err));
      })
      .finally(() => {
        setCancelBusy(false);
      });
  };

  if (error !== null && progress === null) {
    const body = (
      <>
        <p role="alert" className="pt-alert pt-alert-error">
          Run progress unavailable: {error}
        </p>
        <div className="pt-row">
          <button type="button" className="pt-btn pt-btn-sm" onClick={retry}>
            Retry
          </button>
          {onDismiss !== undefined && (
            <button
              type="button"
              className="pt-btn pt-btn-ghost pt-btn-sm"
              onClick={() => {
                onDismiss(suiteRunId);
              }}
            >
              Dismiss
            </button>
          )}
        </div>
      </>
    );
    return variant === "strip" ? (
      <div className="pt-run-strip" role="region" aria-label="Suite run progress">
        {body}
      </div>
    ) : (
      <div className="pt-card pt-run-panel">{body}</div>
    );
  }

  if (progress === null) {
    // First poll in flight (or a suite start that has not produced rows yet).
    const bar = (
      <RunProgressBar
        label="Suite run"
        state="starting"
        completed={0}
        total={0}
        detail={loading ? "Starting suite run…" : "Waiting for progress…"}
      />
    );
    return variant === "strip" ? (
      <div className="pt-run-strip" role="region" aria-label="Suite run progress">
        <div className="pt-run-strip-bar">{bar}</div>
        {onViewReport !== undefined && (
          <button
            type="button"
            className="pt-btn pt-btn-sm"
            onClick={() => {
              onViewReport(suiteRunId);
            }}
          >
            View report
          </button>
        )}
      </div>
    ) : (
      <div className="pt-card pt-run-panel">
        {bar}
        {onViewReport !== undefined && (
          <div className="pt-row">
            <button
              type="button"
              className="pt-btn pt-btn-sm"
              onClick={() => {
                onViewReport(suiteRunId);
              }}
            >
              View report
            </button>
          </div>
        )}
      </div>
    );
  }

  const state = runVisualState(progress);
  const percent = runPercent(progress);
  const { summary } = progress;
  const elapsed = formatElapsedMs(elapsedMs(progress, Date.now()));
  const detailParts = [
    `${summary.completed} of ${summary.total} case(s) complete`,
    summary.running > 0 ? `${summary.running} running` : null,
    summary.pending > 0 ? `${summary.pending} pending` : null,
    summary.failed > 0 ? `${summary.failed} failed` : null,
    summary.passed > 0 ? `${summary.passed} passed` : null,
  ].filter((part): part is string => part !== null);

  const actions = (
    <div className="pt-row pt-run-actions">
      {!finished && (
        <button
          type="button"
          className="pt-btn pt-btn-danger pt-btn-sm"
          onClick={cancel}
          disabled={cancelBusy || cancelRequested}
          title="Stop after the current step — remaining cases/steps are cancelled or skipped"
        >
          {cancelRequested ? "Cancelling…" : cancelBusy ? "Requesting…" : "Cancel run"}
        </button>
      )}
      {onViewReport !== undefined && (
        <button
          type="button"
          className="pt-btn pt-btn-sm"
          onClick={() => {
            onViewReport(suiteRunId);
          }}
        >
          View report
        </button>
      )}
      {finished && onDismiss !== undefined && (
        <button
          type="button"
          className="pt-btn pt-btn-ghost pt-btn-sm"
          onClick={() => {
            onDismiss(suiteRunId);
          }}
        >
          Dismiss
        </button>
      )}
    </div>
  );

  const errorLine =
    cancelError !== null || error !== null ? (
      <div role="alert" className="pt-alert pt-alert-error">
        <span>{cancelError ?? `Live updates paused: ${error ?? "unknown error"}`}</span>
        {error !== null && (
          <button type="button" className="pt-btn pt-btn-sm pt-mt-8" onClick={retry}>
            Retry
          </button>
        )}
      </div>
    ) : null;

  if (variant === "strip") {
    return (
      <div className="pt-run-strip" role="region" aria-label="Suite run progress">
        <span className={`pt-badge pt-badge-${stateTone(state)}`}>{stateLabel(state)}</span>
        <div className="pt-run-strip-bar">
          <RunProgressBar
            label={progress.suiteName !== null ? `Suite run — ${progress.suiteName}` : "Suite run"}
            state={state}
            completed={summary.completed}
            total={summary.total}
            detail={`${detailParts.join(" · ")} · ${finished ? "took" : "elapsed"} ${elapsed}`}
          />
        </div>
        {actions}
        {finished && (
          <p role="status" className="pt-hint">
            {runOutcomeLabel(progress)}
          </p>
        )}
        {errorLine}
      </div>
    );
  }

  return (
    <div className="pt-card pt-run-panel">
      <div className="pt-section-head">
        <h3>Suite run</h3>
        <span className={`pt-badge pt-badge-${stateTone(state)}`}>{stateLabel(state)}</span>
        {progress.suiteName !== null && <span className="pt-count">{progress.suiteName}</span>}
        <span className="pt-spacer" />
        <span className="pt-count pt-mono" title={suiteRunId}>
          {suiteRunId.slice(0, 8)} · {finished ? "took" : "elapsed"} {elapsed}
        </span>
      </div>
      <RunProgressBar
        label="Cases complete"
        state={state}
        completed={summary.completed}
        total={summary.total}
        detail={detailParts.join(" · ")}
      />
      <ul className="pt-run-cases" aria-label="Cases in this run">
        {progress.cases.map((testCase) => (
          <li key={testCase.caseRunId} className="pt-run-case">
            <span className={`pt-badge pt-badge-${caseStatusTone(testCase.status)}`}>
              {caseStatusLabel(testCase.status)}
            </span>
            <span className="pt-run-case-name" title={testCase.caseName}>
              {testCase.caseName}
            </span>
            {testCase.status === "running" && (
              <span className="pt-hint pt-run-case-state">running…</span>
            )}
            {testCase.durationMs !== null && (
              <span className="pt-count">{formatElapsedMs(testCase.durationMs)}</span>
            )}
          </li>
        ))}
      </ul>
      <p className="pt-hint">
        {percent}% of cases complete
        {progress.mode === "unsupervised" ? " · headless, parallel" : ""}
      </p>
      {note !== undefined && !finished && <p className="pt-hint">{note}</p>}
      {finished && (
        <p role="status" className={`pt-alert pt-alert-${outcomeTone(state)}`}>
          {runOutcomeLabel(progress)}
        </p>
      )}
      {actions}
      {errorLine}
    </div>
  );
}
