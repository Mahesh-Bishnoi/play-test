import { useCallback, useEffect, useState } from "react";

import type { StepAction } from "../../shared/step-types.js";
import { STEP_ACTIONS } from "../../shared/step-types.js";
import { api } from "../api.js";
import type { CaseDetail } from "../api.js";
import StepEditorPanel from "../components/StepEditorPanel.js";
import type { StepPatch } from "../components/StepEditorPanel.js";
import StepGraph from "../components/StepGraph.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buttonStyle(disabled?: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    border: "1px solid #888",
    borderRadius: 4,
    background: disabled === true ? "#eee" : "#fff",
    cursor: disabled === true ? "not-allowed" : "pointer",
    fontSize: 14,
  };
}

interface Props {
  caseId: string;
  onBack: () => void;
}

/**
 * Workflow editor for one test case (WS3 / M3, PLAN §6): linear step graph,
 * click-to-edit panel with `{{key}}` hints, add/delete, up/down + drag
 * reorder. No execution here — Record lands in WS4 (M4), runs in WS5 (M5);
 * the buttons below are disabled placeholders so the layout is final.
 */
export default function CaseDetailPage({ caseId, onBack }: Props): React.JSX.Element {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [testKeys, setTestKeys] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [newAction, setNewAction] = useState<StepAction>("goto");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setBusy(true);
    api
      .getCaseDetail(caseId)
      .then((loaded) => {
        setDetail(loaded);
        setSelectedId((prev) =>
          prev !== null && loaded.steps.some((s) => s.id === prev)
            ? prev
            : (loaded.steps[0]?.id ?? null),
        );
        setError(null);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
    api
      .getTestData(caseId)
      .then((data) => {
        setTestKeys(Object.keys(data));
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
  }, [caseId]);

  useEffect(() => {
    setDetail(null);
    setSelectedId(null);
    setNotice(null);
    refresh();
  }, [caseId, refresh]);

  const mutate = (task: Promise<unknown>, done: string): void => {
    setBusy(true);
    setNotice(null);
    task
      .then(() => {
        setNotice(done);
        refresh();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
        setBusy(false);
      });
  };

  const steps = detail?.steps ?? [];
  const selected = steps.find((s) => s.id === selectedId) ?? null;

  const addStep = (): void => {
    mutate(api.upsertStep(caseId, { order: steps.length, action: newAction }), "Step added.");
  };

  const saveStep = (patch: StepPatch): void => {
    if (selected === null) {
      return;
    }
    mutate(
      api.upsertStep(caseId, { id: selected.id, order: selected.order, ...patch }),
      "Step saved.",
    );
  };

  const deleteStep = (id: string): void => {
    if (selectedId === id) {
      setSelectedId(null);
    }
    mutate(api.deleteStep(caseId, id), "Step deleted.");
  };

  const moveStep = (id: string, toOrder: number): void => {
    mutate(api.moveStep(caseId, id, toOrder), "Step moved.");
  };

  const dropReorder = (targetId: string): void => {
    if (dragId === null || dragId === targetId) {
      return;
    }
    const ids = steps.map((s) => s.id).filter((id) => id !== dragId);
    const targetIndex = ids.indexOf(targetId);
    if (targetIndex === -1) {
      return;
    }
    ids.splice(targetIndex, 0, dragId);
    setDragId(null);
    mutate(api.reorderSteps(caseId, ids), "Steps reordered.");
  };

  return (
    <section aria-label="Case workflow" style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" onClick={onBack} style={buttonStyle()}>
          ← Back to suites
        </button>
        <h2 style={{ margin: 0 }}>
          {detail === null ? "Loading case…" : detail.case.name}
          {detail !== null && steps.length > 0 && (
            <span style={{ color: "#666", fontWeight: "normal" }}> — {steps.length} step(s)</span>
          )}
        </h2>
      </div>
      {error !== null && (
        <p role="alert" style={{ color: "red" }}>
          {error}
        </p>
      )}
      {notice !== null && (
        <p role="status" style={{ color: "green" }}>
          {notice}
        </p>
      )}

      {detail !== null && (
        <>
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 420px", minWidth: 320 }}>
              <StepGraph steps={steps} selectedId={selectedId} onSelect={setSelectedId} />
            </div>
            {selected !== null ? (
              <StepEditorPanel
                key={selected.id}
                step={selected}
                availableKeys={testKeys}
                busy={busy}
                onSave={saveStep}
                onDelete={deleteStep}
              />
            ) : (
              <p style={{ color: "#666" }}>Select a step in the graph or table to edit it.</p>
            )}
          </div>

          <div>
            <h3>Steps</h3>
            <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <select
                aria-label="New step action"
                value={newAction}
                disabled={busy}
                onChange={(e) => {
                  setNewAction(e.target.value as StepAction);
                }}
                style={{ padding: "6px 8px", border: "1px solid #ccc", borderRadius: 4 }}
              >
                {STEP_ACTIONS.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={addStep} disabled={busy} style={buttonStyle(busy)}>
                Add step
              </button>
              <span style={{ color: "#666", fontSize: 13, alignSelf: "center" }}>
                Drag rows to reorder, or use ↑ ↓.
              </span>
            </div>
            {steps.length === 0 ? (
              <p>No steps yet — add the first one above.</p>
            ) : (
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
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
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: 4 }}>
                      Order
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {steps.map((step, index) => (
                    <tr
                      key={step.id}
                      draggable
                      onDragStart={() => {
                        setDragId(step.id);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                      }}
                      onDrop={() => {
                        dropReorder(step.id);
                      }}
                      onClick={() => {
                        setSelectedId(step.id);
                      }}
                      style={{
                        background: step.id === selectedId ? "#eff6ff" : undefined,
                        cursor: "pointer",
                        opacity: dragId === step.id ? 0.5 : 1,
                      }}
                    >
                      <td style={{ padding: 4, borderBottom: "1px solid #eee" }}>{index + 1}</td>
                      <td style={{ padding: 4, borderBottom: "1px solid #eee" }}>{step.action}</td>
                      <td
                        style={{
                          padding: 4,
                          borderBottom: "1px solid #eee",
                          fontFamily: "ui-monospace, monospace",
                          fontSize: 13,
                        }}
                      >
                        {step.selector ?? "—"}
                      </td>
                      <td
                        style={{
                          padding: 4,
                          borderBottom: "1px solid #eee",
                          fontFamily: "ui-monospace, monospace",
                          fontSize: 13,
                        }}
                      >
                        {step.value ?? "—"}
                      </td>
                      <td style={{ padding: 4, borderBottom: "1px solid #eee" }}>
                        <button
                          type="button"
                          aria-label={`Move step ${index + 1} up`}
                          disabled={busy || index === 0}
                          onClick={(e) => {
                            e.stopPropagation();
                            moveStep(step.id, index - 1);
                          }}
                          style={buttonStyle(busy || index === 0)}
                        >
                          ↑
                        </button>{" "}
                        <button
                          type="button"
                          aria-label={`Move step ${index + 1} down`}
                          disabled={busy || index === steps.length - 1}
                          onClick={(e) => {
                            e.stopPropagation();
                            moveStep(step.id, index + 1);
                          }}
                          style={buttonStyle(busy || index === steps.length - 1)}
                        >
                          ↓
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              borderTop: "1px solid #ddd",
              paddingTop: 12,
            }}
          >
            <button
              type="button"
              disabled
              title="Recording lands with WS4 (M4)"
              style={buttonStyle(true)}
            >
              Record…
            </button>
            <button
              type="button"
              disabled
              title="Supervised run lands with WS5 (M5)"
              style={buttonStyle(true)}
            >
              Run supervised
            </button>
            <button
              type="button"
              disabled
              title="Unsupervised run lands with WS5 (M5)"
              style={buttonStyle(true)}
            >
              Run unsupervised
            </button>
            <span style={{ color: "#666", fontSize: 13, alignSelf: "center" }}>
              Record + runs are disabled in M3 — the editor above is fully functional.
            </span>
          </div>
        </>
      )}
    </section>
  );
}
