/**
 * Three-way per-entity merge (pure — unit-tested without the e2e gate). No DB
 * or git imports: callers feed it base/local/remote slots and act on the
 * outcome.
 */

import { canonical } from "./snapshot.js";

// --- Three-way entity merge -----------------------------------------------------

export type MergeOutcome =
  | { kind: "take-remote" }
  | { kind: "delete-remote" }
  | { kind: "keep-local" }
  | { kind: "conflict" };

/** Three-way per-entity merge (pure — unit-tested without the e2e gate). */
export function mergeEntity<T>(slots: { base?: T; local?: T; remote?: T }): MergeOutcome {
  const b = slots.base === undefined ? undefined : canonical(slots.base);
  const l = slots.local === undefined ? undefined : canonical(slots.local);
  const r = slots.remote === undefined ? undefined : canonical(slots.remote);
  if (b === undefined) {
    // Added on one or both sides.
    if (l !== undefined && r !== undefined) {
      return l === r ? { kind: "keep-local" } : { kind: "conflict" };
    }
    return r !== undefined ? { kind: "take-remote" } : { kind: "keep-local" };
  }
  if (l === undefined && r === undefined) {
    return { kind: "keep-local" };
  }
  if (l === undefined) {
    return r === b ? { kind: "keep-local" } : { kind: "conflict" };
  }
  if (r === undefined) {
    return l === b ? { kind: "delete-remote" } : { kind: "conflict" };
  }
  if (l === r) {
    return { kind: "keep-local" };
  }
  if (l === b) {
    return { kind: "take-remote" };
  }
  if (r === b) {
    return { kind: "keep-local" };
  }
  return { kind: "conflict" };
}
