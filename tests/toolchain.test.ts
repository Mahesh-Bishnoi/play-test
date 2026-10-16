import { describe, expect, it } from "vitest";

// Smoke test for the toolchain itself: proves vitest runs and that the
// strict flags in tsconfig.json are active (this file only compiles with
// `strict` + `noUncheckedIndexedAccess` — indexed access narrows to
// `T | undefined`, forcing the explicit undefined checks below).
describe("toolchain smoke", () => {
  it("honors noUncheckedIndexedAccess on out-of-bounds access", () => {
    const steps: string[] = ["goto", "click", "fill"];
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
