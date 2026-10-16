import { useEffect, useState } from "react";

import { api } from "./api.js";
import { applyTheme, getInitialTheme, type AppTheme } from "./theme.js";
import type { Project } from "../shared/schema.js";
import BrowserBanner from "./components/BrowserBanner.js";
import ProjectExplorer from "./components/ProjectExplorer.js";
import WelcomeScreen from "./components/WelcomeScreen.js";
import CaseDetailPage from "./pages/CaseDetailPage.js";
import RunReportPage from "./pages/RunReportPage.js";
import SuiteDetailPage from "./pages/SuiteDetailPage.js";

interface OpenCaseTab {
  id: string;
  name: string | null;
}

type ActiveTab = { kind: "suites" } | { kind: "case"; caseId: string } | { kind: "report" };

const LAST_PROJECT_KEY = "playtest.lastProjectId";

/**
 * IntelliJ-style shell: Welcome screen first, then a Project window with
 * a suite/case explorer on the left and an editor tab strip. Multiple test
 * cases stay open at once — clicking a case opens (or activates) its tab,
 * the × closes only that tab, and background tabs keep their editor/run
 * state mounted while hidden.
 * File → Close Project returns to Welcome without deleting anything.
 */
export default function App(): React.JSX.Element {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [activeSuiteId, setActiveSuiteId] = useState<string | null>(null);
  const [openCases, setOpenCases] = useState<OpenCaseTab[]>([]);
  const [reportRunId, setReportRunId] = useState<string | null>(null);
  const [active, setActive] = useState<ActiveTab>({ kind: "suites" });
  const [explorerToken, setExplorerToken] = useState(0);
  const [mainToken, setMainToken] = useState(0);
  const [theme, setTheme] = useState<AppTheme>(() => getInitialTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggleTheme = (): void => {
    setTheme((t) => (t === "intellij-dark" ? "syntax-light" : "intellij-dark"));
  };

  const openProject = (id: string): void => {
    setProjectId(id);
    setProject(null);
    setActiveSuiteId(null);
    setOpenCases([]);
    setReportRunId(null);
    setActive({ kind: "suites" });
    try {
      window.localStorage.setItem(LAST_PROJECT_KEY, id);
    } catch {
      // Private mode / storage blocked: last-project restore is best-effort.
    }
    api
      .listProjects()
      .then((rows) => {
        setProject(rows.find((p) => p.id === id) ?? null);
      })
      .catch(() => {
        setProject(null);
      });
  };

  useEffect(() => {
    let last: string | null = null;
    try {
      last = window.localStorage.getItem(LAST_PROJECT_KEY);
    } catch {
      last = null;
    }
    if (last !== null) {
      // Warm the project name so the title bar never flashes empty; the
      // Welcome screen still stays up until the user opens a project.
      api
        .listProjects()
        .then((rows) => {
          const found = rows.find((p) => p.id === last);
          if (found !== undefined) {
            setProject(found);
          }
        })
        .catch(() => undefined);
    }
  }, []);

  const closeProject = (): void => {
    setProjectId(null);
    setProject(null);
    setActiveSuiteId(null);
    setOpenCases([]);
    setReportRunId(null);
    setActive({ kind: "suites" });
    try {
      window.localStorage.removeItem(LAST_PROJECT_KEY);
    } catch {
      // Best-effort only.
    }
  };

  const bumpExplorer = (): void => {
    setExplorerToken((v) => v + 1);
  };

  const bumpMain = (): void => {
    setMainToken((v) => v + 1);
  };

  if (projectId === null) {
    return (
      <div className="pt-app">
        <BrowserBanner />
        <div className="pt-row" style={{ justifyContent: "flex-end", padding: "10px 16px 0" }}>
          <button
            type="button"
            className="pt-btn pt-btn-ghost pt-btn-sm"
            onClick={toggleTheme}
            aria-pressed={theme === "syntax-light"}
            title="Switch between IntelliJ dark and Syntax light"
          >
            {theme === "intellij-dark" ? "☀ Syntax light" : "◐ IntelliJ dark"}
          </button>
        </div>
        <WelcomeScreen onOpen={openProject} />
      </div>
    );
  }

  const activeCaseId = active.kind === "case" ? active.caseId : null;

  const openCase = (caseId: string, name?: string): void => {
    setOpenCases((prev) => {
      const existing = prev.find((t) => t.id === caseId);
      if (existing !== undefined) {
        if (name !== undefined && name !== existing.name) {
          return prev.map((t) => (t.id === caseId ? { ...t, name } : t));
        }
        return prev;
      }
      return [...prev, { id: caseId, name: name ?? null }];
    });
    if (name === undefined) {
      api
        .getCaseDetail(caseId)
        .then((detail) => {
          setOpenCases((prev) =>
            prev.map((t) => (t.id === caseId ? { ...t, name: detail.case.name } : t)),
          );
        })
        .catch(() => {
          // Tab keeps its fallback title; the editor surface shows the error.
        });
    }
    setActive({ kind: "case", caseId });
  };

  const closeCase = (caseId: string): void => {
    const index = openCases.findIndex((t) => t.id === caseId);
    const remaining = openCases.filter((t) => t.id !== caseId);
    setOpenCases(remaining);
    setActive((prev) => {
      if (!(prev.kind === "case" && prev.caseId === caseId)) {
        return prev;
      }
      // IntelliJ-style: closing the active tab activates a neighbor —
      // prefer the tab to the left, else the next one, else suites.
      if (index > 0) {
        const left = openCases[index - 1];
        if (left !== undefined) {
          return { kind: "case", caseId: left.id };
        }
      }
      const right = openCases[index + 1];
      if (right !== undefined && remaining.some((t) => t.id === right.id)) {
        return { kind: "case", caseId: right.id };
      }
      if (remaining.length > 0) {
        const fallback = remaining[0];
        if (fallback !== undefined) {
          return { kind: "case", caseId: fallback.id };
        }
      }
      return { kind: "suites" };
    });
  };

  const viewReport = (suiteRunId: string): void => {
    setReportRunId(suiteRunId);
    setActive({ kind: "report" });
  };

  const closeReport = (): void => {
    setReportRunId(null);
    const fallback = openCases[openCases.length - 1];
    setActive(fallback !== undefined ? { kind: "case", caseId: fallback.id } : { kind: "suites" });
  };

  const closeCaseTab = (caseId: string, e: React.SyntheticEvent): void => {
    e.stopPropagation();
    closeCase(caseId);
  };

  const closeCaseKey = (caseId: string, e: React.KeyboardEvent): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.stopPropagation();
      closeCase(caseId);
    }
  };

  const activeCaseIsOpen = active.kind !== "case" || openCases.some((t) => t.id === active.caseId);

  return (
    <div className="pt-app">
      <div className="pt-menubar" role="menubar" aria-label="Main menu">
        <span className="pt-menubar-app">PlayTest</span>
        <span className="pt-menubar-project" title={project?.baseUrl ?? project?.name ?? projectId}>
          {project?.name ?? "Loading project…"}
        </span>
        <span className="pt-spacer" />
        <button
          type="button"
          className="pt-btn pt-btn-ghost pt-btn-sm"
          onClick={toggleTheme}
          aria-pressed={theme === "syntax-light"}
          title="Switch between IntelliJ dark and Syntax light"
        >
          {theme === "intellij-dark" ? "☀ Syntax light" : "◐ IntelliJ dark"}
        </button>
        <button type="button" className="pt-btn pt-btn-ghost pt-btn-sm" onClick={closeProject}>
          Close Project
        </button>
      </div>
      <div className="pt-ide">
        <aside className="pt-sidebar" aria-label="Project tool window">
          <ProjectExplorer
            projectId={projectId}
            activeSuiteId={activeSuiteId}
            activeCaseId={activeCaseId}
            refreshToken={explorerToken}
            onSelectSuite={(id) => {
              setActiveSuiteId(id);
              setActive({ kind: "suites" });
            }}
            onSelectCase={(id, name) => {
              openCase(id, name);
            }}
            onChanged={bumpMain}
          />
        </aside>
        <div className="pt-editor-col">
          <BrowserBanner />
          <div className="pt-tabs" role="tablist" aria-label="Editor tabs">
            <button
              type="button"
              role="tab"
              aria-selected={active.kind === "suites"}
              className={`pt-tab${active.kind === "suites" ? " pt-tab-active" : ""}`}
              onClick={() => {
                setActive({ kind: "suites" });
              }}
            >
              Suites
            </button>
            {openCases.map((tab) => (
              <div
                key={tab.id}
                role="tab"
                aria-selected={active.kind === "case" && active.caseId === tab.id}
                tabIndex={0}
                className={`pt-tab${active.kind === "case" && active.caseId === tab.id ? " pt-tab-active" : ""}`}
                onClick={() => {
                  setActive({ kind: "case", caseId: tab.id });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActive({ kind: "case", caseId: tab.id });
                  }
                }}
                title={tab.name ?? tab.id}
              >
                {tab.name ?? "Test case"}
                <button
                  type="button"
                  aria-label={`Close ${tab.name ?? "case"} tab`}
                  className="pt-tab-x"
                  onClick={(e) => {
                    closeCaseTab(tab.id, e);
                  }}
                  onKeyDown={(e) => {
                    closeCaseKey(tab.id, e);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            {reportRunId !== null && (
              <div
                role="tab"
                aria-selected={active.kind === "report"}
                tabIndex={0}
                className={`pt-tab${active.kind === "report" ? " pt-tab-active" : ""}`}
                onClick={() => {
                  setActive({ kind: "report" });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActive({ kind: "report" });
                  }
                }}
                title={reportRunId}
              >
                Report
                <button
                  type="button"
                  aria-label="Close report tab"
                  className="pt-tab-x"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeReport();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.stopPropagation();
                      closeReport();
                    }
                  }}
                >
                  ×
                </button>
              </div>
            )}
          </div>
          <main className="pt-main">
            {active.kind === "report" && reportRunId !== null && (
              <RunReportPage
                suiteRunId={reportRunId}
                onBack={closeReport}
                onRerun={(nextId) => {
                  setReportRunId(nextId);
                }}
              />
            )}
            {/* Background case tabs stay mounted (hidden) so editor
                selection and live run status survive tab switches. */}
            {openCases.map((tab) => (
              <div key={tab.id} hidden={!(active.kind === "case" && active.caseId === tab.id)}>
                <CaseDetailPage
                  caseId={tab.id}
                  onBack={() => {
                    setActive({ kind: "suites" });
                  }}
                />
              </div>
            ))}
            {(active.kind === "suites" || !activeCaseIsOpen) && (
              <SuiteDetailPage
                projectId={projectId}
                focusedSuiteId={activeSuiteId}
                refreshToken={mainToken}
                onSuiteFocus={setActiveSuiteId}
                onChanged={bumpExplorer}
                onOpenCase={(id, name) => {
                  openCase(id, name);
                }}
                onCaseDeleted={(id) => {
                  closeCase(id);
                }}
                onViewReport={viewReport}
              />
            )}
            <p className="pt-hint pt-statusbar">
              {project?.name ?? projectId} · Local-first SQLite · artifacts in ~/PlayTestData
            </p>
          </main>
        </div>
      </div>
    </div>
  );
}
