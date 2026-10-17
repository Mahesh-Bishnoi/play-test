import fs from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";
import * as git from "isomorphic-git";
import { z } from "zod";

import { ExportStepSchema } from "../shared/export-format.js";
import type { AppDatabase } from "./db.js";
import { deleteCase, getCase, listCases } from "./ipc-cases.js";
import { getProject, updateProject } from "./ipc-projects.js";
import { getTestData, listSteps } from "./ipc-steps.js";
import { deleteSuite, getSuite, listSuites, updateSuite } from "./ipc-suites.js";
import { projects, suiteTestCases, testCases, testData, testSteps, testSuites } from "./schema.js";

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

// --- Snapshot types ----------------------------------------------------------

const SnapshotStepSchema = ExportStepSchema.extend({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "unsafe step id"),
});
type SnapshotStep = z.infer<typeof SnapshotStepSchema>;

const SnapshotCaseSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "unsafe case id"),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional(),
  url: z.string().trim().max(2000).optional(),
  steps: z.array(SnapshotStepSchema).max(5000),
  testData: z
    .record(z.string().regex(/^\w+$/, "key must match \\w+"), z.string().max(10000))
    .default({}),
});
export type SnapshotCase = z.infer<typeof SnapshotCaseSchema>;

const SnapshotSuiteSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "unsafe suite id"),
  name: z.string().trim().min(1).max(200),
  memberCaseIds: z
    .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "unsafe member id"))
    .max(1000),
});
export type SnapshotSuite = z.infer<typeof SnapshotSuiteSchema>;

const SnapshotProjectSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "unsafe project id"),
  name: z.string().trim().min(1).max(200),
  baseUrl: z.string().trim().max(2000).optional(),
});
export type SnapshotProject = z.infer<typeof SnapshotProjectSchema>;

export interface Snapshot {
  project: SnapshotProject;
  suites: Record<string, SnapshotSuite>;
  cases: Record<string, SnapshotCase>;
}

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
interface StoredConflict extends SyncConflict {
  theirs: SnapshotCase | SnapshotSuite;
}

const CONFLICTS_FILE = "playtest-conflicts.json";
const CONFLICTS_VERSION = 1;
/** Per-file cap on snapshot blobs (trust boundary: remote content). */
const MAX_SNAPSHOT_BLOB = 1024 * 1024;
/** Same rule as the IPC branch-name schema — duplicated here because
 *  src/shared cannot import main-only code. */
const BRANCH_RE =
  /^(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function isValidBranchName(name: string): boolean {
  if (!BRANCH_RE.test(name)) {
    return false;
  }
  return name
    .split("/")
    .every((seg) => seg.length > 0 && seg !== "." && seg !== ".." && !seg.endsWith(".lock"));
}

// --- Canonical form (sorted keys; arrays keep order) --------------------------

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonical(v)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function snapshotHash(snapshot: Snapshot): string {
  return canonical(snapshot);
}

// --- DB <-> snapshot ----------------------------------------------------------

export function readSnapshotFromDb(db: AppDatabase, projectId: string): Snapshot {
  const project = getProject(db, projectId);
  const suites: Record<string, SnapshotSuite> = {};
  for (const suite of listSuites(db, projectId)) {
    const memberIds = db
      .select({ caseId: suiteTestCases.caseId })
      .from(suiteTestCases)
      .where(eq(suiteTestCases.suiteId, suite.id))
      .all()
      .map((r) => r.caseId);
    suites[suite.id] = { id: suite.id, name: suite.name, memberCaseIds: memberIds };
  }
  const cases: Record<string, SnapshotCase> = {};
  for (const c of listCases(db, projectId)) {
    const steps = listSteps(db, c.id).map((s) => ({
      id: s.id,
      order: s.order,
      action: s.action,
      ...(s.selector !== undefined ? { selector: s.selector } : {}),
      ...(s.value !== undefined ? { value: s.value } : {}),
      ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
    }));
    cases[c.id] = {
      id: c.id,
      name: c.name,
      ...(c.description !== undefined ? { description: c.description } : {}),
      ...(c.url !== undefined ? { url: c.url } : {}),
      steps: steps as SnapshotStep[],
      testData: getTestData(db, { caseId: c.id }),
    };
  }
  return {
    project: {
      id: project.id,
      name: project.name,
      ...(project.baseUrl !== undefined ? { baseUrl: project.baseUrl } : {}),
    },
    suites,
    cases,
  };
}

function writeSnapshotFiles(dir: string, snapshot: Snapshot): void {
  fs.writeFileSync(path.join(dir, "project.json"), `${canonical(snapshot.project)}\n`);
  fs.rmSync(path.join(dir, "suites"), { recursive: true, force: true });
  fs.rmSync(path.join(dir, "cases"), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "suites"), { recursive: true });
  fs.mkdirSync(path.join(dir, "cases"), { recursive: true });
  for (const [id, suite] of Object.entries(snapshot.suites)) {
    assertSafeId(id);
    fs.writeFileSync(path.join(dir, "suites", `${id}.json`), `${canonical(suite)}\n`);
  }
  for (const [id, c] of Object.entries(snapshot.cases)) {
    assertSafeId(id);
    fs.writeFileSync(path.join(dir, "cases", `${id}.json`), `${canonical(c)}\n`);
  }
}

function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    throw new Error(`unsafe entity id in snapshot: ${id}`);
  }
}

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

async function readSnapshotFromTree(gitdir: string, commitOid: string): Promise<Snapshot> {
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

/** Insert snapshot content under an existing project id (clone, take-remote). */
function insertSnapshotContent(db: AppDatabase, snapshot: Snapshot): void {
  const now = Date.now();
  const projectId = snapshot.project.id;
  getProject(db, projectId);
  for (const c of Object.values(snapshot.cases)) {
    insertCaseContent(db, projectId, c, now);
  }
  for (const suite of Object.values(snapshot.suites)) {
    insertSuiteContent(db, projectId, suite, now);
  }
  updateProject(db, {
    id: projectId,
    name: snapshot.project.name,
    baseUrl: snapshot.project.baseUrl ?? null,
  });
  for (const suite of Object.values(snapshot.suites)) {
    setMembership(db, suite);
  }
}

function insertCaseContent(db: AppDatabase, projectId: string, c: SnapshotCase, now: number): void {
  try {
    getCase(db, c.id);
    throw new Error(`case already exists in this database: ${c.id}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("case already exists")) {
      throw err;
    }
  }
  db.insert(testCases)
    .values({
      id: c.id,
      projectId,
      name: c.name,
      description: c.description ?? null,
      url: c.url ?? null,
      createdAt: now,
    })
    .run();
  c.steps
    .slice()
    .sort((a, b) => a.order - b.order)
    .forEach((step, index) => {
      db.insert(testSteps)
        .values({
          id: step.id,
          caseId: c.id,
          order: index,
          action: step.action,
          selector: step.selector ?? null,
          value: step.value ?? null,
          timeoutMs: step.timeoutMs ?? null,
          editedAt: now,
        })
        .run();
    });
  for (const [key, value] of Object.entries(c.testData)) {
    db.insert(testData).values({ caseId: c.id, key, value }).run();
  }
}

function insertSuiteContent(
  db: AppDatabase,
  projectId: string,
  suite: SnapshotSuite,
  now: number,
): void {
  try {
    getSuite(db, suite.id);
    throw new Error(`suite already exists in this database: ${suite.id}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("suite already exists")) {
      throw err;
    }
  }
  db.insert(testSuites).values({ id: suite.id, projectId, name: suite.name, createdAt: now }).run();
}

function setMembership(db: AppDatabase, suite: SnapshotSuite): void {
  const members = [...new Set(suite.memberCaseIds)];
  for (const caseId of members) {
    getCase(db, caseId);
  }
  db.delete(suiteTestCases).where(eq(suiteTestCases.suiteId, suite.id)).run();
  for (const caseId of members) {
    db.insert(suiteTestCases).values({ suiteId: suite.id, caseId }).run();
  }
}

// --- Local repo helpers -------------------------------------------------------

function gitdirOf(dir: string): string {
  return path.join(dir, ".git");
}

function assertSyncDir(dir: string): void {
  if (!fs.existsSync(path.join(gitdirOf(dir), "HEAD"))) {
    throw new SyncRemoteError(`not a sync repo (no .git/HEAD): ${dir}`);
  }
}

async function currentBranchName(dir: string): Promise<string> {
  const branch = await git.currentBranch({ fs, dir });
  if (branch === undefined || typeof branch !== "string") {
    throw new Error("sync repo has a detached HEAD — check out a branch first");
  }
  return branch;
}

async function resolveLocalRef(dir: string, ref: string): Promise<string | undefined> {
  try {
    return await git.resolveRef({ fs, dir, ref });
  } catch {
    return undefined;
  }
}

/** Resolve a local-path remote: explicit opt, else origin, never http(s). */
async function resolveRemotePath(dir: string, remoteOpt?: string): Promise<string> {
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

async function resolveRemoteRef(remoteGitdir: string, branch: string): Promise<string | undefined> {
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
function copyGitObjects(srcGitdir: string, dstGitdir: string): void {
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

async function ancestorOids(gitdir: string, headOid: string, cap = 10000): Promise<Set<string>> {
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
async function mergeBase(
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

// --- Conflicts file ------------------------------------------------------------

function conflictsPath(dir: string): string {
  return path.join(gitdirOf(dir), CONFLICTS_FILE);
}

function readConflicts(dir: string): StoredConflict[] {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(conflictsPath(dir), "utf8"));
    if (typeof raw !== "object" || raw === null) {
      return [];
    }
    const list = (raw as { conflicts?: unknown }).conflicts;
    if (!Array.isArray(list)) {
      return [];
    }
    return list.filter(
      (c): c is StoredConflict =>
        typeof c === "object" &&
        c !== null &&
        ((c as StoredConflict).entity === "case" || (c as StoredConflict).entity === "suite") &&
        typeof (c as StoredConflict).id === "string" &&
        typeof (c as StoredConflict).theirs === "object",
    );
  } catch {
    return [];
  }
}

function writeConflicts(dir: string, conflicts: StoredConflict[]): void {
  fs.writeFileSync(
    conflictsPath(dir),
    `${JSON.stringify({ version: CONFLICTS_VERSION, conflicts })}\n`,
  );
}

// --- Three-way entity merge -----------------------------------------------------

type MergeOutcome =
  | { kind: "take-remote" }
  | { kind: "delete-remote" }
  | { kind: "keep-local" }
  | { kind: "conflict" };

function mergeEntity<T>(slots: { base?: T; local?: T; remote?: T }): MergeOutcome {
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
  const workTreeHead = path.join(remotePath, ".git", "HEAD");
  if (fs.existsSync(workTreeHead)) {
    const target = fs.readFileSync(workTreeHead, "utf8").trim();
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
  const pending = readConflicts(opts.dir).map(({ entity, id, name }) => ({ entity, id, name }));
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
  const conflicts: StoredConflict[] = readConflicts(opts.dir);
  const conflictIds = new Set(conflicts.map((c) => `${c.entity}:${c.id}`));
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
    } else if (outcome.kind === "conflict" && remote !== undefined) {
      if (!conflictIds.has(`case:${id}`)) {
        conflicts.push({
          entity: "case",
          id,
          name: (localSnap.cases[id] ?? remote).name,
          theirs: remote,
        });
        conflictIds.add(`case:${id}`);
      }
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
    } else if (outcome.kind === "conflict" && remote !== undefined) {
      if (!conflictIds.has(`suite:${id}`)) {
        conflicts.push({
          entity: "suite",
          id,
          name: (localSnap.suites[id] ?? remote).name,
          theirs: remote,
        });
        conflictIds.add(`suite:${id}`);
      }
    }
  }
  applyMergedToDb(db, projectId, merged, casesToDelete, suitesToDelete);
  writeConflicts(opts.dir, conflicts);
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
    conflicts: conflicts.map(({ entity, id, name }) => ({ entity, id, name })),
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
  const now = Date.now();
  for (const id of casesToDelete) {
    try {
      deleteCase(db, id);
    } catch {
      // Already gone locally — merged state already holds.
    }
  }
  for (const id of suitesToDelete) {
    try {
      deleteSuite(db, id);
    } catch {
      // Already gone locally — merged state already holds.
    }
  }
  for (const c of Object.values(merged.cases)) {
    SnapshotCaseSchema.parse(c);
    try {
      getCase(db, c.id);
      db.delete(testSteps).where(eq(testSteps.caseId, c.id)).run();
      db.delete(testData).where(eq(testData.caseId, c.id)).run();
      db.delete(testCases).where(eq(testCases.id, c.id)).run();
    } catch {
      // New locally — insert below.
    }
    insertCaseContent(db, projectId, c, now);
  }
  for (const suite of Object.values(merged.suites)) {
    SnapshotSuiteSchema.parse(suite);
    for (const memberId of suite.memberCaseIds) {
      if (merged.cases[memberId] === undefined) {
        throw new SyncRemoteError(`suite ${suite.id} references unknown case ${memberId}`);
      }
    }
    try {
      getSuite(db, suite.id);
      updateSuite(db, { id: suite.id, name: suite.name });
    } catch {
      insertSuiteContent(db, projectId, suite, now);
    }
    setMembership(db, suite);
  }
  updateProject(db, {
    id: projectId,
    name: merged.project.name,
    baseUrl: merged.project.baseUrl ?? null,
  });
}

export async function resolveSyncConflict(
  db: AppDatabase,
  projectId: string,
  opts: { dir: string; entity: "case" | "suite"; id: string; winner: "mine" | "theirs" },
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
    if (conflict.entity === "case") {
      const c = SnapshotCaseSchema.parse(conflict.theirs);
      try {
        getCase(db, c.id);
        db.delete(testSteps).where(eq(testSteps.caseId, c.id)).run();
        db.delete(testData).where(eq(testData.caseId, c.id)).run();
        db.delete(testCases).where(eq(testCases.id, c.id)).run();
      } catch {
        // Deleted locally — reinsert below.
      }
      insertCaseContent(db, projectId, c, now);
    } else {
      const suite = SnapshotSuiteSchema.parse(conflict.theirs);
      try {
        getSuite(db, suite.id);
        updateSuite(db, { id: suite.id, name: suite.name });
      } catch {
        insertSuiteContent(db, projectId, suite, now);
      }
      setMembership(db, suite);
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
  db.insert(projects)
    .values({
      id: snapshot.project.id,
      name: snapshot.project.name,
      baseUrl: snapshot.project.baseUrl ?? null,
      createdAt: now,
    })
    .run();
  insertSnapshotContent(db, snapshot);
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
      // Diverged or behind: count tracking-side commits unknown locally.
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

async function defaultAuthor(dir: string): Promise<SyncAuthor> {
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
