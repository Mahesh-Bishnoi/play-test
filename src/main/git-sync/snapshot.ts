/**
 * The snapshot vocabulary: zod schemas for the definitions-only view of a
 * project that gets committed to git, plus the canonical (sorted-key) form
 * shared by file writing, commit diffing and hashing.
 */

import { z } from "zod";

import { ExportStepSchema } from "../../shared/export-format.js";
import { CaseProfileInputSchema } from "../../shared/schema.js";

// --- Snapshot types ----------------------------------------------------------

const SnapshotStepSchema = ExportStepSchema.extend({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "unsafe step id"),
});
export type SnapshotStep = z.infer<typeof SnapshotStepSchema>;

export const SnapshotCaseSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "unsafe case id"),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional(),
  url: z.string().trim().max(2000).optional(),
  steps: z.array(SnapshotStepSchema).max(5000),
  testData: z
    .record(z.string().regex(/^\w+$/, "key must match \\w+"), z.string().max(10000))
    .default({}),
  // Case profile (M14) is part of the case entity: three-way merge and commit
  // diffing see it as case content. Optional so snapshots written before M14
  // (and older readers) still parse. Auth state FILE CONTENTS never sync —
  // the profile holds filenames only (SPECS §2). Untrusted like the rest.
  profile: CaseProfileInputSchema.optional(),
});
export type SnapshotCase = z.infer<typeof SnapshotCaseSchema>;

export const SnapshotSuiteSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "unsafe suite id"),
  name: z.string().trim().min(1).max(200),
  memberCaseIds: z
    .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "unsafe member id"))
    .max(1000),
});
export type SnapshotSuite = z.infer<typeof SnapshotSuiteSchema>;

export const SnapshotProjectSchema = z.object({
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

// --- Canonical form (sorted keys; arrays keep order) --------------------------

export function canonical(value: unknown): string {
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
