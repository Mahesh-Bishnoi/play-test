import { useEffect, useMemo, useState } from "react";

import { api } from "../api.js";
import type { Suite, TestCase } from "../../shared/schema.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function inputStyle(): React.CSSProperties {
  return { padding: "6px 8px", border: "1px solid #ccc", borderRadius: 4, fontSize: 14 };
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
  projectId: string;
  /** WS3 hook: open a case in the workflow editor (CaseDetailPage). */
  onOpenCase?: (caseId: string) => void;
  /** WS6 hook: open a suite-run report (RunReportPage). */
  onViewReport?: (suiteRunId: string) => void;
}

/**
 * M2 suite detail (PLAN §6): suite CRUD, project case CRUD, membership
 * checkboxes with search + select-all/none + save, and an unsupervised-only
 * pre-run confirm dialog. Actual execution lands in WS5 (M5/M6).
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
  const [newSuiteName, setNewSuiteName] = useState("");
  const [newCaseName, setNewCaseName] = useState("");
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [lastSuiteRunId, setLastSuiteRunId] = useState<string | null>(null);

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
        selectSuite(created.id);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
  };

  const deleteSuite = (id: string): void => {
    api
      .deleteSuite(id)
      .then(() => {
        setSuites((prev) => prev.filter((s) => s.id !== id));
        if (suiteId === id) {
          selectSuite(null);
        }
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
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
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
  };

  const deleteCase = (id: string): void => {
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
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
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
      <div>
        <h2>Suites</h2>
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
        <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <input
            aria-label="New suite name"
            value={newSuiteName}
            onChange={(e) => {
              setNewSuiteName(e.target.value);
            }}
            placeholder="New suite name"
            style={inputStyle()}
          />
          <button
            type="button"
            onClick={createSuite}
            disabled={newSuiteName.trim() === ""}
            style={buttonStyle(newSuiteName.trim() === "")}
          >
            Create suite
          </button>
        </div>
        {suites.length === 0 ? (
          <p>No suites yet — create one to start selecting cases.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {suites.map((s) => (
              <li
                key={s.id}
                style={{
                  display: "flex",
                  gap: 4,
                  alignItems: "center",
                  border: suiteId === s.id ? "2px solid #2563eb" : "1px solid #ccc",
                  borderRadius: 6,
                  padding: 4,
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    selectSuite(s.id);
                  }}
                  aria-pressed={suiteId === s.id}
                  style={buttonStyle()}
                >
                  {s.name}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    deleteSuite(s.id);
                  }}
                  aria-label={`Delete suite ${s.name}`}
                  style={buttonStyle()}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h2>Cases</h2>
        <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <input
            aria-label="New case name"
            value={newCaseName}
            onChange={(e) => {
              setNewCaseName(e.target.value);
            }}
            placeholder="New case name"
            style={inputStyle()}
          />
          <button
            type="button"
            onClick={createCase}
            disabled={newCaseName.trim() === ""}
            style={buttonStyle(newCaseName.trim() === "")}
          >
            Create case
          </button>
        </div>
      </div>

      {selectedSuite === null ? (
        <p>Select a suite to manage its cases.</p>
      ) : (
        <div>
          <h3>
            {selectedSuite.name} — cases ({memberIds.length} selected)
            {dirty && <span style={{ color: "#b45309" }}> — unsaved changes</span>}
          </h3>
          <div
            style={{
              display: "flex",
              gap: 8,
              marginBottom: 8,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <input
              aria-label="Search cases"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
              }}
              placeholder="Search cases"
              style={inputStyle()}
            />
            <button type="button" onClick={selectAll} style={buttonStyle()}>
              Select all
            </button>
            <button type="button" onClick={selectNone} style={buttonStyle()}>
              Select none
            </button>
            <button
              type="button"
              onClick={saveSelection}
              disabled={!dirty}
              style={buttonStyle(!dirty)}
            >
              Save selection
            </button>
            <button
              type="button"
              onClick={() => {
                setRunDialogOpen(true);
              }}
              disabled={checked.size === 0}
              style={buttonStyle(checked.size === 0)}
            >
              Run suite…
            </button>
          </div>
          {visibleCases.length === 0 ? (
            <p>
              {cases.length === 0 ? "No cases in this project yet." : "No cases match the search."}
            </p>
          ) : (
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: 4 }}>
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
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: 4 }}>
                    Name
                  </th>
                  <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: 4 }}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleCases.map((c) => (
                  <tr key={c.id}>
                    <td style={{ padding: 4, borderBottom: "1px solid #eee" }}>
                      <input
                        type="checkbox"
                        aria-label={`Include case ${c.name}`}
                        checked={checked.has(c.id)}
                        onChange={() => {
                          toggle(c.id);
                        }}
                      />
                    </td>
                    <td style={{ padding: 4, borderBottom: "1px solid #eee" }}>{c.name}</td>
                    <td style={{ padding: 4, borderBottom: "1px solid #eee" }}>
                      {onOpenCase !== undefined && (
                        <button
                          type="button"
                          onClick={() => {
                            onOpenCase(c.id);
                          }}
                          aria-label={`Open case ${c.name} in workflow editor`}
                          style={buttonStyle()}
                        >
                          Open
                        </button>
                      )}{" "}
                      <button
                        type="button"
                        onClick={() => {
                          deleteCase(c.id);
                        }}
                        style={buttonStyle()}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {runDialogOpen && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Confirm suite run"
              style={{
                border: "2px solid #2563eb",
                borderRadius: 8,
                padding: 16,
                marginTop: 12,
                maxWidth: 560,
              }}
            >
              <h4>Run suite (unsupervised only)</h4>
              <p>
                Suite <strong>{selectedSuite.name}</strong> — {selectedCases.length} case(s):
              </p>
              <ul>
                {selectedCases.map((c) => (
                  <li key={c.id}>{c.name}</li>
                ))}
              </ul>
              <p style={{ color: "#555" }}>
                Headless and parallel, never pauses. Each case runs independently; a failure skips
                only that case&apos;s remaining steps.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={confirmRunSuite}
                  disabled={runBusy}
                  style={buttonStyle(runBusy)}
                >
                  {runBusy ? "Starting…" : `Confirm (${selectedCases.length})`}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRunDialogOpen(false);
                  }}
                  disabled={runBusy}
                  style={buttonStyle(runBusy)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {lastSuiteRunId !== null && onViewReport !== undefined && (
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                onClick={() => {
                  onViewReport(lastSuiteRunId);
                }}
                style={buttonStyle()}
              >
                View last report
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
