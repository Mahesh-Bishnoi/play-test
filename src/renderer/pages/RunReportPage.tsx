import { useCallback, useEffect, useState } from "react";

import { api } from "../api.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Props {
  suiteRunId: string;
  onBack: () => void;
  /** WS6: parent swaps to the retry run's report when re-run yields a new id. */
  onRerun?: (newSuiteRunId: string) => void;
}

/**
 * Suite run report (WS6 / M6, PLAN §6 + §9): renders the self-contained HTML
 * report, exports PDF, and re-runs failed cases.
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
    <section aria-label="Run report" style={{ display: "grid", gap: 14 }}>
      <div className="pt-topbar">
        <button type="button" className="pt-btn pt-btn-sm" onClick={onBack}>
          ← Back
        </button>
        <h2>Run report</h2>
        <span className="pt-mono pt-hint">{suiteRunId}</span>
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
      <div className="pt-row">
        <button type="button" className="pt-btn pt-btn-sm" onClick={refresh} disabled={busy}>
          Refresh
        </button>
        <button type="button" className="pt-btn pt-btn-sm" onClick={exportPdf} disabled={busy}>
          Export PDF
        </button>
        <button
          type="button"
          className="pt-btn pt-btn-primary pt-btn-sm"
          onClick={rerunFailed}
          disabled={busy}
        >
          Re-run failed
        </button>
      </div>
      {html === null ? (
        <p className="pt-empty">Loading report…</p>
      ) : (
        <iframe
          title={`Report for run ${suiteRunId}`}
          srcDoc={html}
          sandbox=""
          className="pt-report-frame"
        />
      )}
    </section>
  );
}
