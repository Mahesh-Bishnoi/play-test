import { useCallback, useEffect, useMemo, useState } from "react";

import type { RunMode } from "../../shared/schema.js";
import type { StepAction, StepStatus } from "../../shared/step-types.js";
import type { TestStep } from "../../shared/step-types.js";
import { STEP_ACTIONS } from "../../shared/step-types.js";
import { api } from "../api.js";
import type { CaseDetail } from "../api.js";
import RecorderImportPreview from "../components/RecorderImportPreview.js";
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
 * Workflow editor for one test case (WS3 / M3 + WS4 / M4 + WS5 / M5, PLAN
 * §6–§8): linear step graph, click-to-edit panel with `{{key}}` hints,
 * add/delete, up/down + drag reorder, codegen recording with import preview,
 * and single-case runs with live step status, supervised pause/resume, and
 * cancel. Suite runs + reports land in M6.
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
  const [recording, setRecording] = useState(false);
  const [recordUrl, setRecordUrl] = useState("");
  const [preview, setPreview] = useState<{ steps: TestStep[]; raw: string } | null>(null);
  // Live run state (WS5): statuses arrive over run:step-update keyed by order.
  const [activeRun, setActiveRun] = useState<{
    suiteRunId: string;
    caseRunId: string;
    mode: RunMode;
  } | null>(null);
  const [statusByOrder, setStatusByOrder] = useState<Record<number, StepStatus>>({});
  const [runLogs, setRunLogs] = useState<string[]>([]);
  const [failedOrder, setFailedOrder] = useState<number | null>(null);
  const [runFinished, setRunFinished] = useState<string | null>(null);
  const [runBusy, setRunBusy] = useState(false);

  const refresh = useCallback(() => {
    setBusy(true);
    api
      .getCaseDetail(caseId)
      .then((loaded) => {
        setDetail(loaded);
        setRecordUrl((prev) => (prev === "" ? (loaded.case.url ?? "") : prev));
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
    setActiveRun(null);
    setStatusByOrder({});
    setRunLogs([]);
    setFailedOrder(null);
    setRunFinished(null);
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

  // Live status keyed by order → by step id for the graph (WS5 fills this).
  const statusByStepId = useMemo<Record<string, StepStatus>>(() => {
    const map: Record<string, StepStatus> = {};
    for (const step of steps) {
      const status = statusByOrder[step.order];
      if (status !== undefined) {
        map[step.id] = status;
      }
    }
    return map;
  }, [steps, statusByOrder]);

  // Subscribe to run:* streams for the active run; filters guard against
  // stale events from a previous run (cancel-then-rerun races).
  useEffect(() => {
    if (activeRun === null) {
      return;
    }
    const { caseRunId, suiteRunId } = activeRun;
    const offStep = api.onRunStepUpdate((event) => {
      if (event.caseRunId !== caseRunId) {
        return;
      }
      setStatusByOrder((prev) => ({ ...prev, [event.order]: event.status }));
      if (event.status === "fail") {
        setFailedOrder(event.order);
      }
    });
    const offLog = api.onRunLog((event) => {
      setRunLogs((prev) => [...prev.slice(-29), `[${event.level}] ${event.msg}`]);
    });
    const offDone = api.onRunFinished((event) => {
      if (event.suiteRunId !== suiteRunId) {
        return;
      }
      const s = event.summary;
      setRunFinished(
        `Finished: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped (of ${s.total}).`,
      );
      setActiveRun(null);
    });
    return () => {
      offStep();
      offLog();
      offDone();
    };
  }, [activeRun]);

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

  const startRecording = (): void => {
    const baseUrl = recordUrl.trim() === "" ? (detail?.case.url ?? "") : recordUrl.trim();
    if (baseUrl === "") {
      setError("Enter a URL to record from (or set the case URL first).");
      return;
    }
    setBusy(true);
    setError(null);
    api
      .startRecorder(baseUrl)
      .then(() => {
        setRecording(true);
        setNotice("Recording… interact with the codegen browser window, then Stop + import.");
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const stopRecording = (): void => {
    setBusy(true);
    api
      .stopRecorder()
      .then((result) => {
        setRecording(false);
        setPreview(result);
        setNotice(null);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
        setRecording(false);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const importRecorded = (selected: TestStep[]): void => {
    const base = steps.length;
    setBusy(true);
    (async () => {
      for (const [index, step] of selected.entries()) {
        await api.upsertStep(caseId, { ...step, order: base + index });
      }
    })()
      .then(() => {
        setPreview(null);
        setNotice(`Imported ${selected.length} recorded step(s).`);
        refresh();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
        setBusy(false);
      });
  };

  const startRun = (mode: RunMode): void => {
    setRunBusy(true);
    setError(null);
    api
      .runSingleCase(caseId, mode)
      .then((ids) => {
        setActiveRun({ ...ids, mode });
        setStatusByOrder({});
        setFailedOrder(null);
        setRunFinished(null);
        setRunLogs([]);
        setNotice(`Run started (${mode}).`);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setRunBusy(false);
      });
  };

  const resumeRun = (): void => {
    if (activeRun === null || failedOrder === null) {
      return;
    }
    const { caseRunId } = activeRun;
    const order = failedOrder;
    setRunBusy(true);
    setError(null);
    api
      .resumeFromStep(caseRunId, order)
      .then(() => {
        setFailedOrder(null);
        setNotice(`Resumed from step ${order + 1} — edits made while paused apply.`);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setRunBusy(false);
      });
  };

  const cancelRun = (): void => {
    if (activeRun === null) {
      return;
    }
    const { suiteRunId } = activeRun;
    setRunBusy(true);
    api
      .cancelRun(suiteRunId)
      .then(() => {
        setNotice("Cancel requested — remaining steps skip.");
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setRunBusy(false);
      });
  };

  // A paused supervised session still holds the runner: cancel it first so
  // the full re-run gets a fresh session instead of an "already active" error.
  const fullRerun = (mode: RunMode): void => {
    if (activeRun === null) {
      startRun(mode);
      return;
    }
    const { suiteRunId } = activeRun;
    setRunBusy(true);
    setError(null);
    api
      .cancelRun(suiteRunId)
      .then(() => {
        startRun(mode);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
        setRunBusy(false);
      });
  };

  const paused = activeRun !== null && activeRun.mode === "supervised" && failedOrder !== null;

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
              <StepGraph
                steps={steps}
                statusByStepId={statusByStepId}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
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
              alignItems: "center",
            }}
          >
            <input
              aria-label="Record URL"
              placeholder="https://…"
              value={recordUrl}
              disabled={busy || recording}
              onChange={(e) => {
                setRecordUrl(e.target.value);
              }}
              style={{ padding: "6px 8px", border: "1px solid #ccc", borderRadius: 4, width: 240 }}
            />
            {recording ? (
              <button
                type="button"
                onClick={stopRecording}
                disabled={busy}
                style={buttonStyle(busy)}
              >
                Stop + import…
              </button>
            ) : (
              <button
                type="button"
                onClick={startRecording}
                disabled={busy || activeRun !== null}
                style={buttonStyle(busy || activeRun !== null)}
              >
                Record…
              </button>
            )}
            {activeRun === null ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    startRun("supervised");
                  }}
                  disabled={busy || runBusy || recording || steps.length === 0}
                  title="Headed, pauses on failure — resume from the failed step"
                  style={buttonStyle(busy || runBusy || recording || steps.length === 0)}
                >
                  Run supervised
                </button>
                <button
                  type="button"
                  onClick={() => {
                    startRun("unsupervised");
                  }}
                  disabled={busy || runBusy || recording || steps.length === 0}
                  title="Headless, never pauses"
                  style={buttonStyle(busy || runBusy || recording || steps.length === 0)}
                >
                  Run unsupervised
                </button>
              </>
            ) : (
              <>
                {paused && failedOrder !== null && (
                  <>
                    <button
                      type="button"
                      onClick={resumeRun}
                      disabled={runBusy}
                      title="Edit the failed step above, then continue in the same browser"
                      style={buttonStyle(runBusy)}
                    >
                      Resume from step {failedOrder + 1}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        fullRerun(activeRun.mode);
                      }}
                      disabled={runBusy}
                      style={buttonStyle(runBusy)}
                    >
                      Full re-run
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={cancelRun}
                  disabled={runBusy}
                  style={buttonStyle(runBusy)}
                >
                  Cancel run
                </button>
                <span style={{ color: "#666", fontSize: 13, alignSelf: "center" }}>
                  {paused
                    ? `Paused at step ${(failedOrder ?? 0) + 1} — edit the step, then Resume.`
                    : `Running (${activeRun.mode})… steps color live in the graph.`}
                </span>
              </>
            )}
            {runFinished !== null && (
              <span role="status" style={{ color: "#333", fontSize: 13, alignSelf: "center" }}>
                {runFinished}
              </span>
            )}
          </div>
          {runLogs.length > 0 && (
            <details>
              <summary>Run log ({runLogs.length})</summary>
              <pre style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{runLogs.join("\n")}</pre>
            </details>
          )}
          {preview !== null && (
            <RecorderImportPreview
              steps={preview.steps}
              raw={preview.raw}
              busy={busy}
              onAccept={importRecorded}
              onCancel={() => {
                setPreview(null);
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
