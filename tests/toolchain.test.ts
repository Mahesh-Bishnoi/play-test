import { describe, expect, expectTypeOf, it } from "vitest";

// Smoke test for the toolchain itself: proves vitest runs and that the
// strict flags in tsconfig.json are active. The type assertion is what makes
// the test fail when the flag is removed — `string` is not assignable to
// `string | undefined`, so `tsc` rejects this file without the flag.
describe("toolchain smoke", () => {
  it("honors noUncheckedIndexedAccess on out-of-bounds access", () => {
    const steps: string[] = ["goto", "click", "fill"];
    expectTypeOf(steps[99]).toEqualTypeOf<string | undefined>();
    const missing: string | undefined = steps[99];
    expect(missing).toBeUndefined();
  });

  it("narrows discriminated unions exhaustively under strict", () => {
    type Status = "pass" | "fail" | "skipped";
    const label = (s: Status): string => {
      switch (s) {
        case "pass":
          return "green";
        case "fail":
          return "red";
        case "skipped":
          return "grey";
      }
    };
    expect(label("pass")).toBe("green");
    expect(label("fail")).toBe("red");
    expect(label("skipped")).toBe("grey");
  });
});
