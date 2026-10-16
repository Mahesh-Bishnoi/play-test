import { useCallback, useEffect, useState } from "react";

import { api } from "../api.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  suiteRunId: string;
  onBack: () => void;
  /** WS6: parent swaps to the retry run's report when re-run yields a new id. */
  onRerun?: (newSuiteRunId: string) => void;
}

/**
 * Suite run report (WS6 / M6, PLAN §6 + §9): renders the self-contained HTML
 * report, exports PDF, and re-runs failed cases. Auto-refreshes when the
 * matching `run:finished` event lands (suite still running when opened).
 */
export default function RunReportPage({ suiteRunId, onBack, onRerun }: Props): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setError(null);
    api
      .getReportHtml(suiteRunId)
      .then((loaded) => {
        setHtml(loaded);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
  }, [suiteRunId]);

  useEffect(() => {
    setHtml(null);
    setNotice(null);
    setError(null);
    refresh();
    return api.onRunFinished((event) => {
      if (event.suiteRunId === suiteRunId) {
        refresh();
      }
    });
  }, [suiteRunId, refresh]);

  const exportPdf = (): void => {
    setBusy(true);
    setNotice(null);
    api
      .exportReportPdf(suiteRunId)
      .then((path) => {
        setNotice(`PDF exported: ${path}`);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const rerunFailed = (): void => {
    setBusy(true);
    setNotice(null);
    api
      .rerunFailed(suiteRunId)
      .then(({ suiteRunId: nextId }) => {
        if (onRerun !== undefined) {
          onRerun(nextId);
        } else {
          setNotice(`Retry started: ${nextId}`);
        }
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <section aria-label="Run report" style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" onClick={onBack} style={buttonStyle()}>
          ← Back
        </button>
        <h2 style={{ margin: 0 }}>Run report</h2>
        <span style={{ color: "#666", fontSize: 13, fontFamily: "monospace" }}>{suiteRunId}</span>
      </div>
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
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={refresh} disabled={busy} style={buttonStyle(busy)}>
          Refresh
        </button>
        <button type="button" onClick={exportPdf} disabled={busy} style={buttonStyle(busy)}>
          Export PDF
        </button>
        <button type="button" onClick={rerunFailed} disabled={busy} style={buttonStyle(busy)}>
          Re-run failed
        </button>
      </div>
      {html === null ? (
        <p>Loading report…</p>
      ) : (
        <iframe
          title={`Report for run ${suiteRunId}`}
          srcDoc={html}
          sandbox=""
          style={{ width: "100%", minHeight: 600, border: "1px solid #ccc", borderRadius: 6 }}
        />
      )}
    </section>
  );
}
