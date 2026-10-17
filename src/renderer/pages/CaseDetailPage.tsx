import { useCallback, useEffect, useMemo, useState } from "react";

import type { RecorderUnsupported } from "../../shared/ipc-contract.js";
import type { TestCase } from "../../shared/schema.js";
import type { StepAction, StepStatus } from "../../shared/step-types.js";
import type { TestStep } from "../../shared/step-types.js";
import { STEP_ACTIONS } from "../../shared/step-types.js";
import { api, formatApiError } from "../api.js";
import type { CaseDetail } from "../api.js";
import RecorderImportPreview from "../components/RecorderImportPreview.js";
import StepEditorPanel from "../components/StepEditorPanel.js";
import type { StepPatch } from "../components/StepEditorPanel.js";
import { validatePastedLocator } from "../components/pick-locator.js";
import StepGraph from "../components/StepGraph.js";
import TestDataEditor from "../components/TestDataEditor.js";
import RecordOptionsPanel from "./case-detail/RecordOptionsPanel.js";
import RunControls from "./case-detail/RunControls.js";
import StepTable from "./case-detail/StepTable.js";
import { useCaseRun } from "./case-detail/use-case-run.js";
import { useRecordOptions } from "./case-detail/use-record-options.js";

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
  const [preview, setPreview] = useState<{
    steps: TestStep[];
    unsupported: RecorderUnsupported[];
    raw: string;
  } | null>(null);
  const [pasteLocator, setPasteLocator] = useState("");

  // Keep the loaded case in sync when a URL save lands. Stable identity: the
  // record-options hook depends on it, and an unstable one would restart the
  // URL debounce on every render.
  const handleCaseSaved = useCallback((updated: TestCase): void => {
    setDetail((prev) => (prev === null ? prev : { ...prev, case: updated }));
  }, []);

  const recordOptions = useRecordOptions({
    caseId,
    loadedCase: detail?.case ?? null,
    onError: setError,
    onCaseSaved: handleCaseSaved,
  });
  const run = useCaseRun(caseId, { onError: setError, onNotice: setNotice });
  const { profileForm, patchProfile, saveProfileNow, caseUrl, setCaseUrl, flushCaseUrl } =
    recordOptions;

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
        setError(formatApiError(err));
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
        setError(formatApiError(err));
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
        setError(formatApiError(err));
        setBusy(false);
      });
  };

  const steps = detail?.steps ?? [];
  const selected = steps.find((s) => s.id === selectedId) ?? null;

  const statusByStepId = useMemo<Record<string, StepStatus>>(() => {
    const map: Record<string, StepStatus> = {};
    for (const step of steps) {
      const status = run.statusByOrder[step.order];
      if (status !== undefined) {
        map[step.id] = status;
      }
    }
    return map;
  }, [steps, run.statusByOrder]);

  const addStep = (): void => {
    mutate(api.upsertStep(caseId, { order: steps.length, action: newAction }), "Step added.");
  };

  const addLocatorStep = (): void => {
    const validated = validatePastedLocator(pasteLocator);
    if (!validated.ok) {
      setError(validated.error);
      return;
    }
    setPasteLocator("");
    mutate(
      api.upsertStep(caseId, {
        order: steps.length,
        action: "click",
        selector: validated.selector,
      }),
      "Locator step added (click — change the action in the editor if needed).",
    );
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
    setBusy(true);
    setError(null);
    // Persist the form before codegen launches so the recording environment is
    // exactly what is shown (M14) — main resolves baseUrl + the case profile.
    saveProfileNow()
      .then(() => flushCaseUrl())
      .then(() => api.startRecorder(caseId))
      .then(() => {
        setRecording(true);
        setNotice("Recording… interact with the codegen browser window, then Stop + import.");
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
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
        setError(formatApiError(err));
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
        setError(formatApiError(err));
        setBusy(false);
      });
  };

  const exportCaseFile = (): void => {
    setBusy(true);
    setError(null);
    setNotice(null);
    api
      .exportCase(caseId)
      .then((outcome) => {
        if (outcome.saved) {
          setNotice(`Case exported${outcome.path !== undefined ? ` to ${outcome.path}` : ""}.`);
        }
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const { activeRun, failedOrder, runFinished, paused } = run;

  const runBadge = paused ? (
    <span className="pt-badge pt-badge-warn">Paused</span>
  ) : activeRun !== null ? (
    <span className="pt-badge pt-badge-run">
      <span className="pt-badge-dot" aria-hidden="true" />
      Running · {activeRun.mode}
    </span>
  ) : runFinished !== null ? (
    <span className="pt-badge pt-badge-pass">{runFinished}</span>
  ) : (
    <span className="pt-badge pt-badge-mute">Idle</span>
  );

  return (
    <section aria-label="Case workflow" className="pt-page">
      <div className="pt-topbar">
        <button type="button" className="pt-btn pt-btn-sm" onClick={onBack}>
          ← Back to suites
        </button>
        <h2>{detail === null ? "Loading case…" : detail.case.name}</h2>
        {detail !== null && steps.length > 0 && (
          <span className="pt-badge">{steps.length} steps</span>
        )}
        {runBadge}
        <span className="pt-spacer" />
        <button
          type="button"
          className="pt-btn pt-btn-ghost pt-btn-sm"
          onClick={exportCaseFile}
          disabled={busy}
          title="Export this case (steps, test data) to a .playtest.json file"
        >
          Export case
        </button>
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
            <div className="pt-row pt-mb-12">
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
            <StepTable
              steps={steps}
              selectedId={selectedId}
              dragId={dragId}
              busy={busy}
              statusByStepId={statusByStepId}
              onSelect={setSelectedId}
              onDragStart={setDragId}
              onDrop={dropReorder}
              onMove={moveStep}
            />
          </div>

          <div className="pt-card">
            <div className="pt-section-head">
              <h3>Add step from picked locator</h3>
            </div>
            <p className="pt-hint pt-mb-10">
              In the codegen window: Record → Stop, then Pick Locator → Copy — paste below to insert
              a click step. Plain CSS works too; anything else (e.g. page.evaluate) is rejected with
              edit guidance and no step is created.
            </p>
            <div className="pt-row">
              <input
                aria-label="Pasted locator"
                className="pt-input pt-mono"
                placeholder="e.g. getByRole('button', { name: 'File' })"
                value={pasteLocator}
                disabled={busy}
                onChange={(e) => {
                  setPasteLocator(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addLocatorStep();
                  }
                }}
              />
              <button
                type="button"
                className="pt-btn pt-btn-sm"
                onClick={addLocatorStep}
                disabled={busy || pasteLocator.trim() === ""}
              >
                Add locator step
              </button>
            </div>
          </div>

          <div className="pt-card">
            <div className="pt-section-head">
              <h3>Test data</h3>
            </div>
            <p className="pt-hint pt-mb-10">
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
              {recording && <span className="pt-badge pt-badge-run">recording</span>}
            </div>
            <div className="pt-row">
              <label className="pt-label-inline">
                Case URL
                <input
                  aria-label="Case URL"
                  className="pt-input pt-mono pt-w-280"
                  placeholder="https://… (defaults to project base URL)"
                  value={caseUrl}
                  disabled={busy || recording}
                  onChange={(e) => {
                    setCaseUrl(e.target.value);
                  }}
                  title="URL the recorder starts from; leave empty to use the project base URL"
                />
              </label>
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
              <RunControls
                activeRun={activeRun}
                paused={paused}
                failedOrder={failedOrder}
                runBusy={run.runBusy}
                busy={busy}
                recording={recording}
                hasSteps={steps.length > 0}
                runSpeedMs={run.runSpeedMs}
                onSpeedChange={run.setRunSpeedMs}
                onStart={run.startRun}
                onResume={run.resumeRun}
                onCancel={run.cancelRun}
                onFullRerun={run.fullRerun}
              />
            </div>
            <p className="pt-hint pt-mt-12">
              Recording starts from the Case URL; when it is empty the project base URL is used
              (recording fails only if both are empty).
            </p>
            {runFinished !== null && (
              <p role="status" className="pt-alert pt-alert-info pt-mt-12">
                {runFinished}
              </p>
            )}
            <RecordOptionsPanel
              form={profileForm}
              busy={busy}
              recording={recording}
              onPatch={patchProfile}
            />
          </div>
          {run.runLogs.length > 0 && (
            <details className="pt-panel">
              <summary>Run log ({run.runLogs.length})</summary>
              <pre className="pt-runlog">{run.runLogs.join("\n")}</pre>
            </details>
          )}
          {preview !== null && (
            <RecorderImportPreview
              steps={preview.steps}
              unsupported={preview.unsupported}
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
