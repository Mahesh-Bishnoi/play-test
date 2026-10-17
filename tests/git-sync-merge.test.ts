import { describe, expect, it } from "vitest";

import { mergeEntity, snapshotHash, type Snapshot } from "../src/main/git-sync.js";

function snapshotWithName(name: string): Snapshot {
  return {
    project: { id: "p1", name },
    suites: {},
    cases: {},
  };
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
