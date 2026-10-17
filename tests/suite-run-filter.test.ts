import { describe, expect, it } from "vitest";

import type { TestCase } from "../src/shared/schema.js";
import { filterCasesByKeyword } from "../src/renderer/components/suite-run-filter.js";

function makeCase(id: string, name: string): TestCase {
  return { id, projectId: "p1", name, createdAt: 0 };
}

const ALL = [
  makeCase("c1", "Login happy path"),
  makeCase("c2", "login with wrong password"),
  makeCase("c3", "File ITR-1 return"),
];

describe("filterCasesByKeyword (M12, PLAN §18.5)", () => {
  it("returns every case when the query is empty or blank", () => {
    expect(filterCasesByKeyword(ALL, "")).toEqual(ALL);
    expect(filterCasesByKeyword(ALL, "   ")).toEqual(ALL);
  });

  it("matches names case-insensitively", () => {
    expect(filterCasesByKeyword(ALL, "LOGIN").map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("trims surrounding whitespace before matching", () => {
    expect(filterCasesByKeyword(ALL, "  itr-1  ").map((c) => c.id)).toEqual(["c3"]);
  });

  it("matches substrings, preserving project order", () => {
    expect(filterCasesByKeyword(ALL, "in").map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterCasesByKeyword(ALL, "notice")).toEqual([]);
  });
});
