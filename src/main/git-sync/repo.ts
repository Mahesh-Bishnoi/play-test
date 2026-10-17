/**
 * Local repo helpers shared by every sync operation: gitdir/ref plumbing,
 * remote resolution (local paths only — never http(s)), object copying and
 * commit-graph walks.
 */

import fs from "node:fs";
import path from "node:path";

import * as git from "isomorphic-git";

import type { SyncAuthor } from "./types.js";
import { SyncRemoteError } from "./types.js";

/** Same rule as the IPC branch-name schema — duplicated here because
 *  src/shared cannot import main-only code. */
const BRANCH_RE =
  /^(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export function isValidBranchName(name: string): boolean {
  if (!BRANCH_RE.test(name)) {
    return false;
  }
  return name
    .split("/")
    .every((seg) => seg.length > 0 && seg !== "." && seg !== ".." && !seg.endsWith(".lock"));
}

// --- Local repo helpers -------------------------------------------------------

export function gitdirOf(dir: string): string {
  return path.join(dir, ".git");
}

export function assertSyncDir(dir: string): void {
  if (!fs.existsSync(path.join(gitdirOf(dir), "HEAD"))) {
    throw new SyncRemoteError(`not a sync repo (no .git/HEAD): ${dir}`);
  }
}

export async function currentBranchName(dir: string): Promise<string> {
  const branch = await git.currentBranch({ fs, dir });
  if (branch === undefined || typeof branch !== "string") {
    throw new Error("sync repo has a detached HEAD — check out a branch first");
  }
  return branch;
}

export async function resolveLocalRef(dir: string, ref: string): Promise<string | undefined> {
  try {
    return await git.resolveRef({ fs, dir, ref });
  } catch {
    return undefined;
  }
}

/** Resolve a local-path remote: explicit opt, else origin, never http(s). */
export async function resolveRemotePath(dir: string, remoteOpt?: string): Promise<string> {
  let url = remoteOpt;
  if (url === undefined) {
    try {
      const configured = await git.getConfig({ fs, dir, path: "remote.origin.url" });
      if (typeof configured === "string" && configured.length > 0) {
        url = configured;
      }
    } catch {
      // No configured origin — fall through to the missing-remote error.
    }
  }
  if (url === undefined || url.length === 0) {
    throw new SyncRemoteError("no remote configured (pass remote or init with remoteUrl)");
  }
  if (/^https?:\/\//i.test(url)) {
    throw new SyncRemoteError("http(s) remotes are not supported — use a local path");
  }
  const local = url.startsWith("file://") ? url.slice("file://".length) : url;
  const abs = path.resolve(local);
  if (!fs.existsSync(path.join(abs, "HEAD")) || !fs.statSync(abs).isDirectory()) {
    throw new SyncRemoteError(`remote is not a git repo: ${url}`);
  }
  return abs;
}

export async function resolveRemoteRef(
  remoteGitdir: string,
  branch: string,
): Promise<string | undefined> {
  try {
    return await git.resolveRef({ fs, gitdir: remoteGitdir, ref: `refs/heads/${branch}` });
  } catch {
    return undefined;
  }
}

/**
 * Exact-byte object copy (loose files + whole packs). Pack files are
 * immutable and content-addressed by name, so wholesale copy is exact.
 */
export function copyGitObjects(srcGitdir: string, dstGitdir: string): void {
  const src = path.join(srcGitdir, "objects");
  const dst = path.join(dstGitdir, "objects");
  const walk = (rel: string): void => {
    const full = path.join(src, rel);
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      if (entry.name === "info") {
        continue;
      }
      const entryRel = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        walk(entryRel);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const target = path.join(dst, entryRel);
      if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(src, entryRel), target);
      }
    }
  };
  if (fs.existsSync(src)) {
    walk("");
  }
}

export async function ancestorOids(
  gitdir: string,
  headOid: string,
  cap = 10000,
): Promise<Set<string>> {
  const seen = new Set<string>([headOid]);
  const queue = [headOid];
  while (queue.length > 0 && seen.size < cap) {
    const oid = queue.pop() as string;
    const { commit } = await git.readCommit({ fs, gitdir, oid });
    for (const parent of commit.parent) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return seen;
}

/** First remote-head ancestor reachable from local head (null if unrelated). */
export async function mergeBase(
  gitdir: string,
  localOid: string,
  remoteOid: string,
): Promise<string | null> {
  const localAncestors = await ancestorOids(gitdir, localOid);
  const queue = [remoteOid];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (localAncestors.has(oid)) {
      return oid;
    }
    if (visited.has(oid)) {
      continue;
    }
    visited.add(oid);
    const { commit } = await git.readCommit({ fs, gitdir, oid });
    queue.push(...commit.parent);
  }
  return null;
}

export async function defaultAuthor(dir: string): Promise<SyncAuthor> {
  const read = async (key: string, fallback: string): Promise<string> => {
    try {
      const value = await git.getConfig({ fs, dir, path: key });
      return typeof value === "string" && value.length > 0 ? value : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    name: await read("user.name", "playtest"),
    email: await read("user.email", "playtest@local"),
  };
}
