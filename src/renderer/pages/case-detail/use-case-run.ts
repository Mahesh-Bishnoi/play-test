import { useCallback, useEffect, useState } from "react";

import type { RunMode } from "../../../shared/schema.js";
import type { StepStatus } from "../../../shared/step-types.js";
import { api, formatApiError } from "../../api.js";

export interface ActiveRun {
  suiteRunId: string;
  caseRunId: string;
  mode: RunMode;
}

export interface CaseRun {
  activeRun: ActiveRun | null;
  /** Live status of each step, keyed by step order (empty when idle). */
  statusByOrder: Record<number, StepStatus>;
  runLogs: string[];
  failedOrder: number | null;
  runFinished: string | null;
  runBusy: boolean;
  runSpeedMs: number;
  setRunSpeedMs: (ms: number) => void;
  /** Supervised run paused on a failed step — the failed step can be edited. */
  paused: boolean;
  startRun: (mode: RunMode) => void;
  resumeRun: () => void;
  cancelRun: () => void;
  fullRerun: (mode: RunMode) => void;
}

/**
 * Single-case run lifecycle (WS5 / M5, PLAN §8): start, resume, cancel, and the
 * `run:*` event stream (M13) that colors the steps live. Pre-run pacing applies
 * to supervised runs only — unsupervised stays instant so parallel suites keep
 * full throughput.
 */
export function useCaseRun(
  caseId: string,
  options: {
    onError: (message: string | null) => void;
    onNotice: (message: string) => void;
  },
): CaseRun {
  const { onError, onNotice } = options;
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [statusByOrder, setStatusByOrder] = useState<Record<number, StepStatus>>({});
  const [runLogs, setRunLogs] = useState<string[]>([]);
  const [failedOrder, setFailedOrder] = useState<number | null>(null);
  const [runFinished, setRunFinished] = useState<string | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [runSpeedMs, setRunSpeedMs] = useState<number>(0);

  // A case switch drops the previous case's run view (M14).
  useEffect(() => {
    setActiveRun(null);
    setStatusByOrder({});
    setRunLogs([]);
    setFailedOrder(null);
    setRunFinished(null);
  }, [caseId]);

  useEffect(() => {
    if (activeRun === null) {
      return;
    }
    const { caseRunId, suiteRunId } = activeRun;
    const offStep = api.onRunStepUpdate((event) => {
      if (event.caseRunId !== caseRunId) {
        return;
      }
      setStatusByOrder((prev) => ({ ...prev, [event.order]: event.status }));
      if (event.status === "fail") {
        setFailedOrder(event.order);
      }
    });
    const offLog = api.onRunLog((event) => {
      setRunLogs((prev) => [...prev.slice(-29), `[${event.level}] ${event.msg}`]);
    });
    const offDone = api.onRunFinished((event) => {
      if (event.suiteRunId !== suiteRunId) {
        return;
      }
      const s = event.summary;
      setRunFinished(
        `Finished: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped (of ${s.total}).`,
      );
      setActiveRun(null);
    });
    return () => {
      offStep();
      offLog();
      offDone();
    };
  }, [activeRun]);

  const startRun = useCallback(
    (mode: RunMode): void => {
      setRunBusy(true);
      onError(null);
      const actionDelayMs = mode === "supervised" ? runSpeedMs : undefined;
      api
        .runSingleCase(caseId, mode, actionDelayMs)
        .then((ids) => {
          setActiveRun({ ...ids, mode });
          setStatusByOrder({});
          setFailedOrder(null);
          setRunFinished(null);
          setRunLogs([]);
          const speedNote =
            mode === "supervised" && runSpeedMs > 0
              ? ` at ${(runSpeedMs / 1000).toFixed(1)}s/step`
              : "";
          onNotice(`Run started (${mode}${speedNote}).`);
        })
        .catch((err: unknown) => {
          onError(formatApiError(err));
        })
        .finally(() => {
          setRunBusy(false);
        });
    },
    [caseId, runSpeedMs, onError, onNotice],
  );

  const resumeRun = useCallback((): void => {
    if (activeRun === null || failedOrder === null) {
      return;
    }
    const { caseRunId } = activeRun;
    const order = failedOrder;
    setRunBusy(true);
    onError(null);
    api
      .resumeFromStep(caseRunId, order)
      .then(() => {
        setFailedOrder(null);
        onNotice(`Resumed from step ${order + 1} — edits made while paused apply.`);
      })
      .catch((err: unknown) => {
        onError(formatApiError(err));
      })
      .finally(() => {
        setRunBusy(false);
      });
  }, [activeRun, failedOrder, onError, onNotice]);

  const cancelRun = useCallback((): void => {
    if (activeRun === null) {
      return;
    }
    const { suiteRunId } = activeRun;
    setRunBusy(true);
    api
      .cancelRun(suiteRunId)
      .then(() => {
        onNotice("Cancel requested — remaining steps skip.");
      })
      .catch((err: unknown) => {
        onError(formatApiError(err));
      })
      .finally(() => {
        setRunBusy(false);
      });
  }, [activeRun, onError, onNotice]);

  const fullRerun = useCallback(
    (mode: RunMode): void => {
      if (activeRun === null) {
        startRun(mode);
        return;
      }
      const { suiteRunId } = activeRun;
      setRunBusy(true);
      onError(null);
      api
        .cancelRun(suiteRunId)
        .then(() => {
          startRun(mode);
        })
        .catch((err: unknown) => {
          onError(formatApiError(err));
          setRunBusy(false);
        });
    },
    [activeRun, startRun, onError],
  );

  return {
    activeRun,
    statusByOrder,
    runLogs,
    failedOrder,
    runFinished,
    runBusy,
    runSpeedMs,
    setRunSpeedMs,
    paused: activeRun !== null && activeRun.mode === "supervised" && failedOrder !== null,
    startRun,
    resumeRun,
    cancelRun,
    fullRerun,
  };
}
