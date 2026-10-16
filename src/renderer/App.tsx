import { useEffect, useState } from "react";

import { api } from "./api.js";
import type { Project } from "../shared/schema.js";
import BrowserBanner from "./components/BrowserBanner.js";
import ProjectExplorer from "./components/ProjectExplorer.js";
import WelcomeScreen from "./components/WelcomeScreen.js";
import CaseDetailPage from "./pages/CaseDetailPage.js";
import RunReportPage from "./pages/RunReportPage.js";
import SuiteDetailPage from "./pages/SuiteDetailPage.js";

type EditorTab = "suites" | "case" | "report";

const LAST_PROJECT_KEY = "playtest.lastProjectId";

/**
 * IntelliJ-style shell: Welcome screen first, then a Project window with
 * a suite/case explorer on the left and an editor/report tab strip.
 * File → Close Project returns to Welcome without deleting anything.
 */
export default function App(): React.JSX.Element {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [activeSuiteId, setActiveSuiteId] = useState<string | null>(null);
  const [openCaseId, setOpenCaseId] = useState<string | null>(null);
  const [openCaseName, setOpenCaseName] = useState<string | null>(null);
  const [reportRunId, setReportRunId] = useState<string | null>(null);
  const [tab, setTab] = useState<EditorTab>("suites");
  const [explorerToken, setExplorerToken] = useState(0);
  const [suiteCreateSignal, setSuiteCreateSignal] = useState(0);
  const [caseCreateSignal, setCaseCreateSignal] = useState(0);

  const openProject = (id: string): void => {
    setProjectId(id);
    setProject(null);
    setActiveSuiteId(null);
    setOpenCaseId(null);
    setOpenCaseName(null);
    setReportRunId(null);
    setTab("suites");
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
    setOpenCaseId(null);
    setOpenCaseName(null);
    setReportRunId(null);
    setTab("suites");
    try {
      window.localStorage.removeItem(LAST_PROJECT_KEY);
    } catch {
      // Best-effort only.
    }
  };

  const bumpExplorer = (): void => {
    setExplorerToken((v) => v + 1);
  };

  if (projectId === null) {
    return (
      <div className="pt-app">
        <BrowserBanner />
        <WelcomeScreen onOpen={openProject} />
      </div>
    );
  }

  const openCase = (caseId: string, name?: string): void => {
    setOpenCaseId(caseId);
    if (name !== undefined) {
      setOpenCaseName(name);
    } else {
      api
        .getCaseDetail(caseId)
        .then((detail) => {
          setOpenCaseName(detail.case.name);
        })
        .catch(() => {
          setOpenCaseName(null);
        });
    }
    setReportRunId(null);
    setTab("case");
  };

  const viewReport = (suiteRunId: string): void => {
    setReportRunId(suiteRunId);
    setTab("report");
  };

  return (
    <div className="pt-app">
      <div className="pt-menubar" role="menubar" aria-label="Main menu">
        <span className="pt-menubar-app">PlayTest</span>
        <span className="pt-menubar-project" title={project?.baseUrl ?? project?.name ?? projectId}>
          {project?.name ?? "Loading project…"}
        </span>
        <span className="pt-spacer" />
        <button type="button" className="pt-btn pt-btn-ghost pt-btn-sm" onClick={closeProject}>
          Close Project
        </button>
      </div>
      <div className="pt-ide">
        <aside className="pt-sidebar" aria-label="Project tool window">
          <ProjectExplorer
            projectId={projectId}
            activeSuiteId={activeSuiteId}
            activeCaseId={openCaseId}
            refreshToken={explorerToken}
            onSelectSuite={(id) => {
              setActiveSuiteId(id);
              setOpenCaseId(null);
              setReportRunId(null);
              setTab("suites");
            }}
            onSelectCase={(id) => {
              openCase(id);
            }}
            onNewSuite={() => {
              setTab("suites");
              setSuiteCreateSignal((v) => v + 1);
            }}
            onNewCase={() => {
              setTab("suites");
              setCaseCreateSignal((v) => v + 1);
            }}
          />
        </aside>
        <div className="pt-editor-col">
          <BrowserBanner />
          <div className="pt-tabs" role="tablist" aria-label="Editor tabs">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "suites"}
              className={`pt-tab${tab === "suites" ? " pt-tab-active" : ""}`}
              onClick={() => {
                setTab("suites");
              }}
            >
              Suites
            </button>
            {openCaseId !== null && (
              <button
                type="button"
                role="tab"
                aria-selected={tab === "case"}
                className={`pt-tab${tab === "case" ? " pt-tab-active" : ""}`}
                onClick={() => {
                  setTab("case");
                }}
                title={openCaseId}
              >
                {openCaseName ?? "Test case"}
                <span
                  role="button"
                  aria-label="Close case tab"
                  tabIndex={0}
                  className="pt-tab-x"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenCaseId(null);
                    setOpenCaseName(null);
                    setTab("suites");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.stopPropagation();
                      setOpenCaseId(null);
                      setOpenCaseName(null);
                      setTab("suites");
                    }
                  }}
                >
                  ×
                </span>
              </button>
            )}
            {reportRunId !== null && (
              <button
                type="button"
                role="tab"
                aria-selected={tab === "report"}
                className={`pt-tab${tab === "report" ? " pt-tab-active" : ""}`}
                onClick={() => {
                  setTab("report");
                }}
                title={reportRunId}
              >
                Report
                <span
                  role="button"
                  aria-label="Close report tab"
                  tabIndex={0}
                  className="pt-tab-x"
                  onClick={(e) => {
                    e.stopPropagation();
                    setReportRunId(null);
                    setTab(openCaseId !== null ? "case" : "suites");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.stopPropagation();
                      setReportRunId(null);
                      setTab(openCaseId !== null ? "case" : "suites");
                    }
                  }}
                >
                  ×
                </span>
              </button>
            )}
          </div>
          <main className="pt-main">
            {tab === "report" && reportRunId !== null && (
              <RunReportPage
                suiteRunId={reportRunId}
                onBack={() => {
                  setReportRunId(null);
                  setTab(openCaseId !== null ? "case" : "suites");
                }}
                onRerun={(nextId) => {
                  setReportRunId(nextId);
                }}
              />
            )}
            {tab === "case" && openCaseId !== null && (
              <CaseDetailPage
                caseId={openCaseId}
                onBack={() => {
                  setOpenCaseId(null);
                  setOpenCaseName(null);
                  setTab("suites");
                }}
              />
            )}
            {(tab === "suites" || (tab === "case" && openCaseId === null)) && (
              <SuiteDetailPage
                projectId={projectId}
                focusedSuiteId={activeSuiteId}
                suiteCreateSignal={suiteCreateSignal}
                caseCreateSignal={caseCreateSignal}
                onSuiteFocus={setActiveSuiteId}
                onChanged={bumpExplorer}
                onOpenCase={(id) => {
                  openCase(id);
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
