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
  onNewSuite: () => void;
  onNewCase: () => void;
  /** Bumped by the parent to force a reload (after suite/case CRUD). */
  refreshToken: number;
}

/**
 * IntelliJ "Project" tool window: Test Suites with nested Test Cases.
 * Navigation only — CRUD stays in the editor pages; the +/- buttons there
 * just focus the matching create form via the editor tabs.
 */
export default function ProjectExplorer({
  projectId,
  activeSuiteId,
  activeCaseId,
  onSelectSuite,
  onSelectCase,
  onNewSuite,
  onNewCase,
  refreshToken,
}: Props): React.JSX.Element {
  const [suites, setSuites] = useState<Suite[]>([]);
  const [cases, setCases] = useState<TestCase[]>([]);
  const [membersBySuite, setMembersBySuite] = useState<Record<string, string[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="pt-explorer">
      <div className="pt-explorer-head">
        <span className="pt-side-label">Project</span>
        <span className="pt-spacer" />
        <button
          type="button"
          className="pt-btn pt-btn-ghost pt-btn-sm"
          title="New test suite"
          aria-label="New test suite"
          onClick={onNewSuite}
        >
          +
        </button>
      </div>
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
        {visibleSuites.length === 0 && <p className="pt-hint">No suites match.</p>}
        {visibleSuites.map((suite) => {
          const memberIds = membersBySuite[suite.id] ?? [];
          const members = memberIds
            .map((id) => caseById.get(id))
            .filter((c): c is TestCase => c !== undefined)
            .filter((c) => matchingCaseIds === null || matchingCaseIds.has(c.id));
          const isOpen = expanded.has(suite.id);
          const isActive = activeSuiteId === suite.id && activeCaseId === null;
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
                  {members.length === 0 ? (
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
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <div className="pt-explorer-foot">
        <button type="button" className="pt-btn pt-btn-ghost pt-btn-sm" onClick={onNewCase}>
          + New test case
        </button>
        <span className="pt-hint">
          {suites.length} suite{suites.length === 1 ? "" : "s"} · {cases.length} case
          {cases.length === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}
