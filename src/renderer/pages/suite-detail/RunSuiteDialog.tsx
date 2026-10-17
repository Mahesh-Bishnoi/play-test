import type { TestCase } from "../../../shared/schema.js";

interface Props {
  suiteName: string;
  cases: TestCase[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Confirm dialog for a suite run — supervised mode is single-case only. */
export default function RunSuiteDialog({
  suiteName,
  cases,
  busy,
  onCancel,
  onConfirm,
}: Props): React.JSX.Element {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirm suite run"
      className="pt-modal-backdrop"
      onClick={onCancel}
    >
      <div
        className="pt-modal pt-confirm"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <div className="pt-section-head">
          <h3>Run suite (unsupervised only)</h3>
        </div>
        <p className="pt-sub">
          Suite <strong>{suiteName}</strong> — {cases.length} case(s)
        </p>
        <ul>
          {cases.map((c) => (
            <li key={c.id}>{c.name}</li>
          ))}
        </ul>
        <p className="pt-hint">
          Headless and parallel, never pauses. Each case runs independently; a failure skips only
          that case&apos;s remaining steps.
        </p>
        <div className="pt-modal-actions">
          <button type="button" className="pt-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="pt-btn pt-btn-primary"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Starting…" : `Confirm (${cases.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}
