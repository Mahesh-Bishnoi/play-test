import { describe, expect, it } from "vitest";

import { sortByName } from "../src/shared/sort.js";

describe("sortByName (review N2)", () => {
  it("returns a new name-sorted array", () => {
    const input = [{ name: "beta" }, { name: "Alpha" }, { name: "gamma" }];
    expect(sortByName(input).map((x) => x.name)).toEqual(["Alpha", "beta", "gamma"]);
    expect(input.map((x) => x.name)).toEqual(["beta", "Alpha", "gamma"]);
  });
});
