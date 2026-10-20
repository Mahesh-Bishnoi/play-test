#!/usr/bin/env node
/**
 * Seed the REAL user DB (~/PlayTestData/playtest.db) with a DummyTax project
 * for live manual validation in the packaged app.
 *
 * Usage:
 *   node scripts/seed-dummy-tax.mjs [--db <path>] [--base-url <url>]
 *   npm run seed:dummy-tax
 *
 * Env overrides: PLAYTEST_DB, DUMMY_BASE_URL.
 *
 * Idempotent: any existing project named "DummyTax portal" (plus its suites,
 * cases, steps, test-data and join rows) is deleted first, then recreated.
 * Run rows are left untouched.
 *
 * Prerequisites for live validation:
 *   1. node dummy-tax-site/server.js --port 4137   (or npm run dummy:tax-site)
 *   2. Open the packaged PlayTest app → project "DummyTax portal" appears.
 */

import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const PROJECT_NAME = "DummyTax portal";
const SUITE_NAME = "Tax flows";
const STEP_TIMEOUT_MS = 15_000;

function argValue(flag, envName, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  const env = process.env[envName];
  return env && env.length > 0 ? env : fallback;
}

const dbPath = argValue("--db", "PLAYTEST_DB", join(homedir(), "PlayTestData", "playtest.db"));
const baseUrl = argValue("--base-url", "DUMMY_BASE_URL", "http://127.0.0.1:4137");

const KV_COMMON = {
  base: baseUrl,
  email: "test@example.com",
  password: "password123",
};

const CASES = [
  {
    name: "Login",
    description: "DummyTax login happy path: goto + fill + click + assert-text (KV data).",
    url: `${baseUrl}/login`,
    data: { ...KV_COMMON, name: "Aarav Sharma" },
    steps: [
      { action: "goto", value: "{{base}}/login" },
      { action: "fill", selector: "#email", value: "{{email}}" },
      { action: "fill", selector: "#password", value: "{{password}}" },
      { action: "click", selector: '[data-testid="login-submit"]' },
      { action: "assert-text", selector: "#welcome", value: "{{name}}" },
    ],
  },
  {
    name: "File ITR-1 return",
    description:
      "ITR-1 filing: login, select AY, fill income/deduction fields, verify, submit, acknowledgement.",
    url: `${baseUrl}/file-return`,
    data: {
      ...KV_COMMON,
      year: "2025-26",
      pan: "ABCDE1234F",
      salary: "950000",
      other: "60000",
      c80: "150000",
      bank: "XXXX-XXXX-9911",
    },
    steps: [
      { action: "goto", value: "{{base}}/login" },
      { action: "fill", selector: "#email", value: "{{email}}" },
      { action: "fill", selector: "#password", value: "{{password}}" },
      { action: "click", selector: '[data-testid="login-submit"]' },
      { action: "goto", value: "{{base}}/file-return" },
      { action: "select", selector: "#assessmentYear", value: "{{year}}" },
      { action: "fill", selector: "#pan", value: "{{pan}}" },
      { action: "fill", selector: "#incomeSalary", value: "{{salary}}" },
      { action: "fill", selector: "#incomeOther", value: "{{other}}" },
      { action: "fill", selector: "#deductions80C", value: "{{c80}}" },
      { action: "fill", selector: "#bankAccount", value: "{{bank}}" },
      { action: "check", selector: "#verify" },
      { action: "click", selector: '[data-testid="itr-submit"]' },
      { action: "assert-visible", selector: "#acknowledgement" },
      { action: "assert-text", selector: "#filing-summary", value: "{{year}}" },
      { action: "click", selector: '[data-testid="back-filings"]' },
    ],
  },
  {
    name: "Respond to notice",
    description: "Notices: login, filter open notices, open ITR-2024-001, submit a response.",
    url: `${baseUrl}/notices`,
    data: {
      ...KV_COMMON,
      reply: "Bank statements for FY 2023-24 attached for verification.",
    },
    steps: [
      { action: "goto", value: "{{base}}/login" },
      { action: "fill", selector: "#email", value: "{{email}}" },
      { action: "fill", selector: "#password", value: "{{password}}" },
      { action: "click", selector: '[data-testid="login-submit"]' },
      { action: "goto", value: "{{base}}/notices" },
      { action: "select", selector: "#status", value: "Open" },
      { action: "click", selector: '[data-testid="notice-filter-submit"]' },
      { action: "assert-text", selector: '[data-testid="notices-table"]', value: "ITR-2024-001" },
      { action: "click", selector: '[data-testid="notice-link-ITR-2024-001"]' },
      { action: "fill", selector: "#response", value: "{{reply}}" },
      { action: "click", selector: '[data-testid="notice-respond-submit"]' },
      { action: "assert-visible", selector: "#response-saved" },
    ],
  },
];

// Minimal bootstrap so the script also works before the app ever launched.
// Kept in sync with src/main/db.ts (IF NOT EXISTS — never alters live tables).
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
];

function main() {
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  try {
    sqlite.pragma("journal_mode = WAL");
    for (const ddl of BOOTSTRAP_DDL) sqlite.exec(ddl);

    const now = Date.now();
    const existing = sqlite.prepare("SELECT id FROM projects WHERE name = ?").all(PROJECT_NAME);
    for (const { id: pid } of existing) {
      const suiteIds = sqlite
        .prepare("SELECT id FROM test_suites WHERE project_id = ?")
        .all(pid)
        .map((r) => r.id);
      const caseIds = sqlite
        .prepare("SELECT id FROM test_cases WHERE project_id = ?")
        .all(pid)
        .map((r) => r.id);
      if (suiteIds.length > 0) {
        const ph = suiteIds.map(() => "?").join(",");
        sqlite.prepare(`DELETE FROM suite_test_cases WHERE suite_id IN (${ph})`).run(...suiteIds);
        sqlite.prepare(`DELETE FROM test_suites WHERE id IN (${ph})`).run(...suiteIds);
      }
      if (caseIds.length > 0) {
        const ph = caseIds.map(() => "?").join(",");
        sqlite.prepare(`DELETE FROM suite_test_cases WHERE case_id IN (${ph})`).run(...caseIds);
        sqlite.prepare(`DELETE FROM test_steps WHERE case_id IN (${ph})`).run(...caseIds);
        sqlite.prepare(`DELETE FROM test_data WHERE case_id IN (${ph})`).run(...caseIds);
        sqlite.prepare(`DELETE FROM case_profiles WHERE case_id IN (${ph})`).run(...caseIds);
        sqlite.prepare(`DELETE FROM test_cases WHERE id IN (${ph})`).run(...caseIds);
      }
      sqlite.prepare("DELETE FROM projects WHERE id = ?").run(pid);
      // Re-seeding mints new ids, so the old artifact tree would be orphaned
      // (review counted #13). Contained to ~/PlayTestData by the relative check.
      const artifactsRoot = join(homedir(), "PlayTestData");
      const projectDir = join(artifactsRoot, pid);
      const rel = relative(artifactsRoot, projectDir);
      if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
        rmSync(projectDir, { recursive: true, force: true });
      }
    }
    if (existing.length > 0) {
      console.log(`Removed ${existing.length} existing "${PROJECT_NAME}" project(s).`);
    }

    const projectId = randomUUID();
    sqlite
      .prepare("INSERT INTO projects (id, name, base_url, created_at) VALUES (?, ?, ?, ?)")
      .run(projectId, PROJECT_NAME, baseUrl, now);

    const suiteId = randomUUID();
    sqlite
      .prepare("INSERT INTO test_suites (id, project_id, name, created_at) VALUES (?, ?, ?, ?)")
      .run(suiteId, projectId, SUITE_NAME, now);

    const insertCase = sqlite.prepare(
      "INSERT INTO test_cases (id, project_id, name, description, url, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertStep = sqlite.prepare(
      'INSERT INTO test_steps (id, case_id, "order", action, selector, value, timeout_ms, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertData = sqlite.prepare(
      "INSERT INTO test_data (case_id, key, value, source) VALUES (?, ?, ?, 'kv')",
    );
    const insertJoin = sqlite.prepare(
      "INSERT INTO suite_test_cases (suite_id, case_id) VALUES (?, ?)",
    );

    let stepCount = 0;
    let kvCount = 0;
    for (const c of CASES) {
      const caseId = randomUUID();
      insertCase.run(caseId, projectId, c.name, c.description, c.url, now);
      c.steps.forEach((s, order) => {
        insertStep.run(
          randomUUID(),
          caseId,
          order,
          s.action,
          s.selector ?? null,
          s.value ?? null,
          STEP_TIMEOUT_MS,
          now,
        );
      });
      stepCount += c.steps.length;
      for (const [key, value] of Object.entries(c.data)) {
        insertData.run(caseId, key, value);
        kvCount += 1;
      }
      insertJoin.run(suiteId, caseId);
    }

    console.log(`Seeded "${PROJECT_NAME}" (${baseUrl}) into ${dbPath}`);
    console.log(
      `  project: 1, suite: 1 ("${SUITE_NAME}"), cases: ${CASES.length}, steps: ${stepCount}, kv rows: ${kvCount}`,
    );
    console.log(
      `Next: start the dummy site (npm run dummy:tax-site), open PlayTest, run the suite.`,
    );
  } finally {
    sqlite.close();
  }
}

main();
