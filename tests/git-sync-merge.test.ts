import { describe, expect, it } from "vitest";

import {
  SnapshotCaseSchema,
  mergeEntity,
  snapshotHash,
  type Snapshot,
  type SnapshotCase,
} from "../src/main/git-sync.js";

function snapshotWithName(name: string): Snapshot {
  return {
    project: { id: "p1", name },
    suites: {},
    cases: {},
  };
}

/** Minimal snapshot case; `profile` is optional (pre-M14 snapshots lack it). */
function snapCase(profile?: SnapshotCase["profile"]): SnapshotCase {
  return {
    id: "c1",
    name: "Login",
    steps: [],
    testData: {},
    ...(profile !== undefined ? { profile } : {}),
  };
}

function snapshotWithCase(c: SnapshotCase): Snapshot {
  return { project: { id: "p1", name: "quest" }, suites: {}, cases: { [c.id]: c } };
}

describe("snapshotHash", () => {
  it("is stable regardless of key insertion order", () => {
    const a = snapshotWithName("quest");
    const b: Snapshot = {
      project: { name: "quest", id: "p1" },
      cases: {},
      suites: {},
    };
    expect(snapshotHash(a)).toBe(snapshotHash(b));
  });

  it("changes when content changes", () => {
    expect(snapshotHash(snapshotWithName("a"))).not.toBe(snapshotHash(snapshotWithName("b")));
  });
});

describe("mergeEntity", () => {
  it("takes the remote add when only remote added", () => {
    expect(mergeEntity({ local: undefined, remote: { v: 1 } })).toEqual({
      kind: "take-remote",
    });
  });

  it("keeps local when only local added", () => {
    expect(mergeEntity({ base: undefined, local: { v: 1 }, remote: undefined })).toEqual({
      kind: "keep-local",
    });
  });

  it("conflicts when both sides add differently", () => {
    expect(mergeEntity({ base: undefined, local: { v: 1 }, remote: { v: 2 } })).toEqual({
      kind: "conflict",
    });
  });

  it("keeps local when both sides add identically", () => {
    expect(mergeEntity({ base: undefined, local: { v: 1 }, remote: { v: 1 } })).toEqual({
      kind: "keep-local",
    });
  });

  it("takes remote when only remote changed", () => {
    expect(mergeEntity({ base: { v: 0 }, local: { v: 0 }, remote: { v: 2 } })).toEqual({
      kind: "take-remote",
    });
  });

  it("keeps local when only local changed", () => {
    expect(mergeEntity({ base: { v: 0 }, local: { v: 1 }, remote: { v: 0 } })).toEqual({
      kind: "keep-local",
    });
  });

  it("conflicts when both sides changed differently", () => {
    expect(mergeEntity({ base: { v: 0 }, local: { v: 1 }, remote: { v: 2 } })).toEqual({
      kind: "conflict",
    });
  });

  it("deletes when local unchanged and remote deleted", () => {
    expect(mergeEntity({ base: { v: 0 }, local: { v: 0 }, remote: undefined })).toEqual({
      kind: "delete-remote",
    });
  });

  it("conflicts when local changed and remote deleted", () => {
    expect(mergeEntity({ base: { v: 0 }, local: { v: 1 }, remote: undefined })).toEqual({
      kind: "conflict",
    });
  });
});

describe("SnapshotCaseSchema: profile is optional and untrusted", () => {
  it("parses a pre-M14 snapshot case with no profile field", () => {
    const parsed = SnapshotCaseSchema.parse({ id: "c1", name: "Login", steps: [], testData: {} });
    expect(parsed.profile).toBeUndefined();
  });

  it("parses a profile on a snapshot case", () => {
    const parsed = SnapshotCaseSchema.parse({
      id: "c1",
      name: "Login",
      steps: [],
      testData: {},
      profile: {
        device: "Desktop Chrome",
        viewportW: 1440,
        viewportH: 900,
        locale: "en-GB",
        storageState: "login.json",
        saveStorageState: "saved.json",
        dialogPolicy: "accept",
      },
    });
    expect(parsed.profile).toEqual({
      device: "Desktop Chrome",
      viewportW: 1440,
      viewportH: 900,
      locale: "en-GB",
      storageState: "login.json",
      saveStorageState: "saved.json",
      dialogPolicy: "accept",
    });
  });

  it("rejects a profile with a path-escaping filename or out-of-range viewport", () => {
    expect(() =>
      SnapshotCaseSchema.parse({
        id: "c1",
        name: "Login",
        steps: [],
        testData: {},
        profile: { storageState: "../../etc/passwd" },
      }),
    ).toThrow();
    expect(() =>
      SnapshotCaseSchema.parse({
        id: "c1",
        name: "Login",
        steps: [],
        testData: {},
        profile: { viewportW: 1 },
      }),
    ).toThrow();
  });
});

describe("mergeEntity: profile is part of the case entity", () => {
  it("takes the remote when only the remote changed the profile", () => {
    expect(
      mergeEntity({
        base: snapCase({ locale: "en-US" }),
        local: snapCase({ locale: "en-US" }),
        remote: snapCase({ locale: "en-GB" }),
      }),
    ).toEqual({ kind: "take-remote" });
  });

  it("keeps local when only local changed the profile", () => {
    expect(
      mergeEntity({
        base: snapCase({ locale: "en-US" }),
        local: snapCase({ locale: "fr-FR" }),
        remote: snapCase({ locale: "en-US" }),
      }),
    ).toEqual({ kind: "keep-local" });
  });

  it("conflicts when both sides changed the profile differently", () => {
    expect(
      mergeEntity({
        base: snapCase({ locale: "en-US" }),
        local: snapCase({ locale: "fr-FR" }),
        remote: snapCase({ locale: "de-DE" }),
      }),
    ).toEqual({ kind: "conflict" });
  });

  it("treats a profile-only edit as a real case change (hash moves)", () => {
    expect(snapshotHash(snapshotWithCase(snapCase({ storageState: "a.json" })))).not.toBe(
      snapshotHash(snapshotWithCase(snapCase())),
    );
  });
});
