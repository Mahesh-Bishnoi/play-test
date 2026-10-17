import {
  RunnerCancelPayload,
  RunnerResumePayload,
  RunnerRerunFailedPayload,
  RunnerRerunLastFailedPayload,
  RunnerRunSinglePayload,
  RunnerRunSuitePayload,
} from "../../shared/ipc-contract.js";
import type { SingleCaseRunner } from "../runner/single-runner.js";
import type { SuiteRunner } from "../suite-runner/suite-runner.js";
import type { IpcHandleFn } from "./handle.js";

const RUNNER_CHANNELS = [
  "runner:runSingle",
  "runner:runSuite",
  "runner:resumeFromStep",
  "runner:rerunFailed",
  "runner:rerunLastFailed",
  "runner:cancel",
] as const;

/**
 * Runner channels (WS5/WS6, PLAN §5 + §8). `runSingle` returns `{ suiteRunId,
 * caseRunId }` and streams progress over `run:*` events; the background `done`
 * promises never reject (failures settle into the db + a `run:finished`
 * event), so handlers drop them. Suite channels delegate to the parallel
 * `SuiteRunner` (M6); `cancel` fans out to both (each no-ops on unknown ids).
 */
export function registerRunnerHandlers(
  handle: IpcHandleFn,
  single: SingleCaseRunner,
  suite: SuiteRunner,
): void {
  for (const channel of RUNNER_CHANNELS) {
    handle(channel, (rawPayload: unknown) => {
      switch (channel) {
        case "runner:runSingle": {
          const payload = RunnerRunSinglePayload.parse(rawPayload);
          const started = single.runSingle(payload);
          return { suiteRunId: started.suiteRunId, caseRunId: started.caseRunId };
        }
        case "runner:runSuite": {
          const payload = RunnerRunSuitePayload.parse(rawPayload);
          const started = suite.runSuite(payload);
          return { suiteRunId: started.suiteRunId };
        }
        case "runner:resumeFromStep": {
          const payload = RunnerResumePayload.parse(rawPayload);
          const resumed = single.resumeFromStep(payload);
          return { suiteRunId: resumed.suiteRunId, caseRunId: resumed.caseRunId };
        }
        case "runner:rerunFailed": {
          const payload = RunnerRerunFailedPayload.parse(rawPayload);
          const started = suite.rerunFailed(payload);
          return { suiteRunId: started.suiteRunId };
        }
        case "runner:rerunLastFailed": {
          const payload = RunnerRerunLastFailedPayload.parse(rawPayload);
          const started = suite.rerunLastFailed(payload);
          return { suiteRunId: started.suiteRunId };
        }
        case "runner:cancel": {
          const payload = RunnerCancelPayload.parse(rawPayload);
          return Promise.all([single.cancelRun(payload), suite.cancelRun(payload)]).then(
            () => null,
          );
        }
      }
    });
  }
}
