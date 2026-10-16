import { useState } from "react";

import CaseDetailPage from "./pages/CaseDetailPage.js";
import ProjectsPage from "./pages/ProjectsPage.js";
import RunReportPage from "./pages/RunReportPage.js";
import SuiteDetailPage from "./pages/SuiteDetailPage.js";

/**
 * M6 shell: project picker + suite/case manager + workflow editor + run
 * reports. WS5/WS6 run views sit behind the same selection state.
 */
export default function App(): React.JSX.Element {
  const [projectId, setProjectId] = useState<string | null>(null);
  // WS3: which case is open in the workflow editor (reset on project switch).
  const [openCaseId, setOpenCaseId] = useState<string | null>(null);
  // WS6: which suite run's report is open (exclusive with the case editor).
  const [reportRunId, setReportRunId] = useState<string | null>(null);

  const selectProject = (id: string | null): void => {
    setProjectId(id);
    setOpenCaseId(null);
    setReportRunId(null);
  };

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 960 }}>
      <h1>PlayTest</h1>
      <ProjectsPage selectedId={projectId} onSelect={selectProject} />
      {projectId !== null && reportRunId !== null && (
        <div style={{ marginTop: 24, borderTop: "1px solid #ddd", paddingTop: 16 }}>
          <RunReportPage
            suiteRunId={reportRunId}
            onBack={() => {
              setReportRunId(null);
            }}
            onRerun={(nextId) => {
              setReportRunId(nextId);
            }}
          />
        </div>
      )}
      {projectId !== null && openCaseId === null && reportRunId === null && (
        <div style={{ marginTop: 24, borderTop: "1px solid #ddd", paddingTop: 16 }}>
          <SuiteDetailPage
            projectId={projectId}
            onOpenCase={setOpenCaseId}
            onViewReport={setReportRunId}
          />
        </div>
      )}
      {projectId !== null && openCaseId !== null && reportRunId === null && (
        <div style={{ marginTop: 24, borderTop: "1px solid #ddd", paddingTop: 16 }}>
          <CaseDetailPage
            caseId={openCaseId}
            onBack={() => {
              setOpenCaseId(null);
            }}
          />
        </div>
      )}
    </main>
  );
}
