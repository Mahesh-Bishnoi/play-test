import { z } from "zod";

import { CaseProfileInputSchema } from "./schema.js";
import { TestStepSchema } from "./step-types.js";

// Versioned file interchange for project/suite/case import/export.
// Copy semantics (file transfer): no ids in the file — the importer
// always generates fresh ids and remaps suite membership by case name.
// A future repo-sync mode will keep stable ids for idempotent pull;
// that is a v2 concern, not this schema.
export const EXPORT_FORMAT = "playtest-export" as const;
export const EXPORT_VERSION = 1 as const;

/** Rejects pasted 100MB dumps before zod ever sees them (hardening: size cap). */
export const MAX_EXPORT_BYTES = 10 * 1024 * 1024;

export const EXPORT_SCOPE = ["project", "suite", "case"] as const;
export const ExportScopeSchema = z.enum(EXPORT_SCOPE);
export type ExportScope = z.infer<typeof ExportScopeSchema>;

/** A step without identity — order + content only. Identity is regenerated. */
export const ExportStepSchema = TestStepSchema.omit({ id: true, caseId: true });
export type ExportStep = z.infer<typeof ExportStepSchema>;

const testDataRecord = z.record(
  z.string().regex(/^\w+$/, "key must match \\w+"),
  z.string().max(10000),
);

export const ExportCaseSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional(),
  url: z.string().trim().max(2000).optional(),
  steps: z.array(ExportStepSchema).max(5000),
  testData: testDataRecord,
  // Case profile (M14, SPECS §2/§4) — the recorded environment travels with
  // the case. Auth state FILE CONTENTS never travel: the profile only holds
  // filenames (`storageState` / `saveStorageState` / `sessionState`) under
  // `~/PlayTestData/<projectId>/auth/`, and the importer gets a fresh project
  // id, so those files are intentionally not part of a bundle. Additive
  // optional field: no EXPORT_VERSION bump — old readers strip it.
  profile: CaseProfileInputSchema.optional(),
});
export type ExportCase = z.infer<typeof ExportCaseSchema>;

export const ExportSuiteSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /** Membership by case name — remapped to fresh ids on import. */
  caseNames: z.array(z.string().trim().min(1).max(200)).max(1000),
});
export type ExportSuite = z.infer<typeof ExportSuiteSchema>;

export const ExportFileSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(EXPORT_VERSION),
  exportedAt: z.number().int().min(0),
  scope: ExportScopeSchema,
  /** Present only for scope=project; suite/case files inherit the target baseUrl. */
  project: z
    .object({
      name: z.string().trim().min(1).max(200),
      baseUrl: z.string().trim().max(2000).optional(),
    })
    .optional(),
  /** Display hint only ("exported from X") — never used as an import target. */
  sourceProjectName: z.string().trim().min(1).max(200).optional(),
  suites: z.array(ExportSuiteSchema).max(1000),
  cases: z.array(ExportCaseSchema).max(5000),
});
export type ExportFile = z.infer<typeof ExportFileSchema>;

/** Thrown when a file fails shape/version validation — UI surfaces message only. */
export class ExportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportValidationError";
  }
}

/** Parse + validate an unknown JSON value as an export file. */
export function parseExportFile(raw: unknown): ExportFile {
  const parsed = ExportFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ExportValidationError(
      `not a PlayTest export (v${EXPORT_VERSION}): ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** Parse raw file text: size cap first, then JSON, then schema. */
export function parseExportText(text: string): ExportFile {
  if (text.length > MAX_EXPORT_BYTES) {
    throw new ExportValidationError(`export file too large (max ${MAX_EXPORT_BYTES} bytes)`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new ExportValidationError("export file is not valid JSON");
  }
  return parseExportFile(raw);
}

/** Default save-dialog filename for a scope: slug + .playtest.json. */
export function exportFileName(base: string, scope: ExportScope): string {
  const slug =
    base
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || scope;
  return `${slug}.${scope}.playtest.json`;
}
