import { useCallback, useEffect, useRef, useState } from "react";

import type {
  RunFinishedEvent,
  RunLogEvent,
  RunStepUpdateEvent,
} from "../../../shared/ipc-contract.js";
import type { RunMode } from "../../../shared/schema.js";
import type { StepStatus } from "../../../shared/step-types.js";
import { api, formatApiError } from "../../api.js";
import { RunEventBuffer } from "./run-event-buffer.js";

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
  /** Case-level summary from `run:finished` (drives the progress bar's verdict). */
  lastSummary: RunFinishedEvent["summary"] | null;
  /** Step count captured when the run started (M21 progress denominator). */
  runStepTotal: number;
  runBusy: boolean;
  runSpeedMs: number;
  setRunSpeedMs: (ms: number) => void;
  /** Supervised run paused on a failed step — the failed step can be edited. */
  paused: boolean;
  startRun: (mode: RunMode, stepCount: number) => void;
  resumeRun: () => void;
  cancelRun: () => void;
  fullRerun: (mode: RunMode, stepCount: number) => void;
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
  const [lastSummary, setLastSummary] = useState<RunFinishedEvent["summary"] | null>(null);
  const [runStepTotal, setRunStepTotal] = useState(0);
  const [runBusy, setRunBusy] = useState(false);
  const [runSpeedMs, setRunSpeedMs] = useState<number>(0);
  // Listener state lives in refs so the `run:*` subscriptions can be mounted
  // once (before the first start call) while still filtering by the run ids.
  const activeRunRef = useRef<ActiveRun | null>(null);
  const startingRef = useRef(false);
  const bufferRef = useRef(new RunEventBuffer());

  const applyStepEvent = useCallback((event: RunStepUpdateEvent): void => {
    setStatusByOrder((prev) => ({ ...prev, [event.order]: event.status }));
    if (event.status === "fail") {
      setFailedOrder(event.order);
    }
  }, []);

  const applyLogEvent = useCallback((event: RunLogEvent): void => {
    setRunLogs((prev) => [...prev.slice(-29), `[${event.level}] ${event.msg}`]);
  }, []);

  const applyFinishedEvent = useCallback((event: RunFinishedEvent): void => {
    const s = event.summary;
    setLastSummary(s);
    setRunFinished(
      `Finished: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped (of ${s.total}).`,
    );
    activeRunRef.current = null;
    setActiveRun(null);
  }, []);

  // A case switch drops the previous case's run view (M14).
  useEffect(() => {
    activeRunRef.current = null;
    startingRef.current = false;
    bufferRef.current.clear();
    setActiveRun(null);
    setStatusByOrder({});
    setRunLogs([]);
    setFailedOrder(null);
    setRunFinished(null);
    setLastSummary(null);
    setRunStepTotal(0);
  }, [caseId]);

  // Subscribe once, at mount: the missing-key fast path emits step/log/finish
  // events before `runner:runSingle` returns its ids, so they are buffered and
  // replayed when the ids arrive (review F7).
  useEffect(() => {
    const offStep = api.onRunStepUpdate((event) => {
      const active = activeRunRef.current;
      if (active === null) {
        if (startingRef.current) {
          bufferRef.current.push({ kind: "step", event });
        }
        return;
      }
      if (event.caseRunId === active.caseRunId) {
        applyStepEvent(event);
      }
    });
    const offLog = api.onRunLog((event) => {
      if (activeRunRef.current !== null) {
        applyLogEvent(event);
      } else if (startingRef.current) {
        bufferRef.current.push({ kind: "log", event });
      }
    });
    const offDone = api.onRunFinished((event) => {
      const active = activeRunRef.current;
      if (active === null) {
        if (startingRef.current) {
          bufferRef.current.push({ kind: "finished", event });
        }
        return;
      }
      if (event.suiteRunId === active.suiteRunId) {
        applyFinishedEvent(event);
      }
    });
    return () => {
      offStep();
      offLog();
      offDone();
    };
  }, [applyStepEvent, applyLogEvent, applyFinishedEvent]);

  const startRun = useCallback(
    (mode: RunMode, stepCount: number): void => {
      setRunBusy(true);
      onError(null);
      bufferRef.current.clear();
      startingRef.current = true;
      setRunStepTotal(stepCount);
      // Clear the previous result immediately: a failed start must not leave
      // the old run's verdict looking like this run's progress.
      setStatusByOrder({});
      setFailedOrder(null);
      setRunFinished(null);
      setLastSummary(null);
      setRunLogs([]);
      const actionDelayMs = mode === "supervised" ? runSpeedMs : undefined;
      api
        .runSingleCase(caseId, mode, actionDelayMs)
        .then((ids) => {
          const active = { ...ids, mode };
          setStatusByOrder({});
          setFailedOrder(null);
          setRunFinished(null);
          setLastSummary(null);
          setRunLogs([]);
          activeRunRef.current = active;
          setActiveRun(active);
          startingRef.current = false;
          // Replay events emitted before the ids arrived — including a finish,
          // which clears the active run and leaves the page finished.
          for (const entry of bufferRef.current.drain(ids)) {
            if (entry.kind === "step") {
              applyStepEvent(entry.event);
            } else if (entry.kind === "log") {
              applyLogEvent(entry.event);
            } else {
              applyFinishedEvent(entry.event);
            }
          }
          const speedNote =
            mode === "supervised" && runSpeedMs > 0
              ? ` at ${(runSpeedMs / 1000).toFixed(1)}s/step`
              : "";
          onNotice(`Run started (${mode}${speedNote}).`);
        })
        .catch((err: unknown) => {
          startingRef.current = false;
          bufferRef.current.clear();
          onError(formatApiError(err));
        })
        .finally(() => {
          setRunBusy(false);
        });
    },
    [caseId, runSpeedMs, onError, onNotice, applyStepEvent, applyLogEvent, applyFinishedEvent],
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
    (mode: RunMode, stepCount: number): void => {
      if (activeRun === null) {
        startRun(mode, stepCount);
        return;
      }
      const { suiteRunId } = activeRun;
      setRunBusy(true);
      onError(null);
      api
        .cancelRun(suiteRunId)
        .then(() => {
          startRun(mode, stepCount);
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
    lastSummary,
    runStepTotal,
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
