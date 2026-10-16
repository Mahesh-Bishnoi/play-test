import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "../api.js";
import type { Suite, TestCase } from "../../shared/schema.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Props {
  projectId: string;
  activeSuiteId: string | null;
  activeCaseId: string | null;
  onSelectSuite: (suiteId: string | null) => void;
  onSelectCase: (caseId: string) => void;
  /** Bumped by the parent to force a reload (after suite/case CRUD in main). */
  refreshToken: number;
  /** Notify the parent (main column) to reload after sidebar CRUD. */
  onChanged?: () => void;
}

/**
 * IntelliJ "Project" tool window: Test Suites with nested Test Cases.
 * Creation lives here: inline suite form in the header, per-suite
 * "Add case" rows (create + auto-assign in one step), and a project-level
 * "+ New test case" fallback in the footer. The main column stays focused
 * on membership, runs, and editing — it never hosts create forms.
 */
export default function ProjectExplorer({
  projectId,
  activeSuiteId,
  activeCaseId,
  onSelectSuite,
  onSelectCase,
  refreshToken,
  onChanged,
}: Props): React.JSX.Element {
  const [suites, setSuites] = useState<Suite[]>([]);
  const [cases, setCases] = useState<TestCase[]>([]);
  const [membersBySuite, setMembersBySuite] = useState<Record<string, string[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showSuiteCreate, setShowSuiteCreate] = useState(false);
  const [newSuiteName, setNewSuiteName] = useState("");
  const [suiteBusy, setSuiteBusy] = useState(false);
  const [addingCaseSuiteId, setAddingCaseSuiteId] = useState<string | null>(null);
  const [newCaseName, setNewCaseName] = useState("");
  const [caseBusy, setCaseBusy] = useState(false);
  const [showGlobalCaseCreate, setShowGlobalCaseCreate] = useState(false);

  const reload = useCallback(() => {
    setError(null);
    api
      .listSuites(projectId)
      .then((rows) => {
        const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));
        setSuites(sorted);
        setExpanded((prev) => {
          if (prev.size > 0) {
            return prev;
          }
          return new Set(sorted.map((s) => s.id));
        });
        return Promise.all(
          sorted.map((s) =>
            api
              .getSuiteDetail(s.id)
              .then((detail) => ({ id: s.id, caseIds: detail.caseIds }))
              .catch(() => ({ id: s.id, caseIds: [] as string[] })),
          ),
        );
      })
      .then((memberships) => {
        const map: Record<string, string[]> = {};
        for (const m of memberships) {
          map[m.id] = m.caseIds;
        }
        setMembersBySuite(map);
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

  useEffect(() => {
    reload();
  }, [reload, refreshToken]);

  const caseById = useMemo(() => new Map(cases.map((c) => [c.id, c])), [cases]);

  const q = search.trim().toLowerCase();
  const visibleSuites = q === "" ? suites : suites.filter((s) => s.name.toLowerCase().includes(q));
  const matchingCaseIds = useMemo(() => {
    if (q === "") {
      return null;
    }
    return new Set(cases.filter((c) => c.name.toLowerCase().includes(q)).map((c) => c.id));
  }, [cases, q]);

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const submitSuite = (): void => {
    const trimmed = newSuiteName.trim();
    if (trimmed === "" || suiteBusy) {
      return;
    }
    setSuiteBusy(true);
    setError(null);
    api
      .createSuite(projectId, trimmed)
      .then((created) => {
        setNewSuiteName("");
        setShowSuiteCreate(false);
        setExpanded((prev) => new Set(prev).add(created.id));
        reload();
        onSelectSuite(created.id);
        onChanged?.();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setSuiteBusy(false);
      });
  };

  const submitCase = (suiteId: string | null): void => {
    const trimmed = newCaseName.trim();
    if (trimmed === "" || caseBusy) {
      return;
    }
    setCaseBusy(true);
    setError(null);
    api
      .createCase(projectId, trimmed)
      .then((created) => {
        const assign =
          suiteId === null
            ? Promise.resolve()
            : api
                .getSuiteDetail(suiteId)
                .then((detail) => api.setSuiteCases(suiteId, [...detail.caseIds, created.id]))
                .then(() => undefined);
        return assign.then(() => created);
      })
      .then((created) => {
        setNewCaseName("");
        setAddingCaseSuiteId(null);
        setShowGlobalCaseCreate(false);
        if (suiteId !== null) {
          setExpanded((prev) => new Set(prev).add(suiteId));
        }
        reload();
        onSelectCase(created.id);
        onChanged?.();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setCaseBusy(false);
      });
  };

  const cancelForms = (): void => {
    setShowSuiteCreate(false);
    setNewSuiteName("");
    setAddingCaseSuiteId(null);
    setNewCaseName("");
    setShowGlobalCaseCreate(false);
  };

  const caseForm = (suiteId: string | null, label: string): React.JSX.Element => (
    <div className="pt-inline-form">
      <input
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- intentional: inline create flow focuses the new input
        autoFocus
        aria-label={label}
        className="pt-input pt-input-sm"
        placeholder="New case name"
        value={newCaseName}
        disabled={caseBusy}
        onChange={(e) => {
          setNewCaseName(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            submitCase(suiteId);
          } else if (e.key === "Escape") {
            cancelForms();
          }
        }}
      />
      <div className="pt-inline-actions">
        <button
          type="button"
          className="pt-btn pt-btn-primary pt-btn-sm"
          onClick={() => {
            submitCase(suiteId);
          }}
          disabled={caseBusy || newCaseName.trim() === ""}
        >
          {caseBusy ? "Adding…" : suiteId === null ? "Create case" : "Add to suite"}
        </button>
        <button
          type="button"
          className="pt-btn pt-btn-ghost pt-btn-sm"
          onClick={cancelForms}
          disabled={caseBusy}
        >
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <div className="pt-explorer">
      <div className="pt-explorer-head">
        <span className="pt-side-label">Test suites</span>
        <span className="pt-spacer" />
        <button
          type="button"
          className="pt-btn pt-btn-ghost pt-btn-sm"
          title={showSuiteCreate ? "Close new suite form" : "New test suite"}
          aria-label={showSuiteCreate ? "Close new suite form" : "New test suite"}
          aria-expanded={showSuiteCreate}
          onClick={() => {
            cancelForms();
            setShowSuiteCreate((v) => !v);
          }}
        >
          {showSuiteCreate ? "−" : "+"}
        </button>
      </div>
      {showSuiteCreate && (
        <div className="pt-inline-form">
          <input
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- intentional: inline create flow focuses the new input
            autoFocus
            aria-label="New suite name"
            className="pt-input pt-input-sm"
            placeholder="New suite name"
            value={newSuiteName}
            disabled={suiteBusy}
            onChange={(e) => {
              setNewSuiteName(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                submitSuite();
              } else if (e.key === "Escape") {
                cancelForms();
              }
            }}
          />
          <div className="pt-inline-actions">
            <button
              type="button"
              className="pt-btn pt-btn-primary pt-btn-sm"
              onClick={submitSuite}
              disabled={suiteBusy || newSuiteName.trim() === ""}
            >
              {suiteBusy ? "Creating…" : "Create suite"}
            </button>
            <button
              type="button"
              className="pt-btn pt-btn-ghost pt-btn-sm"
              onClick={cancelForms}
              disabled={suiteBusy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <input
        aria-label="Search suites and cases"
        className="pt-input pt-explorer-search"
        placeholder="Search"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
        }}
      />
      {error !== null && (
        <p role="alert" className="pt-alert pt-alert-error">
          {error}
        </p>
      )}
      <div className="pt-tree-scroll" role="tree" aria-label="Test suites and cases">
        {visibleSuites.length === 0 && (
          <p className="pt-hint">
            {suites.length === 0 ? "No suites yet — press + above." : "No suites match."}
          </p>
        )}
        {visibleSuites.map((suite) => {
          const memberIds = membersBySuite[suite.id] ?? [];
          const members = memberIds
            .map((id) => caseById.get(id))
            .filter((c): c is TestCase => c !== undefined)
            .filter((c) => matchingCaseIds === null || matchingCaseIds.has(c.id));
          const isOpen = expanded.has(suite.id);
          const isActive = activeSuiteId === suite.id && activeCaseId === null;
          const isAddingHere = addingCaseSuiteId === suite.id;
          return (
            <div key={suite.id} className="pt-tree-group">
              <div className={`pt-tree-row-wrap${isActive ? " pt-tree-row-active" : ""}`}>
                <button
                  type="button"
                  className="pt-tree-caret"
                  aria-label={
                    isOpen ? `Collapse suite ${suite.name}` : `Expand suite ${suite.name}`
                  }
                  aria-expanded={isOpen}
                  onClick={() => {
                    toggle(suite.id);
                  }}
                >
                  {isOpen ? "▾" : "▸"}
                </button>
                <button
                  type="button"
                  role="treeitem"
                  aria-expanded={isOpen}
                  aria-selected={isActive}
                  className="pt-tree-row"
                  onClick={() => {
                    onSelectSuite(suite.id);
                  }}
                  title={suite.name}
                >
                  <span className="pt-tree-icon" aria-hidden="true">
                    ▤
                  </span>
                  <span className="pt-tree-label">
                    <span className="pt-item-name">{suite.name}</span>
                    <span className="pt-item-meta">
                      {memberIds.length} case{memberIds.length === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
              </div>
              {isOpen && (
                <ul className="pt-tree-children">
                  {members.length === 0 && !isAddingHere ? (
                    <li className="pt-hint pt-tree-empty">No cases in this suite.</li>
                  ) : (
                    members.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          role="treeitem"
                          aria-selected={activeCaseId === c.id}
                          className={`pt-tree-row pt-tree-row-nested${activeCaseId === c.id ? " pt-tree-row-active" : ""}`}
                          onClick={() => {
                            onSelectCase(c.id);
                          }}
                          title={c.name}
                        >
                          <span className="pt-tree-icon" aria-hidden="true">
                            ◦
                          </span>
                          <span className="pt-tree-label">
                            <span className="pt-item-name">{c.name}</span>
                          </span>
                        </button>
                      </li>
                    ))
                  )}
                  <li>
                    {isAddingHere ? (
                      caseForm(suite.id, `New case name in ${suite.name}`)
                    ) : (
                      <button
                        type="button"
                        className="pt-add-row"
                        aria-label={`Add test case to ${suite.name}`}
                        onClick={() => {
                          cancelForms();
                          setAddingCaseSuiteId(suite.id);
                          setNewCaseName("");
                        }}
                      >
                        + Add case
                      </button>
                    )}
                  </li>
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <div className="pt-explorer-foot">
        {showGlobalCaseCreate ? (
          caseForm(null, "New test case name")
        ) : (
          <button
            type="button"
            className="pt-btn pt-btn-ghost pt-btn-sm"
            aria-expanded={false}
            onClick={() => {
              cancelForms();
              setShowGlobalCaseCreate(true);
              setNewCaseName("");
            }}
          >
            + New test case
          </button>
        )}
        <span className="pt-hint">
          {suites.length} suite{suites.length === 1 ? "" : "s"} · {cases.length} case
          {cases.length === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}
