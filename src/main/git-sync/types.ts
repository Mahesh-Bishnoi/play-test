/**
 * Sync vocabulary: the result shapes the IPC layer hands back, the transport
 * error, and the conflict row written to `.git` between a pull and a resolve.
 */

import type { SnapshotCase, SnapshotSuite } from "./snapshot.js";

export interface SyncAuthor {
  name: string;
  email: string;
}

export interface SyncCommitResult {
  hash: string;
  changed: string[];
}

export interface SyncConflict {
  entity: "case" | "suite";
  id: string;
  name: string;
}

export interface SyncPullResult {
  applied: string[];
  conflicts: SyncConflict[];
}

export interface SyncStatusResult {
  branch: string;
  local: string | null;
  tracking: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
}

export interface SyncCloneResult {
  projectId: string;
}

/** Transport/remote problems (missing repo, non-bare guard, corrupt remote). */
export class SyncRemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncRemoteError";
  }
}

/** Pending conflict rows carry the remote ("theirs") content for resolve. */
export interface StoredConflict extends SyncConflict {
  theirs: SnapshotCase | SnapshotSuite;
}
