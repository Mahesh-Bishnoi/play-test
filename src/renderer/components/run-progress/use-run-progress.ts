import { useCallback, useEffect, useState } from "react";

import type { RunProgress } from "../../../shared/ipc-contract.js";
import { api, formatApiError } from "../../api.js";
import { isSuiteRunFinished } from "./progress-model.js";

/** One second is responsive without turning a local SQLite lookup into noise. */
export const RUN_PROGRESS_POLL_MS = 1000;

export interface RunProgressState {
  progress: RunProgress | null;
  error: string | null;
  loading: boolean;
  retry: () => void;
}

/**
 * Poll one run's live progress while it is pending/running (M21). Stops at a
 * terminal status (or an error, which the caller offers a Retry for), and
 * cleans up timers on unmount/id change. One request at a time: the next timer
 * starts only after the previous reply settles.
 */
export function useRunProgress(
  suiteRunId: string | null,
  intervalMs: number = RUN_PROGRESS_POLL_MS,
): RunProgressState {
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (suiteRunId === null) {
      setProgress(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setProgress(null);
    setError(null);
    setLoading(true);

    const poll = (): void => {
      api
        .getRunProgress(suiteRunId)
        .then((next) => {
          if (cancelled) {
            return;
          }
          setProgress(next);
          setError(null);
          setLoading(false);
          if (!isSuiteRunFinished(next.status)) {
            timer = setTimeout(poll, intervalMs);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) {
            return;
          }
          setError(formatApiError(err));
          setLoading(false);
        });
    };
    poll();

    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [suiteRunId, intervalMs, nonce]);

  const retry = useCallback((): void => {
    setNonce((value) => value + 1);
  }, []);

  return { progress, error, loading, retry };
}
