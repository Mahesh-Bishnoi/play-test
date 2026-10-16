import { useState } from "react";

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
 * Import preview modal (WS4 / M4, PLAN §7): shows parsed codegen steps for
 * accept/edit-before-save. Checkboxes select which steps to import; the empty
 * state (codegen closed without acting) explains instead of failing.
 */
export default function RecorderImportPreview({
  steps,
  raw,
  busy,
  onAccept,
  onCancel,
}: Props): React.JSX.Element {
  const [accepted, setAccepted] = useState<boolean[]>(() => steps.map(() => true));

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
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 8,
          padding: 20,
          maxWidth: 640,
          width: "90%",
          maxHeight: "80vh",
          overflow: "auto",
        }}
      >
        <h3 style={{ marginTop: 0 }}>Import recorded steps ({steps.length})</h3>
        {steps.length === 0 ? (
          <p>
            Codegen produced no importable steps.
            {raw === "" ? " The window may have been closed without acting." : ""}
          </p>
        ) : (
          <>
            <p style={{ color: "#666", fontSize: 13 }}>
              Uncheck steps to skip them. Steps are appended after your existing steps in order.
            </p>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: 4 }}>
                    Import
                  </th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: 4 }}>
                    #
                  </th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: 4 }}>
                    Action
                  </th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: 4 }}>
                    Selector
                  </th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: 4 }}>
                    Value
                  </th>
                </tr>
              </thead>
              <tbody>
                {steps.map((step, index) => (
                  <tr key={`${step.order}-${index}`}>
                    <td style={{ padding: 4, borderBottom: "1px solid #eee" }}>
                      <input
                        type="checkbox"
                        aria-label={`Import recorded step ${index + 1} (${step.action})`}
                        checked={accepted[index] === true}
                        disabled={busy}
                        onChange={() => {
                          toggle(index);
                        }}
                      />
                    </td>
                    <td style={{ padding: 4, borderBottom: "1px solid #eee" }}>{index + 1}</td>
                    <td style={{ padding: 4, borderBottom: "1px solid #eee" }}>{step.action}</td>
                    <td
                      style={{
                        padding: 4,
                        borderBottom: "1px solid #eee",
                        fontFamily: "ui-monospace, monospace",
                        fontSize: 12,
                      }}
                    >
                      {step.selector ?? "—"}
                    </td>
                    <td
                      style={{
                        padding: 4,
                        borderBottom: "1px solid #eee",
                        fontFamily: "ui-monospace, monospace",
                        fontSize: 12,
                      }}
                    >
                      {step.value ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{ padding: "6px 12px", border: "1px solid #888", borderRadius: 4 }}
          >
            Discard
          </button>
          {steps.length > 0 && (
            <button
              type="button"
              onClick={accept}
              disabled={busy || selectedCount === 0}
              style={{
                padding: "6px 12px",
                border: "1px solid #2563eb",
                borderRadius: 4,
                background: "#2563eb",
                color: "#fff",
              }}
            >
              {busy ? "Importing…" : `Import ${selectedCount} step(s)`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
