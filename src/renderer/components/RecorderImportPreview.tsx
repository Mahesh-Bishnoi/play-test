import { useEffect, useRef, useState } from "react";

import type { TestStep } from "../../shared/step-types.js";

export interface RecorderImportSelection {
  step: TestStep;
  accepted: boolean;
}

interface Props {
  steps: TestStep[];
  raw: string;
  busy: boolean;
  onAccept: (selected: TestStep[]) => void;
  onCancel: () => void;
}

/**
 * Import preview modal (WS4 / M4, PLAN §7): accept/edit-before-save.
 */
export default function RecorderImportPreview({
  steps,
  raw,
  busy,
  onAccept,
  onCancel,
}: Props): React.JSX.Element {
  const [accepted, setAccepted] = useState<boolean[]>(() => steps.map(() => true));
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) {
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [busy, onCancel]);

  const toggle = (index: number): void => {
    setAccepted((prev) => prev.map((value, i) => (i === index ? !value : value)));
  };

  const selectedCount = accepted.filter(Boolean).length;

  const accept = (): void => {
    onAccept(steps.filter((_, index) => accepted[index] === true));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Recorded steps preview"
      className="pt-modal-backdrop"
      onClick={() => {
        if (!busy) {
          onCancel();
        }
      }}
    >
      <div
        className="pt-modal"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <div className="pt-section-head">
          <h3>Import recorded steps ({steps.length})</h3>
        </div>
        {steps.length === 0 ? (
          <p className="pt-empty">
            Codegen produced no importable steps.
            {raw === "" ? " The window may have been closed without acting." : ""}
          </p>
        ) : (
          <>
            <p className="pt-hint">
              Uncheck steps to skip them. Steps are appended after your existing steps in order.
            </p>
            <div className="pt-table-wrap">
              <table className="pt-table">
                <thead>
                  <tr>
                    <th>Import</th>
                    <th>#</th>
                    <th>Action</th>
                    <th>Selector</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {steps.map((step, index) => (
                    <tr key={`${step.order}-${index}`}>
                      <td>
                        <input
                          type="checkbox"
                          className="pt-checkbox"
                          aria-label={`Import recorded step ${index + 1} (${step.action})`}
                          checked={accepted[index] === true}
                          disabled={busy}
                          onChange={() => {
                            toggle(index);
                          }}
                        />
                      </td>
                      <td>{index + 1}</td>
                      <td>
                        <span className="pt-badge">{step.action}</span>
                      </td>
                      <td className="pt-mono">{step.selector ?? "—"}</td>
                      <td className="pt-mono">{step.value ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="pt-modal-actions">
          <button
            ref={cancelRef}
            type="button"
            className="pt-btn"
            onClick={onCancel}
            disabled={busy}
          >
            Discard
          </button>
          {steps.length > 0 && (
            <button
              type="button"
              className="pt-btn pt-btn-primary"
              onClick={accept}
              disabled={busy || selectedCount === 0}
            >
              {busy ? "Importing…" : `Import ${selectedCount} step(s)`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
