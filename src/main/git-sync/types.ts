/**
 * Sync vocabulary: the result shapes the IPC layer hands back, the transport
 * error, and the conflict row written to `.git` between a pull and a resolve.
 */

import type { SnapshotCase, SnapshotProject, SnapshotSuite } from "./snapshot.js";

export interface SyncAuthor {
  name: string;
  email: string;
}

export interface SyncCommitResult {
  hash: string;
  changed: string[];
}

export type ConflictEntity = "case" | "suite" | "project";

export interface SyncConflict {
  entity: ConflictEntity;
  id: string;
  name: string;
  /** True when the remote side deleted the entity (resolve "theirs" deletes). */
  remoteDeleted?: boolean;
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
  /** `null` = the remote deleted this entity; "take theirs" deletes locally. */
  theirs: SnapshotCase | SnapshotSuite | SnapshotProject | null;
}
