import { useEffect, useRef, useState } from "react";

import type { RecorderUnsupported } from "../../shared/ipc-contract.js";
import type { TestStep } from "../../shared/step-types.js";
import ConfirmDialog from "./ConfirmDialog.js";

export interface RecorderImportSelection {
  step: TestStep;
  accepted: boolean;
}

interface Props {
  steps: TestStep[];
  unsupported: RecorderUnsupported[];
  raw: string;
  busy: boolean;
  onAccept: (selected: TestStep[]) => void;
  onCancel: () => void;
}

/**
 * Import preview modal (WS4 / M4, PLAN §7; M15 reports unsupported lines):
 * accept/edit-before-save, with the codegen lines the parser could not map
 * listed so the user adds them as manual steps.
 */
export default function RecorderImportPreview({
  steps,
  unsupported,
  raw,
  busy,
  onAccept,
  onCancel,
}: Props): React.JSX.Element {
  const [accepted, setAccepted] = useState<boolean[]>(() => steps.map(() => true));
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Escape/backdrop/Discard throw away a parsed recording; ask first (review N4).
  const requestCancel = (): void => {
    if (!busy) {
      setConfirmingDiscard(true);
    }
  };

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) {
        setConfirmingDiscard(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [busy]);

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
        requestCancel();
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
        {unsupported.length > 0 && (
          <div className="pt-mb-10" role="status">
            <p className="pt-warn-text">
              These recorded lines are not supported — add them as manual steps.
            </p>
            <ul className="pt-hint">
              {unsupported.map((entry, index) => (
                <li key={`${index}-${entry.line}`}>
                  <code className="pt-mono">{entry.line}</code> — {entry.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        {steps.length === 0 ? (
          <p className="pt-empty">
            Codegen produced no importable steps.
            {unsupported.length > 0 ? " The lines above were not recognised." : ""}
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
            onClick={requestCancel}
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
      {confirmingDiscard && (
        <ConfirmDialog
          title="Discard recorded steps?"
          body="The parsed recording will be lost. Record again to get it back."
          confirmLabel="Discard recording"
          onConfirm={() => {
            setConfirmingDiscard(false);
            onCancel();
          }}
          onCancel={() => {
            setConfirmingDiscard(false);
          }}
        />
      )}
    </div>
  );
}
