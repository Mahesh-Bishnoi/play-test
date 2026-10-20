/**
 * Local-git project sync (Phase 2 core). One git repo per synced project
 * holds a JSON snapshot of definitions only (suites, cases, steps, KV —
 * never runs/artifacts):
 *
 *   project.json  suites/<suiteId>.json  cases/<caseId>.json
 *
 * Identity is stable (DB ids are the filenames) so two machines converge
 * instead of duplicating. Local-path remotes only: isomorphic-git's
 * fetch/push/clone are HTTP-transport-only, so this module speaks to the
 * remote object store directly (exact-byte loose+pack copy, then explicit
 * ref updates). http(s) remote URLs are rejected, never fetched.
 *
 * Trust boundary: clone/pull content comes from another machine and is
 * untrusted — every entity id is gated by SAFE_ID (no path escape), only
 * the three known path shapes are read, blobs are size-capped, and all
 * content is zod-validated before touching the DB.
 */

import fs from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";
import * as git from "isomorphic-git";

import type { AppDatabase } from "../db.js";
import { inTransaction } from "../db.js";
import { deleteCase, getCase } from "../ipc-cases.js";
import { deleteCaseProfile } from "../ipc-profiles.js";
import { getProject, updateProject } from "../ipc-projects.js";
import { deleteSuite, getSuite, updateSuite } from "../ipc-suites.js";
import { projects, testCases, testData, testSteps } from "../schema.js";
import { readConflicts, writeConflicts } from "./conflicts.js";
import { mergeEntity } from "./merge.js";
import {
  ancestorOids,
  assertSyncDir,
  copyGitObjects,
  currentBranchName,
  defaultAuthor,
  gitdirOf,
  isValidBranchName,
  mergeBase,
  resolveLocalRef,
  resolveRemotePath,
  resolveRemoteRef,
} from "./repo.js";
import {
  canonical,
  type Snapshot,
  SnapshotCaseSchema,
  SnapshotProjectSchema,
  snapshotHash,
  SnapshotSuiteSchema,
} from "./snapshot.js";
import {
  insertCaseContent,
  insertSnapshotContent,
  insertSuiteContent,
  readSnapshotFromDb,
  setMembership,
  writeSnapshotFiles,
} from "./snapshot-db.js";
import { readSnapshotFromTree } from "./snapshot-tree.js";
import { SyncRemoteError } from "./types.js";
import type {
  StoredConflict,
  SyncAuthor,
  SyncCloneResult,
  SyncCommitResult,
  SyncPullResult,
  SyncStatusResult,
} from "./types.js";

// --- Public API ------------------------------------------------------------------

export async function initSyncRepo(
  db: AppDatabase,
  projectId: string,
  opts: { dir: string; remoteUrl?: string; author: SyncAuthor; branch?: string },
): Promise<SyncCommitResult> {
  const snapshot = readSnapshotFromDb(db, projectId);
  if (snapshot.project.id !== projectId) {
    throw new Error(`project snapshot mismatch: ${projectId}`);
  }
  if (opts.remoteUrl !== undefined && /^https?:\/\//i.test(opts.remoteUrl)) {
    throw new SyncRemoteError("http(s) remotes are not supported — use a local path");
  }
  const branch = opts.branch ?? "main";
  if (!isValidBranchName(branch)) {
    throw new Error(`invalid branch name: ${branch}`);
  }
  if (fs.existsSync(gitdirOf(opts.dir))) {
    throw new SyncRemoteError(`already a sync repo: ${opts.dir}`);
  }
  // Destructive guard: init + snapshot write wipes <dir>/suites and
  // <dir>/cases. Refuse a non-empty directory — pointing init at an export
  // folder or a de-gitted clone must fail loudly, never erase.
  if (fs.existsSync(opts.dir) && fs.readdirSync(opts.dir).length > 0) {
    throw new SyncRemoteError(
      `refusing to init in non-empty directory (pick an empty folder): ${opts.dir}`,
    );
  }
  fs.mkdirSync(opts.dir, { recursive: true });
  await git.init({ fs, dir: opts.dir, defaultBranch: branch });
  await git.setConfig({ fs, dir: opts.dir, path: "user.name", value: opts.author.name });
  await git.setConfig({ fs, dir: opts.dir, path: "user.email", value: opts.author.email });
  if (opts.remoteUrl !== undefined) {
    await git.addRemote({ fs, dir: opts.dir, remote: "origin", url: opts.remoteUrl });
  }
  writeSnapshotFiles(opts.dir, snapshot);
  await git.add({ fs, dir: opts.dir, filepath: "project.json" });
  for (const id of Object.keys(snapshot.suites)) {
    await git.add({ fs, dir: opts.dir, filepath: `suites/${id}.json` });
  }
  for (const id of Object.keys(snapshot.cases)) {
    await git.add({ fs, dir: opts.dir, filepath: `cases/${id}.json` });
  }
  const hash = await git.commit({
    fs,
    dir: opts.dir,
    author: opts.author,
    message: `Initial sync: ${snapshot.project.name}`,
  });
  return {
    hash,
    changed: [...Object.keys(snapshot.suites), ...Object.keys(snapshot.cases)],
  };
}

export async function syncCommit(
  db: AppDatabase,
  projectId: string,
  opts: { dir: string; author: SyncAuthor; message: string },
): Promise<SyncCommitResult> {
  assertSyncDir(opts.dir);
  const message = opts.message.trim();
  if (message.length === 0) {
    throw new Error("commit message must not be empty");
  }
  const snapshot = readSnapshotFromDb(db, projectId);
  const headOid = await resolveLocalRef(opts.dir, "HEAD");
  if (headOid === undefined) {
    throw new SyncRemoteError("sync repo has no commits yet");
  }
  const headSnapshot = await readSnapshotFromTree(gitdirOf(opts.dir), headOid);
  const oldCases = headSnapshot.cases;
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [id, c] of Object.entries(snapshot.cases)) {
    if (canonical(oldCases[id]) !== canonical(c)) {
      changed.push(id);
    }
  }
  for (const [id, s] of Object.entries(snapshot.suites)) {
    if (canonical(headSnapshot.suites[id]) !== canonical(s)) {
      changed.push(id);
    }
  }
  if (canonical(headSnapshot.project) !== canonical(snapshot.project)) {
    changed.push(snapshot.project.id);
  }
  for (const id of Object.keys(oldCases)) {
    if (snapshot.cases[id] === undefined) {
      removed.push(`cases/${id}.json`);
    }
  }
  for (const id of Object.keys(headSnapshot.suites)) {
    if (snapshot.suites[id] === undefined) {
      removed.push(`suites/${id}.json`);
    }
  }
  if (changed.length === 0 && removed.length === 0) {
    return { hash: headOid, changed: [] };
  }
  writeSnapshotFiles(opts.dir, snapshot);
  await git.add({ fs, dir: opts.dir, filepath: "project.json" });
  for (const id of Object.keys(snapshot.suites)) {
    await git.add({ fs, dir: opts.dir, filepath: `suites/${id}.json` });
  }
  for (const id of Object.keys(snapshot.cases)) {
    await git.add({ fs, dir: opts.dir, filepath: `cases/${id}.json` });
  }
  for (const filepath of removed) {
    await git.remove({ fs, dir: opts.dir, filepath });
  }
  const hash = await git.commit({
    fs,
    dir: opts.dir,
    author: opts.author,
    message,
    parent: [headOid],
  });
  return { hash, changed };
}

/** A bare gitdir has `bare = true` in its config (non-bare is the unsafe case). */
function isBareGitdir(gitdir: string): boolean {
  try {
    const config = fs.readFileSync(path.join(gitdir, "config"), "utf8");
    return /^\s*bare\s*=\s*true\s*$/im.test(config);
  } catch {
    return false;
  }
}

export async function syncPush(opts: {
  dir: string;
  remote?: string;
  branch?: string;
}): Promise<{ pushed: boolean; hash: string }> {
  assertSyncDir(opts.dir);
  const branch = opts.branch ?? (await currentBranchName(opts.dir));
  const localHead = await resolveLocalRef(opts.dir, `refs/heads/${branch}`);
  if (localHead === undefined) {
    throw new SyncRemoteError(`local branch has no commits: ${branch}`);
  }
  const remotePath = await resolveRemotePath(opts.dir, opts.remote);
  const remoteGitdir = remotePath;
  const remoteHead = await resolveRemoteRef(remoteGitdir, branch);
  if (remoteHead !== undefined) {
    if (remoteHead === localHead) {
      await git.writeRef({
        fs,
        gitdir: gitdirOf(opts.dir),
        ref: `refs/remotes/origin/${branch}`,
        value: localHead,
        force: true,
      });
      return { pushed: false, hash: localHead };
    }
    const localKnowsRemote = await git
      .isDescendent({ fs, gitdir: gitdirOf(opts.dir), oid: localHead, ancestor: remoteHead })
      .catch(() => false);
    if (!localKnowsRemote) {
      throw new Error(
        `push rejected: remote ${branch} has commits not in local history (pull first)`,
      );
    }
  }
  copyGitObjects(gitdirOf(opts.dir), remoteGitdir);
  // `remotePath` is the remote gitdir (resolveRemotePath checks `<path>/HEAD`).
  // A non-bare repo with this branch checked out would have its worktree
  // silently diverged by the force-ref update below.
  const remoteHeadFile = path.join(remotePath, "HEAD");
  if (!isBareGitdir(remotePath) && fs.existsSync(remoteHeadFile)) {
    const target = fs.readFileSync(remoteHeadFile, "utf8").trim();
    if (target === `ref: refs/heads/${branch}`) {
      throw new SyncRemoteError(
        `refusing to push to the checked-out branch of a non-bare repo: ${branch}`,
      );
    }
  }
  await git.writeRef({
    fs,
    gitdir: remoteGitdir,
    ref: `refs/heads/${branch}`,
    value: localHead,
    force: true,
  });
  await git.writeRef({
    fs,
    gitdir: gitdirOf(opts.dir),
    ref: `refs/remotes/origin/${branch}`,
    value: localHead,
    force: true,
  });
  return { pushed: true, hash: localHead };
}

export async function syncPull(
  db: AppDatabase,
  projectId: string,
  opts: { dir: string; remote?: string; branch?: string },
): Promise<SyncPullResult> {
  assertSyncDir(opts.dir);
  getProject(db, projectId);
  const branch = opts.branch ?? (await currentBranchName(opts.dir));
  const remotePath = await resolveRemotePath(opts.dir, opts.remote);
  const remoteGitdir = remotePath;
  const remoteHead = await resolveRemoteRef(remoteGitdir, branch);
  const pending = readConflicts(opts.dir).map(({ entity, id, name, remoteDeleted }) => ({
    entity,
    id,
    name,
    ...(remoteDeleted === true ? { remoteDeleted: true } : {}),
  }));
  if (remoteHead === undefined) {
    return { applied: [], conflicts: pending };
  }
  copyGitObjects(remoteGitdir, gitdirOf(opts.dir));
  await git.writeRef({
    fs,
    gitdir: gitdirOf(opts.dir),
    ref: `refs/remotes/origin/${branch}`,
    value: remoteHead,
    force: true,
  });
  const localHead = await resolveLocalRef(opts.dir, `refs/heads/${branch}`);
  if (localHead === undefined) {
    throw new SyncRemoteError(`local branch has no commits: ${branch}`);
  }
  if (localHead === remoteHead) {
    return { applied: [], conflicts: pending };
  }
  const base = await mergeBase(gitdirOf(opts.dir), localHead, remoteHead);
  if (base === null) {
    throw new Error("remote history is unrelated to local history — refusing to merge");
  }
  const [baseSnap, localSnap, remoteSnap] = await Promise.all([
    readSnapshotFromTree(gitdirOf(opts.dir), base),
    readSnapshotFromTree(gitdirOf(opts.dir), localHead),
    readSnapshotFromTree(gitdirOf(opts.dir), remoteHead),
  ]);
  if (remoteSnap.project.id !== projectId || localSnap.project.id !== projectId) {
    throw new SyncRemoteError("remote branch tracks a different project — refusing to merge");
  }
  const dbSnap = readSnapshotFromDb(db, projectId);
  if (snapshotHash(dbSnap) !== snapshotHash(localSnap)) {
    throw new Error("local database has uncommitted changes — commit before pulling");
  }
  const applied: string[] = [];
  // Rebuild the pending list from this pull's outcomes: a stale row must not
  // keep an old `theirs` (review F8), and a resolved conflict disappears.
  const conflicts = new Map<string, StoredConflict>();
  const recordConflict = (conflict: StoredConflict): void => {
    conflicts.set(`${conflict.entity}:${conflict.id}`, conflict);
  };
  const merged: Snapshot = {
    project: localSnap.project,
    suites: { ...localSnap.suites },
    cases: { ...localSnap.cases },
  };
  const projectOutcome = mergeEntity({
    base: baseSnap.project,
    local: localSnap.project,
    remote: remoteSnap.project,
  });
  if (projectOutcome.kind === "take-remote") {
    merged.project = remoteSnap.project;
    applied.push(remoteSnap.project.id);
  } else if (projectOutcome.kind === "conflict") {
    recordConflict({
      entity: "project",
      id: projectId,
      name: localSnap.project.name,
      theirs: remoteSnap.project,
    });
  }
  const caseIds = new Set([
    ...Object.keys(baseSnap.cases),
    ...Object.keys(localSnap.cases),
    ...Object.keys(remoteSnap.cases),
  ]);
  const casesToDelete: string[] = [];
  for (const id of caseIds) {
    const outcome = mergeEntity({
      base: baseSnap.cases[id],
      local: localSnap.cases[id],
      remote: remoteSnap.cases[id],
    });
    const remote = remoteSnap.cases[id];
    if (outcome.kind === "take-remote" && remote !== undefined) {
      merged.cases[id] = remote;
      applied.push(id);
    } else if (outcome.kind === "delete-remote") {
      delete merged.cases[id];
      casesToDelete.push(id);
      applied.push(id);
    } else if (outcome.kind === "conflict") {
      recordConflict({
        entity: "case",
        id,
        name: (localSnap.cases[id] ?? remote)?.name ?? id,
        ...(remote === undefined ? { remoteDeleted: true, theirs: null } : { theirs: remote }),
      });
    }
  }
  const suiteIds = new Set([
    ...Object.keys(baseSnap.suites),
    ...Object.keys(localSnap.suites),
    ...Object.keys(remoteSnap.suites),
  ]);
  const suitesToDelete: string[] = [];
  for (const id of suiteIds) {
    const outcome = mergeEntity({
      base: baseSnap.suites[id],
      local: localSnap.suites[id],
      remote: remoteSnap.suites[id],
    });
    const remote = remoteSnap.suites[id];
    if (outcome.kind === "take-remote" && remote !== undefined) {
      merged.suites[id] = {
        ...remote,
        memberCaseIds: remote.memberCaseIds.filter((m) => m in merged.cases),
      };
      applied.push(id);
    } else if (outcome.kind === "delete-remote") {
      delete merged.suites[id];
      suitesToDelete.push(id);
      applied.push(id);
    } else if (outcome.kind === "conflict") {
      recordConflict({
        entity: "suite",
        id,
        name: (localSnap.suites[id] ?? remote)?.name ?? id,
        ...(remote === undefined ? { remoteDeleted: true, theirs: null } : { theirs: remote }),
      });
    }
  }
  // A local/kept suite can still reference a remotely deleted case. Filter
  // before any mutation: the old code deleted cases first and threw here,
  // leaving the DB half-merged (review F8).
  for (const suite of Object.values(merged.suites)) {
    suite.memberCaseIds = suite.memberCaseIds.filter((id) => id in merged.cases);
  }
  applyMergedToDb(db, projectId, merged, casesToDelete, suitesToDelete);
  writeConflicts(opts.dir, [...conflicts.values()]);
  writeSnapshotFiles(opts.dir, merged);
  const fastForward = snapshotHash(merged) === snapshotHash(remoteSnap);
  if (fastForward) {
    await git.writeRef({
      fs,
      gitdir: gitdirOf(opts.dir),
      ref: `refs/heads/${branch}`,
      value: remoteHead,
      force: true,
    });
    await git.checkout({ fs, dir: opts.dir, ref: branch, force: true });
  } else {
    await git.add({ fs, dir: opts.dir, filepath: "project.json" });
    for (const id of Object.keys(merged.suites)) {
      await git.add({ fs, dir: opts.dir, filepath: `suites/${id}.json` });
    }
    for (const id of Object.keys(merged.cases)) {
      await git.add({ fs, dir: opts.dir, filepath: `cases/${id}.json` });
    }
    for (const id of Object.keys(localSnap.cases)) {
      if (merged.cases[id] === undefined) {
        await git.remove({ fs, dir: opts.dir, filepath: `cases/${id}.json` });
      }
    }
    for (const id of Object.keys(localSnap.suites)) {
      if (merged.suites[id] === undefined) {
        await git.remove({ fs, dir: opts.dir, filepath: `suites/${id}.json` });
      }
    }
    const author = await defaultAuthor(opts.dir);
    await git.commit({
      fs,
      dir: opts.dir,
      author,
      message: `Merge ${branch} from origin`,
      parent: [localHead, remoteHead],
    });
  }
  return {
    applied,
    conflicts: [...conflicts.values()].map(({ entity, id, name, remoteDeleted }) => ({
      entity,
      id,
      name,
      ...(remoteDeleted === true ? { remoteDeleted: true } : {}),
    })),
  };
}

/** Cases first (suites reference them), then suites + membership, then project. */
function applyMergedToDb(
  db: AppDatabase,
  projectId: string,
  merged: Snapshot,
  casesToDelete: string[],
  suitesToDelete: string[],
): void {
  // Validate everything before touching a row: a schema/membership error must
  // abort the pull with the DB unchanged.
  for (const c of Object.values(merged.cases)) {
    SnapshotCaseSchema.parse(c);
  }
  for (const suite of Object.values(merged.suites)) {
    SnapshotSuiteSchema.parse(suite);
    for (const memberId of suite.memberCaseIds) {
      if (merged.cases[memberId] === undefined) {
        throw new SyncRemoteError(`suite ${suite.id} references unknown case ${memberId}`);
      }
    }
  }
  const now = Date.now();
  inTransaction(db, (tx) => {
    for (const id of casesToDelete) {
      try {
        deleteCase(tx, id);
      } catch {
        // Already gone locally — merged state already holds.
      }
      // No FKs by convention: delete the profile row with its case (M14).
      deleteCaseProfile(tx, id);
    }
    for (const id of suitesToDelete) {
      try {
        deleteSuite(tx, id);
      } catch {
        // Already gone locally — merged state already holds.
      }
    }
    for (const c of Object.values(merged.cases)) {
      try {
        getCase(tx, c.id);
        tx.delete(testSteps).where(eq(testSteps.caseId, c.id)).run();
        tx.delete(testData).where(eq(testData.caseId, c.id)).run();
        tx.delete(testCases).where(eq(testCases.id, c.id)).run();
      } catch {
        // New locally — insert below.
      }
      insertCaseContent(tx, projectId, c, now);
    }
    for (const suite of Object.values(merged.suites)) {
      try {
        getSuite(tx, suite.id);
        updateSuite(tx, { id: suite.id, name: suite.name });
      } catch {
        insertSuiteContent(tx, projectId, suite, now);
      }
      setMembership(tx, suite);
    }
    updateProject(tx, {
      id: projectId,
      name: merged.project.name,
      baseUrl: merged.project.baseUrl ?? null,
    });
  });
}

export async function resolveSyncConflict(
  db: AppDatabase,
  projectId: string,
  opts: {
    dir: string;
    entity: "case" | "suite" | "project";
    id: string;
    winner: "mine" | "theirs";
  },
): Promise<{ resolved: boolean }> {
  assertSyncDir(opts.dir);
  getProject(db, projectId);
  const conflicts = readConflicts(opts.dir);
  const index = conflicts.findIndex((c) => c.entity === opts.entity && c.id === opts.id);
  if (index === -1) {
    throw new Error(`no pending conflict for ${opts.entity} ${opts.id}`);
  }
  const conflict = conflicts[index];
  if (conflict === undefined) {
    throw new Error(`no pending conflict for ${opts.entity} ${opts.id}`);
  }
  conflicts.splice(index, 1);
  if (opts.winner === "theirs") {
    const now = Date.now();
    if (conflict.remoteDeleted === true || conflict.theirs === null) {
      // The remote deleted this entity; "take theirs" makes that local.
      inTransaction(db, (tx) => {
        if (conflict.entity === "case") {
          try {
            deleteCase(tx, conflict.id);
          } catch {
            // Already gone locally.
          }
        } else if (conflict.entity === "suite") {
          try {
            deleteSuite(tx, conflict.id);
          } catch {
            // Already gone locally.
          }
        }
      });
    } else if (conflict.entity === "project") {
      const project = SnapshotProjectSchema.parse(conflict.theirs);
      inTransaction(db, (tx) => {
        updateProject(tx, {
          id: projectId,
          name: project.name,
          baseUrl: project.baseUrl ?? null,
        });
      });
    } else if (conflict.entity === "case") {
      const c = SnapshotCaseSchema.parse(conflict.theirs);
      inTransaction(db, (tx) => {
        try {
          getCase(tx, c.id);
          tx.delete(testSteps).where(eq(testSteps.caseId, c.id)).run();
          tx.delete(testData).where(eq(testData.caseId, c.id)).run();
          tx.delete(testCases).where(eq(testCases.id, c.id)).run();
        } catch {
          // Deleted locally — reinsert below.
        }
        insertCaseContent(tx, projectId, c, now);
      });
    } else {
      const suite = SnapshotSuiteSchema.parse(conflict.theirs);
      inTransaction(db, (tx) => {
        try {
          getSuite(tx, suite.id);
          updateSuite(tx, { id: suite.id, name: suite.name });
        } catch {
          insertSuiteContent(tx, projectId, suite, now);
        }
        setMembership(tx, suite);
      });
    }
  }
  writeConflicts(opts.dir, conflicts);
  return { resolved: true };
}

export async function cloneSyncRepo(
  db: AppDatabase,
  opts: { remoteUrl: string; dir: string; branch?: string },
): Promise<SyncCloneResult> {
  if (/^https?:\/\//i.test(opts.remoteUrl)) {
    throw new SyncRemoteError("http(s) remotes are not supported — use a local path");
  }
  const local = opts.remoteUrl.startsWith("file://")
    ? opts.remoteUrl.slice("file://".length)
    : opts.remoteUrl;
  const remotePath = path.resolve(local);
  if (!fs.existsSync(path.join(remotePath, "HEAD"))) {
    throw new SyncRemoteError(`remote is not a git repo: ${opts.remoteUrl}`);
  }
  let branch = opts.branch;
  if (branch === undefined) {
    try {
      const head = fs.readFileSync(path.join(remotePath, "HEAD"), "utf8").trim();
      const match = /^ref: refs\/heads\/(.+)$/.exec(head);
      branch = match?.[1] ?? "main";
    } catch {
      branch = "main";
    }
  }
  if (!isValidBranchName(branch)) {
    throw new Error(`invalid branch name: ${branch}`);
  }
  const remoteHead = await resolveRemoteRef(remotePath, branch);
  if (remoteHead === undefined) {
    throw new SyncRemoteError(`remote has no branch ${branch} (nothing to clone yet)`);
  }
  if (fs.existsSync(gitdirOf(opts.dir))) {
    throw new SyncRemoteError(`already a sync repo: ${opts.dir}`);
  }
  // Same destructive guard as initSyncRepo: clone ends in a force checkout
  // that overwrites working-tree files.
  if (fs.existsSync(opts.dir) && fs.readdirSync(opts.dir).length > 0) {
    throw new SyncRemoteError(
      `refusing to clone into non-empty directory (pick an empty folder): ${opts.dir}`,
    );
  }
  fs.mkdirSync(opts.dir, { recursive: true });
  await git.init({ fs, dir: opts.dir, defaultBranch: branch });
  copyGitObjects(remotePath, gitdirOf(opts.dir));
  await git.writeRef({
    fs,
    gitdir: gitdirOf(opts.dir),
    ref: `refs/heads/${branch}`,
    value: remoteHead,
  });
  await git.writeRef({
    fs,
    gitdir: gitdirOf(opts.dir),
    ref: `refs/remotes/origin/${branch}`,
    value: remoteHead,
    force: true,
  });
  await git.addRemote({ fs, dir: opts.dir, remote: "origin", url: opts.remoteUrl });
  await git.checkout({ fs, dir: opts.dir, ref: branch });
  const snapshot = await readSnapshotFromTree(gitdirOf(opts.dir), remoteHead);
  try {
    getProject(db, snapshot.project.id);
    throw new Error(`project already exists in this database: ${snapshot.project.id}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("project already exists")) {
      throw err;
    }
  }
  const now = Date.now();
  inTransaction(db, (tx) => {
    tx.insert(projects)
      .values({
        id: snapshot.project.id,
        name: snapshot.project.name,
        baseUrl: snapshot.project.baseUrl ?? null,
        createdAt: now,
      })
      .run();
    insertSnapshotContent(tx, snapshot);
  });
  return { projectId: snapshot.project.id };
}

export async function createSyncBranch(dir: string, name: string): Promise<{ branch: string }> {
  assertSyncDir(dir);
  if (!isValidBranchName(name)) {
    throw new Error(`invalid branch name: ${name}`);
  }
  await git.branch({ fs, dir, ref: name, checkout: true });
  return { branch: name };
}

export async function syncStatus(
  db: AppDatabase,
  projectId: string,
  dir: string,
): Promise<SyncStatusResult> {
  assertSyncDir(dir);
  const branch = await currentBranchName(dir);
  const local = (await resolveLocalRef(dir, `refs/heads/${branch}`)) ?? null;
  const tracking = (await resolveLocalRef(dir, `refs/remotes/origin/${branch}`)) ?? null;
  let ahead = 0;
  let behind = 0;
  if (local !== null && tracking !== null && local !== tracking) {
    const localAncestors = await ancestorOids(gitdirOf(dir), local);
    if (localAncestors.has(tracking)) {
      const queue = [local];
      const visited = new Set<string>();
      while (queue.length > 0 && visited.size < 10000) {
        const oid = queue.pop() as string;
        if (oid === tracking || visited.has(oid)) {
          continue;
        }
        visited.add(oid);
        ahead += 1;
        const { commit } = await git.readCommit({ fs, gitdir: gitdirOf(dir), oid });
        queue.push(...commit.parent);
      }
    } else {
      // Diverged or behind: count tracking-side commits unknown locally…
      const queue = [tracking];
      const visited = new Set<string>();
      while (queue.length > 0 && visited.size < 10000) {
        const oid = queue.pop() as string;
        if (visited.has(oid) || localAncestors.has(oid)) {
          continue;
        }
        visited.add(oid);
        behind += 1;
        const { commit } = await git.readCommit({ fs, gitdir: gitdirOf(dir), oid });
        queue.push(...commit.parent);
      }
      // …and local-side commits unknown to tracking (0 when strictly behind).
      const trackingAncestors = await ancestorOids(gitdirOf(dir), tracking);
      const aheadQueue = [local];
      const aheadVisited = new Set<string>();
      while (aheadQueue.length > 0 && aheadVisited.size < 10000) {
        const oid = aheadQueue.pop() as string;
        if (aheadVisited.has(oid) || trackingAncestors.has(oid)) {
          continue;
        }
        aheadVisited.add(oid);
        ahead += 1;
        const { commit } = await git.readCommit({ fs, gitdir: gitdirOf(dir), oid });
        aheadQueue.push(...commit.parent);
      }
    }
  } else if (local !== null && tracking === null) {
    const ancestors = await ancestorOids(gitdirOf(dir), local);
    ahead = ancestors.size;
  }
  let dirty = true;
  try {
    const dbSnap = readSnapshotFromDb(db, projectId);
    if (local !== null) {
      const headSnap = await readSnapshotFromTree(gitdirOf(dir), local);
      dirty = snapshotHash(dbSnap) !== snapshotHash(headSnap);
    }
  } catch {
    dirty = true;
  }
  return { branch, local, tracking, ahead, behind, dirty };
}
