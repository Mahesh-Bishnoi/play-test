import type { AppDatabase } from "../db.js";
import {
  SyncBranchPayload,
  SyncClonePayload,
  SyncCommitPayload,
  SyncInitPayload,
  SyncPullPayload,
  SyncPushPayload,
  SyncResolvePayload,
  SyncStatusPayload,
} from "../../shared/ipc-contract.js";
import {
  cloneSyncRepo,
  createSyncBranch,
  initSyncRepo,
  resolveSyncConflict,
  syncCommit,
  syncPull,
  syncPush,
  syncStatus,
} from "../git-sync/sync.js";
import type { IpcHandleFn } from "./handle.js";

/**
 * Sync channels (local-git project sync, Phase 2 core). Payloads are zod
 * validated at the boundary; the service owns remote/path validation and
 * throws SyncRemoteError on transport problems. All handlers are async and
 * return serialized results (hashes, entity ids, status) — no live handles.
 */
export function registerSyncHandlers(handle: IpcHandleFn, db: AppDatabase): void {
  handle("sync:init", (rawPayload: unknown) => {
    const payload = SyncInitPayload.parse(rawPayload);
    return initSyncRepo(db, payload.projectId, {
      dir: payload.dir,
      ...(payload.remoteUrl !== undefined ? { remoteUrl: payload.remoteUrl } : {}),
      author: payload.author,
      ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
    });
  });
  handle("sync:commit", (rawPayload: unknown) => {
    const payload = SyncCommitPayload.parse(rawPayload);
    return syncCommit(db, payload.projectId, {
      dir: payload.dir,
      author: payload.author,
      message: payload.message,
    });
  });
  handle("sync:push", (rawPayload: unknown) => {
    const payload = SyncPushPayload.parse(rawPayload);
    return syncPush({
      dir: payload.dir,
      ...(payload.remote !== undefined ? { remote: payload.remote } : {}),
      ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
    });
  });
  handle("sync:pull", (rawPayload: unknown) => {
    const payload = SyncPullPayload.parse(rawPayload);
    return syncPull(db, payload.projectId, {
      dir: payload.dir,
      ...(payload.remote !== undefined ? { remote: payload.remote } : {}),
      ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
    });
  });
  handle("sync:status", (rawPayload: unknown) => {
    const payload = SyncStatusPayload.parse(rawPayload);
    return syncStatus(db, payload.projectId, payload.dir);
  });
  handle("sync:branch", (rawPayload: unknown) => {
    const payload = SyncBranchPayload.parse(rawPayload);
    return createSyncBranch(payload.dir, payload.name);
  });
  handle("sync:resolve", (rawPayload: unknown) => {
    const payload = SyncResolvePayload.parse(rawPayload);
    return resolveSyncConflict(db, payload.projectId, {
      dir: payload.dir,
      entity: payload.entity,
      id: payload.id,
      winner: payload.winner,
    });
  });
  handle("sync:clone", (rawPayload: unknown) => {
    const payload = SyncClonePayload.parse(rawPayload);
    return cloneSyncRepo(db, {
      remoteUrl: payload.remoteUrl,
      dir: payload.dir,
      ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
    });
  });
}
