import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  db: AppDatabase;
  close: () => void;
  filePath: string;
}

/** Runtime user data lives outside the repo (PLAN §3): ~/PlayTestData/playtest.db */
export function defaultDbPath(): string {
  return join(homedir(), "PlayTestData", "playtest.db");
}

// Bootstrap DDL kept in sync with src/main/schema.ts. Fresh installs and
// upgrades get CREATE TABLE / CREATE INDEX IF NOT EXISTS here — there is no
// migration runner (Drizzle is the query builder only). One place owns DDL.
const BOOTSTRAP_DDL = [
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS test_suites (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS test_cases (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    url TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS suite_test_cases (
    suite_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    PRIMARY KEY (suite_id, case_id)
  )`,
  `CREATE TABLE IF NOT EXISTS test_steps (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    action TEXT NOT NULL,
    selector TEXT,
    value TEXT,
    timeout_ms INTEGER,
    edited_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS test_data (
    case_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'kv',
    PRIMARY KEY (case_id, key)
  )`,
  // M14 case profiles: one row per case (case_id PK), no FK by convention.
  `CREATE TABLE IF NOT EXISTS case_profiles (
    case_id TEXT PRIMARY KEY,
    device TEXT,
    viewport_w INTEGER,
    viewport_h INTEGER,
    color_scheme TEXT,
    locale TEXT,
    timezone TEXT,
    storage_state TEXT,
    save_storage_state TEXT,
    dialog_policy TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS suite_runs (
    id TEXT PRIMARY KEY,
    suite_id TEXT,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    report_html_path TEXT,
    report_pdf_path TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS case_runs (
    id TEXT PRIMARY KEY,
    suite_run_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    status TEXT NOT NULL,
    duration_ms INTEGER,
    video_path TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS step_runs (
    id TEXT PRIMARY KEY,
    case_run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    screenshot_path TEXT,
    duration_ms INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_suites_project ON test_suites (project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cases_project ON test_cases (project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_steps_case ON test_steps (case_id, "order")`,
  `CREATE INDEX IF NOT EXISTS idx_caseruns_suite ON case_runs (suite_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_stepruns_case ON step_runs (case_run_id, "order")`,
];

/**
 * Open (creating parent dirs) + bootstrap a SQLite file.
 * Injected path keeps callers testable (tests pass :memory: or tmp files).
 * Caller owns lifecycle via close().
 */
export function createDatabase(filePath: string): DatabaseHandle {
  if (filePath !== ":memory:") {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = OFF");
  for (const ddl of BOOTSTRAP_DDL) {
    sqlite.exec(ddl);
  }
  const db = drizzle(sqlite, { schema });
  return {
    db,
    filePath,
    close: () => {
      sqlite.close();
    },
  };
}
