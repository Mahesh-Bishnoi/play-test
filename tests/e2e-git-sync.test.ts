import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { caseRuns, suiteRuns } from "../src/main/schema.js";
import { createDatabase } from "../src/main/db.js";
import type { AppDatabase } from "../src/main/db.js";
import {
  cloneSyncRepo,
  createSyncBranch,
  initSyncRepo,
  resolveSyncConflict,
  syncCommit,
  syncPull,
  syncPush,
  syncStatus,
} from "../src/main/git-sync/sync.js";
import type { SyncAuthor } from "../src/main/git-sync/types.js";
import { createCase, deleteCase, getCase, updateCase } from "../src/main/ipc-cases.js";
import { getCaseProfile, setCaseProfile } from "../src/main/ipc-profiles.js";
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
 * Phase 2 acceptance test (git sync core) — the full two-machine loop
 * against a hermetic "central" bare repo (local path remote, no network):
 * machine A commits + pushes, machine B clones and sees identical entities
 * with STABLE ids, both sides edit, non-overlapping entities auto-merge,
 * same-entity edits surface as entity-level conflicts (never silent
 * overwrites), branches round-trip, and unreachable remotes fail cleanly.
 * Runs/artifacts are never synced.
 *
 * Opt-in like the other e2e suites (touches real git repos on disk, so it
 * stays out of the default run):
 *
 *   PLAYTEST_E2E=1 npx vitest run tests/e2e-git-sync.test.ts
 */

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
  let dbC: AppDatabase;
  let closeA: () => void;
  let closeB: () => void;
  let closeC: () => void;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "e2e-git-sync-"));
    central = join(scratch, "central.git");
    await execFileAsync("git", ["init", "--bare", "-b", "main", central]);
    dirA = join(scratch, "machine-a");
    dirB = join(scratch, "machine-b");
    dirC = join(scratch, "machine-c");
    const handleA = createDatabase(":memory:");
    const handleB = createDatabase(":memory:");
    const handleC = createDatabase(":memory:");
    dbA = handleA.db;
    dbB = handleB.db;
    dbC = handleC.db;
    closeA = handleA.close;
    closeB = handleB.close;
    closeC = handleC.close;
  });

  afterAll(() => {
    closeA();
    closeB();
    closeC();
  });

  it("commit -> push -> clone -> edit -> merge -> conflict -> branch", async () => {
    // --- Machine A builds a project (definitions + KV only; never run) ---
    const projectA = createProject(dbA, { name: "Shop", baseUrl: "http://127.0.0.1:9/" });
    const suiteA = createSuite(dbA, { projectId: projectA.id, name: "Smoke" });
    const caseA = createCase(dbA, {
      projectId: projectA.id,
      name: "Checkout",
      url: "http://127.0.0.1:9/",
    });
    setTestData(dbA, { caseId: caseA.id, data: { base: "http://127.0.0.1:9", customer: "Ada" } });
    setCaseProfile(dbA, caseA.id, {
      device: "Desktop Chrome",
      locale: "en-GB",
      storageState: "login.json",
      saveStorageState: "saved.json",
      dialogPolicy: "accept",
    });
    upsertStep(dbA, {
      caseId: caseA.id,
      step: { order: 0, action: "goto", value: "{{base}}/" },
    });
    upsertStep(dbA, {
      caseId: caseA.id,
      step: { order: 1, action: "assert-visible", selector: "h1" },
    });
    setSuiteCases(dbA, suiteA.id, [caseA.id]);

    // --- A commits locally, then pushes to central ---
    await initSyncRepo(dbA, projectA.id, {
      dir: dirA,
      remoteUrl: central,
      author: ADA,
      branch: "main",
    });
    const statusBefore = await syncStatus(dbA, projectA.id, dirA);
    expect(statusBefore).toMatchObject({ branch: "main", behind: 0, dirty: false });
    expect(statusBefore.ahead).toBeGreaterThanOrEqual(1);
    await syncPush({ dir: dirA });
    const statusAfter = await syncStatus(dbA, projectA.id, dirA);
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
    const cloned = await cloneSyncRepo(dbB, { remoteUrl: central, dir: dirB });
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
    // The profile is part of the case entity: it clones with stable ids.
    expect(getCaseProfile(dbB, caseA.id)).toMatchObject({
      device: "Desktop Chrome",
      locale: "en-GB",
      storageState: "login.json",
      saveStorageState: "saved.json",
      dialogPolicy: "accept",
    });
    // Nothing ran anywhere: no run rows synced.
    expect(dbB.select().from(suiteRuns).all()).toEqual([]);
    expect(dbB.select().from(caseRuns).all()).toEqual([]);
    const statusB = await syncStatus(dbB, cloned.projectId, dirB);
    expect(statusB).toMatchObject({ branch: "main", ahead: 0, behind: 0, dirty: false });

    // --- B edits the case, commits, pushes; A pulls and sees it ---
    updateCase(dbB, { id: caseA.id, description: "extended by Ben" });
    upsertStep(dbB, {
      caseId: caseA.id,
      step: { order: 2, action: "assert-text", selector: "h1", value: "Shop" },
    });
    setCaseProfile(dbB, caseA.id, { locale: "fr-FR", storageState: "login.json" });
    const commitB = await syncCommit(dbB, cloned.projectId, {
      dir: dirB,
      author: BEN,
      message: "extend checkout",
    });
    expect(commitB.changed).toContain(caseA.id);
    await syncPush({ dir: dirB });
    const pullA = await syncPull(dbA, projectA.id, { dir: dirA });
    expect(pullA.conflicts).toEqual([]);
    expect(pullA.applied).toContain(caseA.id);
    expect(getCase(dbA, caseA.id).description).toBe("extended by Ben");
    expect(listSteps(dbA, caseA.id).length).toBe(3);
    // The profile change rode along with the case entity.
    expect(getCaseProfile(dbA, caseA.id)).toMatchObject({
      locale: "fr-FR",
      storageState: "login.json",
    });

    // --- Divergent edits to DIFFERENT entities auto-merge ---
    updateSuite(dbA, { id: suiteA.id, name: "Smoke v2" });
    await syncCommit(dbA, projectA.id, {
      dir: dirA,
      author: ADA,
      message: "rename suite",
    });
    updateProject(dbB, { id: cloned.projectId, name: "Shop v2" });
    await syncCommit(dbB, cloned.projectId, {
      dir: dirB,
      author: BEN,
      message: "rename project",
    });
    await syncPush({ dir: dirB });
    // A is behind now: push must be rejected, not force-pushed.
    await expect(syncPush({ dir: dirA })).rejects.toThrow();
    const mergePull = await syncPull(dbA, projectA.id, { dir: dirA });
    expect(mergePull.conflicts).toEqual([]);
    // Both renames survive: theirs applied, mine kept.
    expect(getProject(dbA, projectA.id).name).toBe("Shop v2");
    expect(getSuite(dbA, suiteA.id).name).toBe("Smoke v2");
    await syncPush({ dir: dirA });
    const catchUp = await syncPull(dbB, cloned.projectId, { dir: dirB });
    expect(catchUp.conflicts).toEqual([]);
    expect(getSuite(dbB, suiteA.id).name).toBe("Smoke v2");

    // --- Same-entity double edit surfaces an entity-level conflict ---
    const stepA0 = listSteps(dbA, caseA.id).find((s) => s.order === 0);
    const stepB0 = listSteps(dbB, caseA.id).find((s) => s.order === 0);
    if (stepA0 === undefined || stepB0 === undefined) throw new Error("expected step 0");
    upsertStep(dbA, {
      caseId: caseA.id,
      step: { id: stepA0.id, order: 0, action: stepA0.action, selector: "#a" },
    });
    upsertStep(dbB, {
      caseId: caseA.id,
      step: { id: stepB0.id, order: 0, action: stepB0.action, selector: "#b" },
    });
    await syncCommit(dbA, projectA.id, {
      dir: dirA,
      author: ADA,
      message: "selector a",
    });
    await syncCommit(dbB, cloned.projectId, {
      dir: dirB,
      author: BEN,
      message: "selector b",
    });
    await syncPush({ dir: dirA });
    await expect(syncPush({ dir: dirB })).rejects.toThrow();
    const conflictPull = await syncPull(dbB, cloned.projectId, { dir: dirB });
    expect(conflictPull.conflicts).toMatchObject([{ entity: "case", id: caseA.id }]);
    // No silent overwrite: B keeps its own version until it resolves.
    const kept = listSteps(dbB, caseA.id).find((s) => s.order === 0);
    expect(kept?.selector).toBe("#b");
    await resolveSyncConflict(dbB, cloned.projectId, {
      dir: dirB,
      entity: "case",
      id: caseA.id,
      winner: "theirs",
    });
    const resolved = listSteps(dbB, caseA.id).find((s) => s.order === 0);
    expect(resolved?.selector).toBe("#a");
    await syncCommit(dbB, cloned.projectId, {
      dir: dirB,
      author: BEN,
      message: "resolve: take theirs",
    });
    await syncPush({ dir: dirB });
    const cleanPull = await syncPull(dbA, projectA.id, { dir: dirA });
    expect(cleanPull.conflicts).toEqual([]);
    const finalA = listSteps(dbA, caseA.id).find((s) => s.order === 0);
    expect(finalA?.selector).toBe("#a");

    // --- Branch round-trip: A publishes redesign, C clones it directly ---
    await createSyncBranch(dirA, "redesign");
    const branchStatus = await syncStatus(dbA, projectA.id, dirA);
    expect(branchStatus.branch).toBe("redesign");
    updateSuite(dbA, { id: suiteA.id, name: "Smoke redesign" });
    await syncCommit(dbA, projectA.id, {
      dir: dirA,
      author: ADA,
      message: "redesign suite",
    });
    await syncPush({ dir: dirA });
    const clonedC = await cloneSyncRepo(dbC, {
      remoteUrl: central,
      dir: dirC,
      branch: "redesign",
    });
    const suitesC = listSuites(dbC, clonedC.projectId);
    expect(suitesC.map((s) => s.name)).toContain("Smoke redesign");

    // --- Unreachable remote fails cleanly (no hang, no partial state) ---
    await expect(
      syncPush({ dir: dirA, remote: join(scratch, "no-such-remote.git") }),
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

  it("records every conflict, refreshes theirs, and applies a remote-delete merge atomically", async () => {
    const central2 = join(scratch, "central-drift.git");
    await execFileAsync("git", ["init", "--bare", "-b", "main", central2]);
    const dirA2 = join(scratch, "drift-a");
    const dirB2 = join(scratch, "drift-b");

    const project = createProject(dbA, { name: "Drift", baseUrl: "http://127.0.0.1:9/" });
    const testCase = createCase(dbA, {
      projectId: project.id,
      name: "Checkout",
      url: "http://127.0.0.1:9/",
    });
    const suite = createSuite(dbA, { projectId: project.id, name: "Smoke" });
    setSuiteCases(dbA, suite.id, [testCase.id]);

    await initSyncRepo(dbA, project.id, {
      dir: dirA2,
      remoteUrl: central2,
      author: ADA,
      branch: "main",
    });
    await syncPush({ dir: dirA2 });
    await cloneSyncRepo(dbB, { remoteUrl: central2, dir: dirB2 });

    // --- Conflict content refreshes on each pull ---
    updateCase(dbA, { id: testCase.id, description: "remote v1" });
    await syncCommit(dbA, project.id, { dir: dirA2, author: ADA, message: "v1" });
    await syncPush({ dir: dirA2 });

    updateCase(dbB, { id: testCase.id, description: "local mine" });
    await syncCommit(dbB, project.id, { dir: dirB2, author: BEN, message: "mine" });
    const first = await syncPull(dbB, project.id, { dir: dirB2 });
    expect(first.conflicts).toMatchObject([{ entity: "case", id: testCase.id }]);

    updateCase(dbA, { id: testCase.id, description: "remote v2" });
    await syncCommit(dbA, project.id, { dir: dirA2, author: ADA, message: "v2" });
    await syncPush({ dir: dirA2 });
    const second = await syncPull(dbB, project.id, { dir: dirB2 });
    expect(second.conflicts).toMatchObject([{ entity: "case", id: testCase.id }]);
    await resolveSyncConflict(dbB, project.id, {
      dir: dirB2,
      entity: "case",
      id: testCase.id,
      winner: "theirs",
    });
    // The stored `theirs` was refreshed to v2, not the stale v1.
    expect(getCase(dbB, testCase.id).description).toBe("remote v2");
    await syncCommit(dbB, project.id, { dir: dirB2, author: BEN, message: "resolve v2" });
    await syncPush({ dir: dirB2 });
    await syncPull(dbA, project.id, { dir: dirA2 });

    // --- Project conflicts are recorded, not silently kept ---
    updateProject(dbA, { id: project.id, name: "A-name" });
    await syncCommit(dbA, project.id, { dir: dirA2, author: ADA, message: "A name" });
    updateProject(dbB, { id: project.id, name: "B-name" });
    await syncCommit(dbB, project.id, { dir: dirB2, author: BEN, message: "B name" });
    await syncPush({ dir: dirA2 });
    const projectPull = await syncPull(dbB, project.id, { dir: dirB2 });
    expect(projectPull.conflicts).toMatchObject([{ entity: "project", id: project.id }]);
    await resolveSyncConflict(dbB, project.id, {
      dir: dirB2,
      entity: "project",
      id: project.id,
      winner: "theirs",
    });
    expect(getProject(dbB, project.id).name).toBe("A-name");
    await syncCommit(dbB, project.id, { dir: dirB2, author: BEN, message: "resolve project" });
    await syncPush({ dir: dirB2 });
    await syncPull(dbA, project.id, { dir: dirA2 });

    // --- Remote-delete vs local-edit is recorded (theirs = deletion) ---
    const tempCase = createCase(dbA, {
      projectId: project.id,
      name: "Temp",
      url: "http://127.0.0.1:9/temp",
    });
    setSuiteCases(dbA, suite.id, [testCase.id, tempCase.id]);
    await syncCommit(dbA, project.id, { dir: dirA2, author: ADA, message: "add temp" });
    await syncPush({ dir: dirA2 });
    await syncPull(dbB, project.id, { dir: dirB2 });

    deleteCase(dbB, tempCase.id);
    // Rename the suite locally on A so it conflicts with the remote membership
    // change; the merged snapshot still references the deleted case.
    updateSuite(dbA, { id: suite.id, name: "Smoke v2" });
    await syncCommit(dbA, project.id, { dir: dirA2, author: ADA, message: "rename + edit" });
    await syncCommit(dbB, project.id, { dir: dirB2, author: BEN, message: "delete temp" });
    await syncPush({ dir: dirB2 });

    const deletePull = await syncPull(dbA, project.id, { dir: dirA2 });
    expect(deletePull.conflicts).toMatchObject([{ entity: "suite", id: suite.id }]);
    // The pull applied cleanly (no half-merged DB): the remotely deleted case
    // is gone and the conflicting local suite's membership was filtered before
    // the apply, so no throw left the database half-changed.
    expect(() => getCase(dbA, tempCase.id)).toThrow();
    expect(getSuiteCaseIds(dbA, suite.id)).toEqual([testCase.id]);

    // --- Remote-delete vs local-edit is recorded (theirs = deletion) ---
    const central3 = join(scratch, "central-delete.git");
    await execFileAsync("git", ["init", "--bare", "-b", "main", central3]);
    const dirA3 = join(scratch, "delete-a");
    const dirB3 = join(scratch, "delete-b");
    const project3 = createProject(dbA, { name: "Delete", baseUrl: "http://127.0.0.1:9/" });
    const edited = createCase(dbA, {
      projectId: project3.id,
      name: "Edited",
      url: "http://127.0.0.1:9/edited",
    });
    await initSyncRepo(dbA, project3.id, {
      dir: dirA3,
      remoteUrl: central3,
      author: ADA,
      branch: "main",
    });
    await syncPush({ dir: dirA3 });
    await cloneSyncRepo(dbB, { remoteUrl: central3, dir: dirB3 });

    updateCase(dbA, { id: edited.id, description: "edited on A" });
    await syncCommit(dbA, project3.id, { dir: dirA3, author: ADA, message: "edit" });
    deleteCase(dbB, edited.id);
    await syncCommit(dbB, project3.id, { dir: dirB3, author: BEN, message: "delete" });
    await syncPush({ dir: dirB3 });

    const editedPull = await syncPull(dbA, project3.id, { dir: dirA3 });
    expect(editedPull.conflicts).toMatchObject([
      { entity: "case", id: edited.id, remoteDeleted: true },
    ]);
    // Local version is kept until the user resolves.
    expect(getCase(dbA, edited.id).description).toBe("edited on A");
    await resolveSyncConflict(dbA, project3.id, {
      dir: dirA3,
      entity: "case",
      id: edited.id,
      winner: "theirs",
    });
    expect(() => getCase(dbA, edited.id)).toThrow();
  }, 120_000);
});
