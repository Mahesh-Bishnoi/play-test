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
  onOpenCase?: (caseId: string) => void;
  /** WS6 hook: open a suite-run report (RunReportPage). */
  onViewReport?: (suiteRunId: string) => void;
}

/**
 * Suite detail (UI overhaul): select targets read as selection, deletes are
 * danger-ghosts behind confirms, create forms hide behind disclosures, and
 * the pre-run confirm is a real modal.
 */
export default function SuiteDetailPage({
  projectId,
  onOpenCase,
  onViewReport,
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
  const [showSuiteCreate, setShowSuiteCreate] = useState(false);
  const [showCaseCreate, setShowCaseCreate] = useState(false);
  const [newSuiteName, setNewSuiteName] = useState("");
  const [newCaseName, setNewCaseName] = useState("");
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
    if (id !== null) {
      loadMembership(id);
    } else {
      setMemberIds([]);
      setChecked(new Set());
      setDirty(false);
    }
  };

  const createSuite = (): void => {
    const trimmed = newSuiteName.trim();
    if (trimmed === "") {
      return;
    }
    api
      .createSuite(projectId, trimmed)
      .then((created) => {
        setSuites((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
        setNewSuiteName("");
        setShowSuiteCreate(false);
        selectSuite(created.id);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
  };

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
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setDeleteBusy(false);
      });
  };

  const createCase = (): void => {
    const trimmed = newCaseName.trim();
    if (trimmed === "") {
      return;
    }
    api
      .createCase(projectId, trimmed)
      .then((created) => {
        setCases((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
        setNewCaseName("");
        setShowCaseCreate(false);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
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
          <span className="pt-spacer" />
          <button
            type="button"
            className="pt-btn pt-btn-sm"
            aria-expanded={showSuiteCreate}
            onClick={() => {
              setShowSuiteCreate((v) => !v);
            }}
          >
            {showSuiteCreate ? "− Close" : "+ New suite"}
          </button>
        </div>
        {showSuiteCreate && (
          <div className="pt-row" style={{ marginBottom: 12 }}>
            <input
              aria-label="New suite name"
              className="pt-input"
              value={newSuiteName}
              onChange={(e) => {
                setNewSuiteName(e.target.value);
              }}
              placeholder="New suite name"
              style={{ maxInlineSize: 280 }}
            />
            <button
              type="button"
              className="pt-btn pt-btn-primary pt-btn-sm"
              onClick={createSuite}
              disabled={newSuiteName.trim() === ""}
            >
              Create suite
            </button>
          </div>
        )}
        {suites.length === 0 && !showSuiteCreate ? (
          <p className="pt-empty">No suites yet — press “+ New suite”.</p>
        ) : (
          suites.length > 0 && (
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
          )
        )}
      </div>

      <div className="pt-card">
        <div className="pt-section-head">
          <h3 className="pt-toolbar-title">Cases</h3>
          <span className="pt-count">{cases.length} in project</span>
          <span className="pt-spacer" />
          <button
            type="button"
            className="pt-btn pt-btn-sm"
            aria-expanded={showCaseCreate}
            onClick={() => {
              setShowCaseCreate((v) => !v);
            }}
          >
            {showCaseCreate ? "− Close" : "+ New case"}
          </button>
        </div>
        {showCaseCreate && (
          <div className="pt-row" style={{ marginBottom: 4 }}>
            <input
              aria-label="New case name"
              className="pt-input"
              value={newCaseName}
              onChange={(e) => {
                setNewCaseName(e.target.value);
              }}
              placeholder="New case name"
              style={{ maxInlineSize: 280 }}
            />
            <button
              type="button"
              className="pt-btn pt-btn-primary pt-btn-sm"
              onClick={createCase}
              disabled={newCaseName.trim() === ""}
            >
              Create case
            </button>
          </div>
        )}
        {cases.length === 0 && !showCaseCreate && (
          <p className="pt-empty">No cases yet — press “+ New case”.</p>
        )}
      </div>

      {selectedSuite === null ? (
        <p className="pt-empty">Select a suite to manage its cases.</p>
      ) : (
        <div className="pt-card">
          <div className="pt-section-head">
            <h3 className="pt-toolbar-title">{selectedSuite.name}</h3>
            <span className="pt-count">{memberIds.length} in suite</span>
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
                          allVisibleChecked
                            ? "Deselect all visible cases"
                            : "Select all visible cases"
                        }
                        checked={allVisibleChecked}
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
                          aria-label={`Include case ${c.name}`}
                          checked={checked.has(c.id)}
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
                                onOpenCase(c.id);
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
