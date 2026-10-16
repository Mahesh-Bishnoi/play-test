import { useState } from "react";

import ProjectsPage from "./pages/ProjectsPage.js";
import SuiteDetailPage from "./pages/SuiteDetailPage.js";

/**
 * M2 shell: project picker + suite/case manager. WS3 adds the workflow
 * editor; WS5/WS6 add run + report views behind the same selection state.
 */
export default function App(): React.JSX.Element {
  const [projectId, setProjectId] = useState<string | null>(null);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 960 }}>
      <h1>PlayTest</h1>
      <ProjectsPage selectedId={projectId} onSelect={setProjectId} />
      {projectId !== null && (
        <div style={{ marginTop: 24, borderTop: "1px solid #ddd", paddingTop: 16 }}>
          <SuiteDetailPage projectId={projectId} />
        </div>
      )}
    </main>
  );
}
