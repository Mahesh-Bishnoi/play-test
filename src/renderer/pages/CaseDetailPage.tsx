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
import TestDataEditor from "../components/TestDataEditor.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Props {
  caseId: string;
  onBack: () => void;
}

/**
 * Workflow editor for one test case (WS3 / M3 + WS4 / M4 + WS5 / M5 + M6/M7,
 * PLAN §6–§8 + §10): linear step graph, click-to-edit panel, add/delete,
 * reorder, codegen recording with import preview, KV test-data editor, and
 * single-case runs with live step status, supervised pause/resume, cancel.
 */
export default function CaseDetailPage({ caseId, onBack }: Props): React.JSX.Element {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [testKeys, setTestKeys] = useState<string[]>([]);
  const [testData, setTestData] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [newAction, setNewAction] = useState<StepAction>("goto");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordUrl, setRecordUrl] = useState("");
  const [preview, setPreview] = useState<{ steps: TestStep[]; raw: string } | null>(null);
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
        setTestData(data);
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

  const runBadge =
    activeRun !== null ? (
      <span className="pt-badge pt-badge-run">
        <span className="pt-badge-dot" aria-hidden="true" />
        Running · {activeRun.mode}
      </span>
    ) : paused ? (
      <span className="pt-badge pt-badge-fail">Paused</span>
    ) : runFinished !== null ? (
      <span className="pt-badge pt-badge-pass">{runFinished}</span>
    ) : (
      <span className="pt-badge pt-badge-mute">Idle</span>
    );

  return (
    <section aria-label="Case workflow" style={{ display: "grid", gap: 16 }}>
      <div className="pt-topbar">
        <button type="button" className="pt-btn pt-btn-sm" onClick={onBack}>
          ← Back to suites
        </button>
        <h2>{detail === null ? "Loading case…" : detail.case.name}</h2>
        {detail !== null && steps.length > 0 && (
          <span className="pt-badge">{steps.length} steps</span>
        )}
        {runBadge}
      </div>
      {error !== null && (
        <p role="alert" className="pt-alert pt-alert-error">
          {error}
        </p>
      )}
      {notice !== null && (
        <p role="status" className="pt-alert pt-alert-ok">
          {notice}
        </p>
      )}

      {detail !== null && (
        <>
          <div className="pt-grid-2">
            <StepGraph
              steps={steps}
              statusByStepId={statusByStepId}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
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
              <p className="pt-empty">Select a step in the graph or table to edit it.</p>
            )}
          </div>

          <div className="pt-card">
            <div className="pt-section-head">
              <h3>Steps</h3>
              <span className="pt-count">Drag rows to reorder, or use ↑ ↓</span>
            </div>
            <div className="pt-row" style={{ marginBottom: 12 }}>
              <select
                aria-label="New step action"
                className="pt-select"
                value={newAction}
                disabled={busy}
                onChange={(e) => {
                  setNewAction(e.target.value as StepAction);
                }}
              >
                {STEP_ACTIONS.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <button type="button" className="pt-btn pt-btn-sm" onClick={addStep} disabled={busy}>
                Add step
              </button>
            </div>
            {steps.length === 0 ? (
              <p className="pt-empty">No steps yet — add the first one above.</p>
            ) : (
              <div className="pt-table-wrap">
                <table className="pt-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Action</th>
                      <th>Selector</th>
                      <th>Value</th>
                      <th>Status</th>
                      <th style={{ textAlign: "end" }}>Order</th>
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
                          className={step.id === selectedId ? "pt-row-selected" : undefined}
                          style={{
                            cursor: "pointer",
                            opacity: dragId === step.id ? 0.5 : 1,
                          }}
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
                          <td style={{ textAlign: "end", whiteSpace: "nowrap" }}>
                            <button
                              type="button"
                              aria-label={`Move step ${index + 1} up`}
                              className="pt-btn pt-btn-sm"
                              disabled={busy || index === 0}
                              onClick={(e) => {
                                e.stopPropagation();
                                moveStep(step.id, index - 1);
                              }}
                            >
                              ↑
                            </button>{" "}
                            <button
                              type="button"
                              aria-label={`Move step ${index + 1} down`}
                              className="pt-btn pt-btn-sm"
                              disabled={busy || index === steps.length - 1}
                              onClick={(e) => {
                                e.stopPropagation();
                                moveStep(step.id, index + 1);
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
            )}
          </div>

          <div className="pt-card">
            <div className="pt-section-head">
              <h3>Test data</h3>
            </div>
            <p className="pt-hint" style={{ marginBottom: 10 }}>
              {"Values substitute {{key}} in step values at run time."}
            </p>
            <TestDataEditor
              key={caseId}
              caseId={caseId}
              initial={testData}
              onSaved={() => {
                setNotice("Test data saved.");
                refresh();
              }}
            />
          </div>

          <div className="pt-card">
            <div className="pt-section-head">
              <h3>Record &amp; run</h3>
              {recording && <span className="pt-badge pt-badge-fail">recording</span>}
            </div>
            <div className="pt-row">
              <input
                aria-label="Record URL"
                className="pt-input pt-mono"
                placeholder="https://…"
                value={recordUrl}
                disabled={busy || recording}
                onChange={(e) => {
                  setRecordUrl(e.target.value);
                }}
                style={{ maxInlineSize: 280 }}
              />
              {recording ? (
                <button
                  type="button"
                  className="pt-btn pt-btn-sm"
                  onClick={stopRecording}
                  disabled={busy}
                >
                  Stop + import…
                </button>
              ) : (
                <button
                  type="button"
                  className="pt-btn pt-btn-sm"
                  onClick={startRecording}
                  disabled={busy || activeRun !== null}
                >
                  Record…
                </button>
              )}
              {activeRun === null ? (
                <>
                  <button
                    type="button"
                    className="pt-btn pt-btn-primary pt-btn-sm"
                    onClick={() => {
                      startRun("supervised");
                    }}
                    disabled={busy || runBusy || recording || steps.length === 0}
                    title="Headed, pauses on failure — resume from the failed step"
                  >
                    Run supervised
                  </button>
                  <button
                    type="button"
                    className="pt-btn pt-btn-sm"
                    onClick={() => {
                      startRun("unsupervised");
                    }}
                    disabled={busy || runBusy || recording || steps.length === 0}
                    title="Headless, never pauses"
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
                        className="pt-btn pt-btn-primary pt-btn-sm"
                        onClick={resumeRun}
                        disabled={runBusy}
                        title="Edit the failed step above, then continue in the same browser"
                      >
                        Resume from step {failedOrder + 1}
                      </button>
                      <button
                        type="button"
                        className="pt-btn pt-btn-sm"
                        onClick={() => {
                          fullRerun(activeRun.mode);
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
                    onClick={cancelRun}
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
              )}
            </div>
            {runFinished !== null && (
              <p role="status" className="pt-alert pt-alert-info" style={{ marginTop: 12 }}>
                {runFinished}
              </p>
            )}
          </div>
          {runLogs.length > 0 && (
            <details className="pt-panel">
              <summary>Run log ({runLogs.length})</summary>
              <pre className="pt-runlog">{runLogs.join("\n")}</pre>
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
