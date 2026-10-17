import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { caseRuns, suiteRuns } from "../src/main/schema.js";
import { createDatabase } from "../src/main/db.js";
import type { AppDatabase } from "../src/main/db.js";
import { createCase, getCase, updateCase } from "../src/main/ipc-cases.js";
import { createProject, getProject, updateProject } from "../src/main/ipc-projects.js";
import { getTestData, listSteps, setTestData, upsertStep } from "../src/main/ipc-steps.js";
import {
  createSuite,
  getSuite,
  getSuiteCaseIds,
  listSuites,
  setSuiteCases,
  updateSuite,
} from "../src/main/ipc-suites.js";

/**
 * Phase 2 acceptance test (git sync panel) — written FIRST, currently RED.
 *
 * Covers the full two-machine loop against a hermetic "central" bare repo
 * (local path remote, no network): machine A commits + pushes, machine B
 * clones and sees identical entities with STABLE ids, both sides edit,
 * non-overlapping entities auto-merge, same-entity edits surface as
 * entity-level conflicts (never silent overwrites), branches round-trip,
 * and unreachable remotes fail cleanly. Runs/artifacts are never synced.
 *
 * Opt-in like the other e2e suites (no browser needed here, but it touches
 * real git repos on disk, so it stays out of the default run):
 *
 *   PLAYTEST_E2E=1 npx vitest run tests/e2e-git-sync.test.ts
 *
 * THE CONTRACT UNDER TEST (proposed `src/main/git-sync.ts` surface — the
 * Phase 2 implementation must provide it; the local interfaces below mirror
 * it so this file typechecks while the module is missing):
 * - initSyncRepo({db, projectId, dir, remoteUrl?, author, branch?}): snapshot
 *   the project into `dir` as git-committable JSON and commit it.
 * - syncCommit({db, projectId, dir, author, message}): re-snapshot + commit;
 *   returns the touched entity ids.
 * - syncPush({dir, remote?, branch?}): push current branch; rejects when the
 *   remote has diverged (non-fast-forward) or is unreachable.
 * - syncPull({db, projectId, dir, remote?, branch?}): fetch + entity-level
 *   merge into the db; different entities auto-merge, same-entity double
 *   edits come back as conflicts with the local version kept.
 * - cloneSyncRepo({db, remoteUrl, dir, branch?}): clone + materialise the
 *   snapshot as a project with the SAME entity ids (stable ids — this is
 *   what makes pull idempotent; contrast transfer.ts copy semantics).
 * - createSyncBranch({dir, name}): create + check out a branch.
 * - syncStatus({db, projectId, dir}): branch / ahead / behind / dirty.
 * - resolveSyncConflict({db, projectId, dir, entity, id, winner}): apply
 *   "mine" | "theirs" for one conflicted entity.
 */

// --- Proposed product contract (delete once src/main/git-sync.ts exists) ----
interface SyncAuthor {
  name: string;
  email: string;
}
interface SyncCommitResult {
  hash: string;
  changed: string[];
}
interface SyncConflict {
  entity: "project" | "suite" | "case";
  id: string;
  name: string;
}
interface SyncPullResult {
  applied: string[];
  conflicts: SyncConflict[];
}
interface SyncStatus {
  branch: string;
  ahead: number;
  behind: number;
  dirty: boolean;
}
interface GitSyncModule {
  initSyncRepo(args: {
    db: AppDatabase;
    projectId: string;
    dir: string;
    remoteUrl?: string;
    author: SyncAuthor;
    branch?: string;
  }): Promise<{ hash: string }>;
  syncCommit(args: {
    db: AppDatabase;
    projectId: string;
    dir: string;
    author: SyncAuthor;
    message: string;
  }): Promise<SyncCommitResult>;
  syncPush(args: { dir: string; remote?: string; branch?: string }): Promise<void>;
  syncPull(args: {
    db: AppDatabase;
    projectId: string;
    dir: string;
    remote?: string;
    branch?: string;
  }): Promise<SyncPullResult>;
  cloneSyncRepo(args: {
    db: AppDatabase;
    remoteUrl: string;
    dir: string;
    branch?: string;
  }): Promise<{ projectId: string }>;
  createSyncBranch(args: { dir: string; name: string }): Promise<void>;
  syncStatus(args: { db: AppDatabase; projectId: string; dir: string }): Promise<SyncStatus>;
  resolveSyncConflict(args: {
    db: AppDatabase;
    projectId: string;
    dir: string;
    entity: "case" | "suite";
    id: string;
    winner: "mine" | "theirs";
  }): Promise<void>;
}
// -----------------------------------------------------------------------------

const describeE2E = describe.skipIf(!process.env.PLAYTEST_E2E);

const execFileAsync = promisify(execFile);

async function gitCentral(central: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["--git-dir", central, ...args]);
  return stdout;
}

const ADA: SyncAuthor = { name: "Ada", email: "ada@example.com" };
const BEN: SyncAuthor = { name: "Ben", email: "ben@example.com" };

describeE2E("e2e git sync: two machines, one central repo", () => {
  let scratch: string;
  let central: string;
  let dirA: string;
  let dirB: string;
  let dirC: string;
  let dbA: AppDatabase;
  let dbB: AppDatabase;
  let closeA: () => void;
  let closeB: () => void;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "e2e-git-sync-"));
    central = join(scratch, "central.git");
    await execFileAsync("git", ["init", "--bare", "-b", "main", central]);
    dirA = join(scratch, "machine-a");
    dirB = join(scratch, "machine-b");
    dirC = join(scratch, "machine-c");
    const handleA = createDatabase(":memory:");
    const handleB = createDatabase(":memory:");
    dbA = handleA.db;
    dbB = handleB.db;
    closeA = handleA.close;
    closeB = handleB.close;
  });

  afterAll(() => {
    closeA();
    closeB();
  });

  it("commit -> push -> clone -> edit -> merge -> conflict -> branch", async () => {
    // @ts-expect-error — src/main/git-sync.ts is Phase 2 work and does not
    // exist yet (this test is red until it lands). Delete this suppression
    // and the local GitSyncModule interface above, then import real types.
    const sync = (await import("../src/main/git-sync.js")) as unknown as GitSyncModule;

    // --- Machine A builds a project (definitions + KV only; never run) ---
    const projectA = createProject(dbA, { name: "Shop", baseUrl: "http://127.0.0.1:9/" });
    const suiteA = createSuite(dbA, { projectId: projectA.id, name: "Smoke" });
    const caseA = createCase(dbA, {
      projectId: projectA.id,
      name: "Checkout",
      url: "http://127.0.0.1:9/",
    });
    setTestData(dbA, { caseId: caseA.id, data: { base: "http://127.0.0.1:9", customer: "Ada" } });
    upsertStep(dbA, { caseId: caseA.id, step: { order: 0, action: "goto", value: "{{base}}/" } });
    upsertStep(dbA, {
      caseId: caseA.id,
      step: { order: 1, action: "assert-visible", selector: "h1" },
    });
    setSuiteCases(dbA, suiteA.id, [caseA.id]);

    // --- A commits locally, then pushes to central ---
    await sync.initSyncRepo({
      db: dbA,
      projectId: projectA.id,
      dir: dirA,
      remoteUrl: central,
      author: ADA,
      branch: "main",
    });
    const statusBefore = await sync.syncStatus({ db: dbA, projectId: projectA.id, dir: dirA });
    expect(statusBefore).toMatchObject({ branch: "main", behind: 0, dirty: false });
    expect(statusBefore.ahead).toBeGreaterThanOrEqual(1);
    await sync.syncPush({ dir: dirA });
    const statusAfter = await sync.syncStatus({ db: dbA, projectId: projectA.id, dir: dirA });
    expect(statusAfter).toMatchObject({ ahead: 0, behind: 0, dirty: false });

    // Central holds committable entity JSON — and no runs or artifacts.
    const log = await gitCentral(central, ["log", "--format=%s", "main"]);
    expect(log.trim().length).toBeGreaterThan(0);
    const tracked = await gitCentral(central, ["ls-tree", "-r", "--name-only", "main"]);
    const files = tracked.split("\n").filter((f) => f.length > 0);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.endsWith(".json")).toBe(true);
      expect(f.toLowerCase()).not.toMatch(/run|artifact|video|trace|screenshot/);
    }

    // --- Machine B clones: identical entities, STABLE ids ---
    const cloned = await sync.cloneSyncRepo({ db: dbB, remoteUrl: central, dir: dirB });
    expect(cloned.projectId).toBe(projectA.id);
    expect(getProject(dbB, cloned.projectId).name).toBe("Shop");
    const suitesB = listSuites(dbB, cloned.projectId);
    expect(suitesB.map((s) => s.name)).toEqual(["Smoke"]);
    const suiteB = suitesB.find((s) => s.name === "Smoke");
    if (suiteB === undefined) throw new Error("expected cloned suite Smoke");
    expect(suiteB.id).toBe(suiteA.id);
    expect(getSuiteCaseIds(dbB, suiteB.id)).toEqual([caseA.id]);
    const caseB = getCase(dbB, caseA.id);
    expect(caseB.name).toBe("Checkout");
    expect(listSteps(dbB, caseA.id).map((s) => [s.order, s.action, s.selector, s.value])).toEqual([
      [0, "goto", undefined, "{{base}}/"],
      [1, "assert-visible", "h1", undefined],
    ]);
    expect(getTestData(dbB, { caseId: caseA.id })).toEqual({
      base: "http://127.0.0.1:9",
      customer: "Ada",
    });
    // Nothing ran anywhere: no run rows synced.
    expect(dbB.select().from(suiteRuns).all()).toEqual([]);
    expect(dbB.select().from(caseRuns).all()).toEqual([]);
    const statusB = await sync.syncStatus({ db: dbB, projectId: cloned.projectId, dir: dirB });
    expect(statusB).toMatchObject({ branch: "main", ahead: 0, behind: 0, dirty: false });

    // --- B edits the case, commits, pushes; A pulls and sees it ---
    updateCase(dbB, { id: caseA.id, description: "extended by Ben" });
    upsertStep(dbB, {
      caseId: caseA.id,
      step: { order: 2, action: "assert-text", selector: "h1", value: "Shop" },
    });
    const commitB = await sync.syncCommit({
      db: dbB,
      projectId: cloned.projectId,
      dir: dirB,
      author: BEN,
      message: "extend checkout",
    });
    expect(commitB.changed).toContain(caseA.id);
    await sync.syncPush({ dir: dirB });
    const pullA = await sync.syncPull({ db: dbA, projectId: projectA.id, dir: dirA });
    expect(pullA.conflicts).toEqual([]);
    expect(pullA.applied).toContain(caseA.id);
    expect(getCase(dbA, caseA.id).description).toBe("extended by Ben");
    expect(listSteps(dbA, caseA.id).length).toBe(3);

    // --- Divergent edits to DIFFERENT entities auto-merge ---
    updateSuite(dbA, { id: suiteA.id, name: "Smoke v2" });
    await sync.syncCommit({
      db: dbA,
      projectId: projectA.id,
      dir: dirA,
      author: ADA,
      message: "rename suite",
    });
    updateProject(dbB, { id: cloned.projectId, name: "Shop v2" });
    await sync.syncCommit({
      db: dbB,
      projectId: cloned.projectId,
      dir: dirB,
      author: BEN,
      message: "rename project",
    });
    await sync.syncPush({ dir: dirB });
    // A is behind now: push must be rejected, not force-pushed.
    await expect(sync.syncPush({ dir: dirA })).rejects.toThrow();
    const mergePull = await sync.syncPull({ db: dbA, projectId: projectA.id, dir: dirA });
    expect(mergePull.conflicts).toEqual([]);
    // Both renames survive: theirs applied, mine kept.
    expect(getProject(dbA, projectA.id).name).toBe("Shop v2");
    expect(getSuite(dbA, suiteA.id).name).toBe("Smoke v2");
    await sync.syncPush({ dir: dirA });
    const catchUp = await sync.syncPull({ db: dbB, projectId: cloned.projectId, dir: dirB });
    expect(catchUp.conflicts).toEqual([]);
    expect(getSuite(dbB, suiteA.id).name).toBe("Smoke v2");

    // --- Same-entity double edit surfaces an entity-level conflict ---
    const stepA0 = listSteps(dbA, caseA.id).find((s) => s.order === 0);
    const stepB0 = listSteps(dbB, caseA.id).find((s) => s.order === 0);
    if (stepA0 === undefined || stepB0 === undefined) throw new Error("expected step 0");
    const { upsertStep: upsert } = await import("../src/main/ipc-steps.js");
    upsert(dbA, {
      caseId: caseA.id,
      step: { id: stepA0.id, order: 0, action: stepA0.action, selector: "#a" },
    });
    upsert(dbB, {
      caseId: caseA.id,
      step: { id: stepB0.id, order: 0, action: stepB0.action, selector: "#b" },
    });
    await sync.syncCommit({
      db: dbA,
      projectId: projectA.id,
      dir: dirA,
      author: ADA,
      message: "selector a",
    });
    await sync.syncCommit({
      db: dbB,
      projectId: cloned.projectId,
      dir: dirB,
      author: BEN,
      message: "selector b",
    });
    await sync.syncPush({ dir: dirA });
    await expect(sync.syncPush({ dir: dirB })).rejects.toThrow();
    const conflictPull = await sync.syncPull({ db: dbB, projectId: cloned.projectId, dir: dirB });
    expect(conflictPull.conflicts).toMatchObject([{ entity: "case", id: caseA.id }]);
    // No silent overwrite: B keeps its own version until it resolves.
    const kept = listSteps(dbB, caseA.id).find((s) => s.order === 0);
    expect(kept?.selector).toBe("#b");
    await sync.resolveSyncConflict({
      db: dbB,
      projectId: cloned.projectId,
      dir: dirB,
      entity: "case",
      id: caseA.id,
      winner: "theirs",
    });
    const resolved = listSteps(dbB, caseA.id).find((s) => s.order === 0);
    expect(resolved?.selector).toBe("#a");
    await sync.syncCommit({
      db: dbB,
      projectId: cloned.projectId,
      dir: dirB,
      author: BEN,
      message: "resolve: take theirs",
    });
    await sync.syncPush({ dir: dirB });
    const cleanPull = await sync.syncPull({ db: dbA, projectId: projectA.id, dir: dirA });
    expect(cleanPull.conflicts).toEqual([]);
    const finalA = listSteps(dbA, caseA.id).find((s) => s.order === 0);
    expect(finalA?.selector).toBe("#a");

    // --- Branch round-trip: A publishes redesign, C clones it directly ---
    await sync.createSyncBranch({ dir: dirA, name: "redesign" });
    const branchStatus = await sync.syncStatus({ db: dbA, projectId: projectA.id, dir: dirA });
    expect(branchStatus.branch).toBe("redesign");
    updateSuite(dbA, { id: suiteA.id, name: "Smoke redesign" });
    await sync.syncCommit({
      db: dbA,
      projectId: projectA.id,
      dir: dirA,
      author: ADA,
      message: "redesign suite",
    });
    await sync.syncPush({ dir: dirA });
    const clonedC = await sync.cloneSyncRepo({
      db: dbA,
      remoteUrl: central,
      dir: dirC,
      branch: "redesign",
    });
    const suitesC = listSuites(dbA, clonedC.projectId);
    expect(suitesC.map((s) => s.name)).toContain("Smoke redesign");

    // --- Unreachable remote fails cleanly (no hang, no partial state) ---
    await expect(
      sync.syncPush({ dir: dirA, remote: join(scratch, "no-such-remote.git") }),
    ).rejects.toThrow();

    // Evidence listing (printed for the human log)
    console.log(
      JSON.stringify(
        {
          scratch,
          centralLog: (await gitCentral(central, ["log", "--format=%s", "main"]))
            .split("\n")
            .filter((l) => l.length > 0),
          branches: (await gitCentral(central, ["branch", "--list"]))
            .split("\n")
            .map((b) => b.trim()),
        },
        null,
        2,
      ),
    );
  }, 120_000);
});
