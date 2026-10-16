import { useState } from "react";

import CaseDetailPage from "./pages/CaseDetailPage.js";
import ProjectsPage from "./pages/ProjectsPage.js";
import RunReportPage from "./pages/RunReportPage.js";
import SuiteDetailPage from "./pages/SuiteDetailPage.js";
import BrowserBanner from "./components/BrowserBanner.js";

/**
 * App shell: dark sidebar (brand + projects) + main detail column.
 * Selection state unchanged (project / open case / open report).
 */
export default function App(): React.JSX.Element {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [openCaseId, setOpenCaseId] = useState<string | null>(null);
  const [reportRunId, setReportRunId] = useState<string | null>(null);

  const selectProject = (id: string | null): void => {
    setProjectId(id);
    setOpenCaseId(null);
    setReportRunId(null);
  };

  const view: string = reportRunId !== null ? "report" : openCaseId !== null ? "case" : "suites";

  return (
    <div className="pt-app">
      <div className="pt-shell">
        <aside className="pt-sidebar" aria-label="Workspace">
          <div className="pt-brand">
            <span className="pt-brand-mark" aria-hidden="true">
              P
            </span>
            <div>
              <h1>PlayTest</h1>
              <p>Manual-tester studio</p>
            </div>
          </div>
          <p className="pt-side-label">Projects</p>
          <ProjectsPage selectedId={projectId} onSelect={selectProject} />
          <p className="pt-hint" style={{ marginTop: "auto" }}>
            Chromium runs headless in parallel. Supervised runs pause for resume.
          </p>
        </aside>
        <main className="pt-main">
          <BrowserBanner />
          {projectId === null && (
            <div className="pt-card" style={{ marginTop: 16 }}>
              <div className="pt-section-head">
                <h2>Select a project to begin</h2>
              </div>
              <p className="pt-sub">
                Create a project in the sidebar, then manage suites, record steps, run cases, and
                open reports here.
              </p>
            </div>
          )}
          {projectId !== null && reportRunId !== null && (
            <RunReportPage
              suiteRunId={reportRunId}
              onBack={() => {
                setReportRunId(null);
              }}
              onRerun={(nextId) => {
                setReportRunId(nextId);
              }}
            />
          )}
          {projectId !== null && openCaseId === null && reportRunId === null && (
            <SuiteDetailPage
              projectId={projectId}
              onOpenCase={setOpenCaseId}
              onViewReport={setReportRunId}
            />
          )}
          {projectId !== null && openCaseId !== null && reportRunId === null && (
            <CaseDetailPage
              caseId={openCaseId}
              onBack={() => {
                setOpenCaseId(null);
              }}
            />
          )}
          <p className="pt-hint" style={{ marginTop: 18 }}>
            {view === "suites" ? "Suites" : view === "case" ? "Workflow" : "Report"} · local-first
            SQLite · artifacts in ~/PlayTestData
          </p>
        </main>
      </div>
    </div>
  );
}
