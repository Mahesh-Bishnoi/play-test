import { join } from "node:path";

import { eq } from "drizzle-orm";

import type { CaseProfile, CaseProfileInput } from "../shared/schema.js";
import {
  AuthStateFilenameSchema,
  CaseProfileInputSchema,
  CaseProfileSchema,
} from "../shared/schema.js";
import type { AppDatabase } from "./db.js";
import { caseProfiles } from "./schema.js";

// Case profile service (M14, SPECS §4/§6). One row per case at most — no row
// means "defaults" (1280x720, no auth, no emulation). Field shapes are the
// shared zod schemas, so the recorder, the runners, transfer and git-sync all
// read/write through this one module (no second dialect).

/** `~/PlayTestData/<projectId>/auth` — where recorded auth state files live. */
export function authStateDir(root: string, projectId: string): string {
  return join(root, projectId, "auth");
}

/**
 * Absolute path of a profile's auth state file. Rejects anything but a bare
 * filename (no separators, no traversal) — the value arrives from the profile
 * form and from imported/synced bundles, so validate at this boundary too.
 */
export function resolveAuthStatePath(root: string, projectId: string, filename: string): string {
  const parsed = AuthStateFilenameSchema.safeParse(filename);
  if (!parsed.success) {
    throw new Error(`invalid auth state filename: ${filename}`);
  }
  return join(authStateDir(root, projectId), parsed.data);
}

/** Thrown before a launch when the profile names an auth file that is gone. */
export class MissingAuthStateError extends Error {
  constructor(filename: string) {
    super(
      `auth state missing: ${filename} — record the login flow again or clear the profile field`,
    );
    this.name = "MissingAuthStateError";
  }
}

type CaseProfileRow = typeof caseProfiles.$inferSelect;

/** Row → entity: `null` columns become absent optional fields. */
function toCaseProfile(row: CaseProfileRow): CaseProfile {
  return CaseProfileSchema.parse({
    caseId: row.caseId,
    ...(row.device !== null ? { device: row.device } : {}),
    ...(row.viewportW !== null ? { viewportW: row.viewportW } : {}),
    ...(row.viewportH !== null ? { viewportH: row.viewportH } : {}),
    ...(row.colorScheme !== null ? { colorScheme: row.colorScheme } : {}),
    ...(row.locale !== null ? { locale: row.locale } : {}),
    ...(row.timezone !== null ? { timezone: row.timezone } : {}),
    ...(row.storageState !== null ? { storageState: row.storageState } : {}),
    ...(row.saveStorageState !== null ? { saveStorageState: row.saveStorageState } : {}),
    ...(row.dialogPolicy !== null ? { dialogPolicy: row.dialogPolicy } : {}),
    updatedAt: row.updatedAt,
  });
}

/** All columns for a write: absent fields clear to NULL (so edits can unset). */
function columnValues(profile: CaseProfileInput) {
  return {
    device: profile.device ?? null,
    viewportW: profile.viewportW ?? null,
    viewportH: profile.viewportH ?? null,
    colorScheme: profile.colorScheme ?? null,
    locale: profile.locale ?? null,
    timezone: profile.timezone ?? null,
    storageState: profile.storageState ?? null,
    saveStorageState: profile.saveStorageState ?? null,
    dialogPolicy: profile.dialogPolicy ?? null,
  };
}

/**
 * Validate + drop empty fields. Returns `null` when the profile carries no
 * configuration at all, which is stored as "no row" rather than a blank row.
 */
export function normalizeProfileInput(input: unknown): CaseProfileInput | null {
  const parsed = CaseProfileInputSchema.parse(input);
  const entries = Object.entries(parsed).filter(([, value]) => value !== undefined);
  return entries.length === 0 ? null : (Object.fromEntries(entries) as CaseProfileInput);
}

export function getCaseProfile(db: AppDatabase, caseId: string): CaseProfile | null {
  const row = db.select().from(caseProfiles).where(eq(caseProfiles.caseId, caseId)).get();
  return row === undefined ? null : toCaseProfile(row);
}

/**
 * Upsert the profile. An all-empty profile deletes the row and returns `null`
 * (back to defaults). `now` is injectable for tests.
 */
export function setCaseProfile(
  db: AppDatabase,
  caseId: string,
  input: unknown,
  now: number = Date.now(),
): CaseProfile | null {
  const profile = normalizeProfileInput(input);
  if (profile === null) {
    deleteCaseProfile(db, caseId);
    return null;
  }
  const columns = columnValues(profile);
  db.insert(caseProfiles)
    .values({ caseId, ...columns, updatedAt: now })
    .onConflictDoUpdate({
      target: caseProfiles.caseId,
      set: { ...columns, updatedAt: now },
    })
    .run();
  return getCaseProfile(db, caseId);
}

export function deleteCaseProfile(db: AppDatabase, caseId: string): void {
  db.delete(caseProfiles).where(eq(caseProfiles.caseId, caseId)).run();
}
