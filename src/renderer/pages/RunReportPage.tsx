import { useCallback, useEffect, useState } from "react";

import { api, formatApiError } from "../api.js";

interface Props {
  suiteRunId: string;
  onBack: () => void;
  /** WS6: parent swaps to the retry run's report when re-run yields a new id. */
  onRerun?: (newSuiteRunId: string) => void;
}

/**
 * True when the rendered report HTML shows any failure. The summary row
 * (`<td class="fail">N</td>`) carries the failed-case count; the fallback
 * substring check covers failed cases / steps if the template changes.
 */
export function reportHasFailures(html: string): boolean {
  const summary = html.match(/<td class="fail">(\d+)<\/td>/);
  if (summary !== null) {
    return Number.parseInt(summary[1] ?? "0", 10) > 0;
  }
  return html.includes(">fail</") || html.includes(">failed</");
}

/**
 * Suite run report (WS6 / M6, PLAN §6 + §9): renders the self-contained HTML
 * report, exports PDF, and re-runs failed cases.
 */
export default function RunReportPage({ suiteRunId, onBack, onRerun }: Props): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null);
  const [hasFailed, setHasFailed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setError(null);
    api
      .getReportHtml(suiteRunId)
      .then((loaded) => {
        setHtml(loaded);
        setHasFailed(reportHasFailures(loaded));
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      });
  }, [suiteRunId]);

  useEffect(() => {
    setHtml(null);
    setHasFailed(null);
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
        setError(formatApiError(err));
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
        setError(formatApiError(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <section aria-label="Run report" className="pt-page">
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
        {hasFailed === true && (
          <button
            type="button"
            className="pt-btn pt-btn-primary pt-btn-sm"
            onClick={rerunFailed}
            disabled={busy}
          >
            Re-run failed
          </button>
        )}
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
