import { useEffect, useMemo, useState } from "react";

import { api } from "../api.js";
import type { Suite, TestCase } from "../../shared/schema.js";
import ConfirmDialog from "../components/ConfirmDialog.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Props {
  projectId: string;
  /** WS3 hook: open a case in the workflow editor (CaseDetailPage). */
  onOpenCase?: (caseId: string, name?: string) => void;
  /** IDE shell: prune the editor tab when its case is deleted here. */
  onCaseDeleted?: (caseId: string) => void;
  /** WS6 hook: open a suite-run report (RunReportPage). */
  onViewReport?: (suiteRunId: string) => void;
  /** IDE shell: suite focused in the Project explorer (controlled). */
  focusedSuiteId?: string | null;
  onSuiteFocus?: (suiteId: string | null) => void;
  /** IDE shell: bumped by sidebar CRUD so the main column reloads. */
  refreshToken?: number;
  /** IDE shell: notify the explorer to reload after CRUD. */
  onChanged?: () => void;
}

/**
 * Suite detail: membership + runs. Creation lives in the sidebar
 * (ProjectExplorer) so there is exactly one place to add suites/cases;
 * deletes stay here behind confirms, next to the membership they affect.
 */
export default function SuiteDetailPage({
  projectId,
  onOpenCase,
  onCaseDeleted,
  onViewReport,
  focusedSuiteId,
  onSuiteFocus,
  refreshToken,
  onChanged,
}: Props): React.JSX.Element {
  const [suites, setSuites] = useState<Suite[]>([]);
  const [suiteId, setSuiteId] = useState<string | null>(null);
  const [cases, setCases] = useState<TestCase[]>([]);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [lastSuiteRunId, setLastSuiteRunId] = useState<string | null>(null);
  const [pendingDeleteSuite, setPendingDeleteSuite] = useState<Suite | null>(null);
  const [pendingDeleteCase, setPendingDeleteCase] = useState<TestCase | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    setError(null);
    setNotice(null);
    setSuiteId(null);
    setCases([]);
    setMemberIds([]);
    setChecked(new Set());
    setDirty(false);
    api
      .listSuites(projectId)
      .then((rows) => {
        setSuites([...rows].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
    api
      .listCases(projectId)
      .then((rows) => {
        setCases([...rows].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const loadMembership = (id: string): void => {
    api
      .getSuiteDetail(id)
      .then((detail) => {
        setMemberIds(detail.caseIds);
        setChecked(new Set(detail.caseIds));
        setDirty(false);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
  };

  const selectSuite = (id: string | null): void => {
    setSuiteId(id);
    setNotice(null);
    setRunDialogOpen(false);
    if (onSuiteFocus !== undefined) {
      onSuiteFocus(id);
    }
    if (id !== null) {
      loadMembership(id);
    } else {
      setMemberIds([]);
      setChecked(new Set());
      setDirty(false);
    }
  };

  useEffect(() => {
    if (refreshToken !== undefined && refreshToken > 0) {
      setError(null);
      api
        .listSuites(projectId)
        .then((rows) => {
          const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));
          setSuites(sorted);
          if (suiteId !== null && !sorted.some((s) => s.id === suiteId)) {
            selectSuite(null);
          }
        })
        .catch((err: unknown) => {
          setError(errorMessage(err));
        });
      api
        .listCases(projectId)
        .then((rows) => {
          setCases([...rows].sort((a, b) => a.name.localeCompare(b.name)));
        })
        .catch((err: unknown) => {
          setError(errorMessage(err));
        });
      if (suiteId !== null) {
        loadMembership(suiteId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  // IDE shell: explorer drives the focused suite.
  useEffect(() => {
    if (focusedSuiteId !== undefined && focusedSuiteId !== suiteId) {
      selectSuite(focusedSuiteId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedSuiteId]);

  const confirmDeleteSuite = (): void => {
    if (pendingDeleteSuite === null) {
      return;
    }
    const id = pendingDeleteSuite.id;
    setDeleteBusy(true);
    api
      .deleteSuite(id)
      .then(() => {
        setSuites((prev) => prev.filter((s) => s.id !== id));
        if (suiteId === id) {
          selectSuite(null);
        }
        setPendingDeleteSuite(null);
        onChanged?.();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setDeleteBusy(false);
      });
  };

  const confirmDeleteCase = (): void => {
    if (pendingDeleteCase === null) {
      return;
    }
    const id = pendingDeleteCase.id;
    setDeleteBusy(true);
    api
      .deleteCase(id)
      .then(() => {
        setCases((prev) => prev.filter((c) => c.id !== id));
        setMemberIds((prev) => prev.filter((m) => m !== id));
        setChecked((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setPendingDeleteCase(null);
        onCaseDeleted?.(id);
        onChanged?.();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setDeleteBusy(false);
      });
  };

  const visibleCases = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q === "") {
      return cases;
    }
    return cases.filter((c) => c.name.toLowerCase().includes(q));
  }, [cases, search]);

  const allVisibleChecked = visibleCases.length > 0 && visibleCases.every((c) => checked.has(c.id));

  const toggle = (id: string): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setDirty(true);
  };

  const selectAll = (): void => {
    setChecked((prev) => new Set([...prev, ...visibleCases.map((c) => c.id)]));
    setDirty(true);
  };

  const selectNone = (): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const c of visibleCases) {
        next.delete(c.id);
      }
      return next;
    });
    setDirty(true);
  };

  const saveSelection = (): void => {
    if (suiteId === null) {
      return;
    }
    const ids = [...checked];
    api
      .setSuiteCases(suiteId, ids)
      .then((saved) => {
        setMemberIds(saved);
        setChecked(new Set(saved));
        setDirty(false);
        setNotice(`Saved ${saved.length} case(s) in this suite.`);
        onChanged?.();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
  };

  const selectedSuite = suites.find((s) => s.id === suiteId) ?? null;
  const selectedCases = cases.filter((c) => checked.has(c.id));

  const confirmRunSuite = (): void => {
    if (selectedSuite === null || checked.size === 0) {
      return;
    }
    setRunBusy(true);
    setNotice(null);
    api
      .runSuite(selectedSuite.id, [...checked])
      .then(({ suiteRunId: runId }) => {
        setLastSuiteRunId(runId);
        setRunDialogOpen(false);
        setNotice(`Suite run started (${selectedCases.length} case(s)). Report: ${runId}`);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setRunBusy(false);
      });
  };

  return (
    <section aria-label="Suites and cases" style={{ display: "grid", gap: 16 }}>
      <div className="pt-topbar">
        <h2>Suites &amp; cases</h2>
        <span className="pt-badge">
          <span className="pt-badge-dot" aria-hidden="true" />
          {suites.length} suites
        </span>
        <span className="pt-badge pt-badge-mute">{cases.length} cases</span>
        {selectedSuite !== null && (
          <span className="pt-badge pt-badge-run">{memberIds.length} selected</span>
        )}
        {dirty && <span className="pt-badge pt-badge-fail">unsaved changes</span>}
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

      <div className="pt-card">
        <div className="pt-section-head">
          <h3 className="pt-toolbar-title">Suites</h3>
          <span className="pt-count">{suites.length} in project</span>
        </div>
        {suites.length === 0 ? (
          <p className="pt-empty">No suites yet — press + in the sidebar to create one.</p>
        ) : (
          <div className="pt-suite-pills">
            {suites.map((s) => (
              <span
                key={s.id}
                className={`pt-list-item${suiteId === s.id ? " pt-suite-pill-active" : ""}`}
                style={{ padding: "4px 4px 4px 8px" }}
              >
                <button
                  type="button"
                  className="pt-btn pt-btn-ghost pt-btn-sm"
                  onClick={() => {
                    selectSuite(s.id);
                  }}
                  aria-pressed={suiteId === s.id}
                >
                  {s.name}
                </button>
                <button
                  type="button"
                  className="pt-btn pt-btn-danger-ghost pt-btn-sm"
                  onClick={() => {
                    setPendingDeleteSuite(s);
                  }}
                  title={`Delete suite ${s.name} (asks first)`}
                  aria-label={`Delete suite ${s.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <p className="pt-hint" style={{ marginTop: 8 }}>
          New suites are created from the sidebar + — they appear here for membership and runs.
        </p>
      </div>

      <div className="pt-section-head" style={{ marginBottom: 0 }}>
        <h3 className="pt-toolbar-title">Cases</h3>
        <span className="pt-count">{cases.length} in project</span>
        <span className="pt-spacer" />
        <span className="pt-hint">
          New cases are added from the sidebar (per-suite “+ Add case”).
        </span>
      </div>
      {cases.length === 0 && (
        <p className="pt-empty">No cases yet — use “+ Add case” under a suite in the sidebar.</p>
      )}

      {cases.length > 0 && (
        <div className="pt-card">
          <div className="pt-section-head">
            <h3 className="pt-toolbar-title">
              {selectedSuite === null ? "All cases" : selectedSuite.name}
            </h3>
            {selectedSuite !== null && (
              <span className="pt-count">{memberIds.length} in suite</span>
            )}
          </div>
          <div className="pt-row" style={{ marginBottom: 12 }}>
            <input
              aria-label="Search cases"
              className="pt-input"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
              }}
              placeholder="Search cases"
              style={{ maxInlineSize: 220 }}
            />
            <button type="button" className="pt-btn pt-btn-sm" onClick={selectAll}>
              Select all
            </button>
            <button type="button" className="pt-btn pt-btn-sm" onClick={selectNone}>
              Select none
            </button>
            {selectedSuite === null ? (
              <span className="pt-hint">Select a suite above to build membership.</span>
            ) : (
              <>
                <button
                  type="button"
                  className="pt-btn pt-btn-primary pt-btn-sm"
                  onClick={saveSelection}
                  disabled={!dirty}
                >
                  Save selection
                </button>
                <button
                  type="button"
                  className="pt-btn pt-btn-sm"
                  onClick={() => {
                    setRunDialogOpen(true);
                  }}
                  disabled={checked.size === 0}
                >
                  Run suite…
                </button>
              </>
            )}
          </div>
          {visibleCases.length === 0 ? (
            <p className="pt-empty">
              {cases.length === 0 ? "No cases in this project yet." : "No cases match the search."}
            </p>
          ) : (
            <div className="pt-table-wrap">
              <table className="pt-table">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        aria-label={
                          selectedSuite === null
                            ? "Select a suite above to build membership"
                            : allVisibleChecked
                              ? "Deselect all visible cases"
                              : "Select all visible cases"
                        }
                        title={
                          selectedSuite === null
                            ? "Select a suite above to build membership"
                            : undefined
                        }
                        checked={allVisibleChecked}
                        disabled={selectedSuite === null}
                        onChange={() => {
                          if (allVisibleChecked) {
                            selectNone();
                          } else {
                            selectAll();
                          }
                        }}
                      />
                    </th>
                    <th>Name</th>
                    <th style={{ textAlign: "end" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleCases.map((c) => (
                    <tr key={c.id} className={checked.has(c.id) ? "pt-row-selected" : undefined}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Include case ${c.name} in ${selectedSuite?.name ?? "suite"}`}
                          title={
                            selectedSuite === null
                              ? "Select a suite above to build membership"
                              : `Include case ${c.name} in ${selectedSuite.name}`
                          }
                          checked={checked.has(c.id)}
                          disabled={selectedSuite === null}
                          onChange={() => {
                            toggle(c.id);
                          }}
                        />
                      </td>
                      <td>{c.name}</td>
                      <td style={{ textAlign: "end" }}>
                        <span className="pt-row" style={{ justifyContent: "flex-end" }}>
                          {onOpenCase !== undefined && (
                            <button
                              type="button"
                              className="pt-btn pt-btn-sm"
                              onClick={() => {
                                onOpenCase(c.id, c.name);
                              }}
                              aria-label={`Open case ${c.name} in workflow editor`}
                            >
                              Open
                            </button>
                          )}
                          <button
                            type="button"
                            className="pt-btn pt-btn-danger-ghost pt-btn-sm"
                            title={`Delete case ${c.name} (asks first)`}
                            aria-label={`Delete case ${c.name}`}
                            onClick={() => {
                              setPendingDeleteCase(c);
                            }}
                          >
                            Delete
                          </button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {lastSuiteRunId !== null && onViewReport !== undefined && (
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className="pt-btn pt-btn-sm"
                onClick={() => {
                  onViewReport(lastSuiteRunId);
                }}
              >
                View last report
              </button>
            </div>
          )}
        </div>
      )}

      {runDialogOpen && selectedSuite !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm suite run"
          className="pt-modal-backdrop"
          onClick={() => {
            if (!runBusy) {
              setRunDialogOpen(false);
            }
          }}
        >
          <div
            className="pt-modal pt-confirm"
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <div className="pt-section-head">
              <h3 style={{ margin: 0 }}>Run suite (unsupervised only)</h3>
            </div>
            <p className="pt-sub">
              Suite <strong>{selectedSuite.name}</strong> — {selectedCases.length} case(s)
            </p>
            <ul>
              {selectedCases.map((c) => (
                <li key={c.id}>{c.name}</li>
              ))}
            </ul>
            <p className="pt-hint">
              Headless and parallel, never pauses. Each case runs independently; a failure skips
              only that case&apos;s remaining steps.
            </p>
            <div className="pt-modal-actions">
              <button
                type="button"
                className="pt-btn"
                onClick={() => {
                  setRunDialogOpen(false);
                }}
                disabled={runBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="pt-btn pt-btn-primary"
                onClick={confirmRunSuite}
                disabled={runBusy}
              >
                {runBusy ? "Starting…" : `Confirm (${selectedCases.length})`}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingDeleteSuite !== null && (
        <ConfirmDialog
          title={`Delete suite “${pendingDeleteSuite.name}”?`}
          body="The suite is removed. Its cases stay in the project and can join other suites."
          confirmLabel={`Delete ${pendingDeleteSuite.name}`}
          busy={deleteBusy}
          onConfirm={confirmDeleteSuite}
          onCancel={() => {
            if (!deleteBusy) {
              setPendingDeleteSuite(null);
            }
          }}
        />
      )}
      {pendingDeleteCase !== null && (
        <ConfirmDialog
          title={`Delete case “${pendingDeleteCase.name}”?`}
          body="This permanently deletes the case, its steps and its test data. Suite memberships update automatically. This cannot be undone."
          confirmLabel={`Delete ${pendingDeleteCase.name}`}
          busy={deleteBusy}
          onConfirm={confirmDeleteCase}
          onCancel={() => {
            if (!deleteBusy) {
              setPendingDeleteCase(null);
            }
          }}
        />
      )}
    </section>
  );
}
