import type { TestCase } from "../../shared/schema.js";

/**
 * M12 keyword filter (PLAN §18.5): client-side substring match on case name.
 * The suite page reuses its search box for this — no server-side grep.
 */
export function filterCasesByKeyword(cases: TestCase[], query: string): TestCase[] {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return cases;
  }
  return cases.filter((c) => c.name.toLowerCase().includes(q));
}
