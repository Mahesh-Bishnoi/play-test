/**
 * The pending-conflict sidecar. A pull that cannot auto-merge writes the
 * remote ("theirs") content next to the gitdir; resolve reads it back, applies
 * the chosen winner and rewrites the file.
 */

import fs from "node:fs";
import path from "node:path";

import { gitdirOf } from "./repo.js";
import type { StoredConflict } from "./types.js";

const CONFLICTS_FILE = "playtest-conflicts.json";
const CONFLICTS_VERSION = 1;

// --- Conflicts file ------------------------------------------------------------

function conflictsPath(dir: string): string {
  return path.join(gitdirOf(dir), CONFLICTS_FILE);
}

export function readConflicts(dir: string): StoredConflict[] {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(conflictsPath(dir), "utf8"));
    if (typeof raw !== "object" || raw === null) {
      return [];
    }
    const list = (raw as { conflicts?: unknown }).conflicts;
    if (!Array.isArray(list)) {
      return [];
    }
    return list.filter((c): c is StoredConflict => {
      if (typeof c !== "object" || c === null) {
        return false;
      }
      const entry = c as StoredConflict;
      const knownEntity =
        entry.entity === "case" || entry.entity === "suite" || entry.entity === "project";
      const theirs = entry.theirs;
      // `null` is a recorded remote deletion.
      const validTheirs = theirs === null || typeof theirs === "object";
      return knownEntity && typeof entry.id === "string" && validTheirs;
    });
  } catch {
    return [];
  }
}

export function writeConflicts(dir: string, conflicts: StoredConflict[]): void {
  fs.writeFileSync(
    conflictsPath(dir),
    `${JSON.stringify({ version: CONFLICTS_VERSION, conflicts })}\n`,
  );
}
