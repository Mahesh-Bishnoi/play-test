/**
 * Reading a snapshot out of a git tree. Content is untrusted (another machine
 * wrote it): only the three known path shapes are read, blobs are size-capped,
 * and everything is zod-validated before it leaves this module.
 */

import fs from "node:fs";

import * as git from "isomorphic-git";

import {
  type Snapshot,
  type SnapshotCase,
  SnapshotCaseSchema,
  type SnapshotProject,
  SnapshotProjectSchema,
  type SnapshotSuite,
  SnapshotSuiteSchema,
} from "./snapshot.js";
import { SyncRemoteError } from "./types.js";

/** Per-file cap on snapshot blobs (trust boundary: remote content). */
const MAX_SNAPSHOT_BLOB = 1024 * 1024;

/**
 * Parse one snapshot file from untrusted bytes. Returns null for paths
 * outside the three known shapes (attackers' extra files are ignored).
 */
function parseSnapshotBlob(relPath: string): { kind: string; id: string } | null {
  if (relPath === "project.json") {
    return { kind: "project", id: "" };
  }
  const match = /^(suites|cases)\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.json$/.exec(relPath);
  if (match === null) {
    return null;
  }
  const [, dir, id] = match;
  if (dir === undefined || id === undefined) {
    return null;
  }
  return { kind: dir === "suites" ? "suite" : "case", id };
}

export async function readSnapshotFromTree(gitdir: string, commitOid: string): Promise<Snapshot> {
  const { commit } = await git.readCommit({ fs, gitdir, oid: commitOid });
  const files = await listTreeFiles(gitdir, commit.tree);
  const suites: Record<string, SnapshotSuite> = {};
  const cases: Record<string, SnapshotCase> = {};
  let project: SnapshotProject | null = null;
  for (const file of files) {
    const slot = parseSnapshotBlob(file.path);
    if (slot === null) {
      continue;
    }
    const content = await readBlobText(gitdir, file.oid);
    const raw: unknown = JSON.parse(content);
    if (slot.kind === "project") {
      project = SnapshotProjectSchema.parse(raw);
    } else if (slot.kind === "suite") {
      const suite = SnapshotSuiteSchema.parse(raw);
      suites[suite.id] = suite;
    } else {
      const c = SnapshotCaseSchema.parse(raw);
      cases[c.id] = c;
    }
  }
  if (project === null) {
    throw new SyncRemoteError("snapshot has no project.json (corrupt remote)");
  }
  return { project, suites, cases };
}

/** Tree listing as path -> blob oid pairs. */
type TreeListing = Array<{ path: string; oid: string }>;

async function listTreeFiles(gitdir: string, treeOid: string, prefix = ""): Promise<TreeListing> {
  const { tree } = await git.readTree({ fs, gitdir, oid: treeOid });
  const out: TreeListing = [];
  for (const entry of tree) {
    const rel = prefix === "" ? entry.path : `${prefix}/${entry.path}`;
    if (entry.type === "tree") {
      out.push(...(await listTreeFiles(gitdir, entry.oid, rel)));
    } else {
      out.push({ path: rel, oid: entry.oid });
    }
  }
  return out;
}

async function readBlobText(gitdir: string, oid: string): Promise<string> {
  const { blob } = await git.readBlob({ fs, gitdir, oid });
  if (blob.length > MAX_SNAPSHOT_BLOB) {
    throw new SyncRemoteError(`snapshot file too large: ${oid}`);
  }
  return Buffer.from(blob).toString("utf8");
}
