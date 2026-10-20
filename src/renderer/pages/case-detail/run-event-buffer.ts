/**
 * Bounded buffer for `run:*` events that arrive before the renderer knows the
 * run ids (review F7). `runner:runSingle` emits a fast failure — a missing
 * `{{key}}` step, an empty case — synchronously before its IPC reply reaches
 * the page, so those events must be held until the ids are known and then
 * replayed. Pure and unit-tested; the hook owns the React state.
 */

import type {
  RunFinishedEvent as RunFinished,
  RunLogEvent as RunLog,
  RunStepUpdateEvent as RunStepUpdate,
} from "../../../shared/ipc-contract.js";

export type BufferedRunEvent =
  | { kind: "step"; event: RunStepUpdate }
  | { kind: "log"; event: RunLog }
  | { kind: "finished"; event: RunFinished };

/** Cap on held events — a fast-failing run emits a handful, never thousands. */
export const RUN_EVENT_BUFFER_LIMIT = 200;

export class RunEventBuffer {
  private events: BufferedRunEvent[] = [];

  constructor(private readonly limit: number = RUN_EVENT_BUFFER_LIMIT) {}

  push(event: BufferedRunEvent): void {
    this.events.push(event);
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
    }
  }

  clear(): void {
    this.events = [];
  }

  /**
   * Remove and return the events belonging to the started run, preserving
   * order. Logs carry no ids, so they belong to whichever start is in flight
   * (the app runs one recorder/run start at a time); step/finish events from
   * an unrelated run are dropped.
   */
  drain(ids: { caseRunId: string; suiteRunId: string }): BufferedRunEvent[] {
    const taken: BufferedRunEvent[] = [];
    for (const entry of this.events) {
      if (entry.kind === "log") {
        taken.push(entry);
      } else if (entry.kind === "step") {
        if (entry.event.caseRunId === ids.caseRunId) {
          taken.push(entry);
        }
      } else if (entry.event.suiteRunId === ids.suiteRunId) {
        taken.push(entry);
      }
    }
    this.events = [];
    return taken;
  }
}
