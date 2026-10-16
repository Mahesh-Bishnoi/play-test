# PlayTest — Electron + Playwright Manual-Tester Studio — Build Plan

> Living record for multiple LLM agents. Update `Status Ledger` + checkboxes as work completes. Keep this file as source of truth for scope.

## 1. Vision
Desktop UI for manual testers to: create Projects → Suites → Test Cases → record via Playwright codegen → edit steps in n8n-style workflow graph → run supervised (single) or unsupervised (single/suite parallel headless) → screenshots + failure video → self-contained HTML + PDF reports → re-run failures.

## 2. Locked Decisions (do not revisit without user approval)
- [x] Shell: Electron + TypeScript (Forge + Vite), React + Tailwind + shadcn, `@xyflow/react` for step graph.
- [x] DB: local-first SQLite (`better-sqlite3` + Drizzle ORM). Artifacts on disk.
- [x] Browsers: Chromium only (MVP). `playwright install chromium` on first run.
- [x] Recording: external `playwright codegen` window (not embedded). Parse output → editable `TestStep[]`.
- [x] Steps: editable/tweakable table + workflow graph; green=pass, red=fail, grey=skipped, blue=running.
- [x] Execution: suite-parallel from day one (`workers = min(cpu/2, cases)`).
- [x] Hierarchy: `Project (1) → Suite (N) → Case (N)` via join table (case reusable across suites). Select individual / select-all at suite detail + pre-run dialog.
- [x] Resume semantics: resume-from-failed-step **only** for supervised single-case runs (context kept open). Suites: full re-run or re-run-failed-cases-only.
- [x] Modes: Supervised = single case, headed, pauses. Unsupervised = single or suite, headless, never pauses.
- [x] Artifacts: screenshot after every step; video `retain-on-failure` only.
- [x] Reports: self-contained single-file HTML (drill-down) + PDF export (shareable). Both per suite run.
- [x] Test data: KV now (`{{key}}` substitution), column `source='kv'|'csv'` reserved for future CSV upload.

## 3. Repo Layout (target)
```
src/
  main/         // Electron main: db, ipc, recorder, runner, reports, packaging hooks
    db.ts / schema.ts
    ipc-projects.ts / ipc-suites.ts / ipc-cases.ts / ipc-steps.ts
    recorder.ts     // spawn codegen, parse output
    runner.ts       // spec generation, playwright launch, event streaming
    artifacts.ts    // screenshot/video/trace paths
    reports.ts      // html + pdf generation
  preload/      // contextBridge safe API only
  renderer/     // React: pages + components
    pages/ProjectsPage, SuiteDetailPage, CaseDetailPage (workflow), RunReportPage
    components/StepNode, StepEditorPanel, SuiteSelector, RunDialog, ReportView
  shared/       // zod schemas + types + ipc contract (SINGLE SOURCE)
    schema.ts / ipc-contract.ts / step-types.ts
PLAYTEST_DATA/ignoored — runtime user data lives in ~/PlayTestData, not repo.
```

## 4. Data Model (Drizzle/SQLite)
- `projects(id, name, baseUrl, createdAt)`
- `test_suites(id, projectId, name, createdAt)`
- `test_cases(id, projectId, name, description, url, createdAt)`
- `suite_test_cases(suiteId, caseId)` — PK(suiteId, caseId)
- `test_steps(id, caseId, order, action, selector, value, timeoutMs, editedAt)` — `action: goto|click|fill|select|check|press|assert-visible|assert-text|wait`
- `test_data(caseId, key, value, source)` — MVP `source='kv'`
- `suite_runs(id, suiteId|null, mode, status, startedAt, endedAt, reportHtmlPath, reportPdfPath)`
- `case_runs(id, suiteRunId, caseId, status, durationMs, videoPath)`
- `step_runs(id, caseRunId, stepId, order, status, error, screenshotPath, durationMs)`

Artifacts: `~/PlayTestData/<projectId>/<suiteRunId>/<caseId>/step-<NN>.png, failed.webm, trace.zip`

## 5. IPC Contract (freeze early — `src/shared/ipc-contract.ts`)
Renderer ↔ Main via `ipcMain.handle`, streaming via `webContents.send`:
- `project:create/list/get/update/delete`
- `suite:create/list/get/update/delete`, `suite:setCases(suiteId, caseIds[])`
- `case:create/list/get/update/delete`, `step:upsert/move/delete/reorder`
- `testdata:get/set(caseId, Record<string,string>)`
- `recorder:start({baseUrl}) → {pid}`, `recorder:stop() → {steps: TestStep[]}`
- `runner:runSingle({caseId, mode:'supervised'|'unsupervised'}) → {suiteRunId}`
- `runner:runSuite({suiteId, caseIds[], mode:'unsupervised'}) → {suiteRunId}`
- `runner:resumeFromStep({caseRunId, fromOrder})`, `runner:rerunFailed({suiteRunId})`, `runner:cancel({suiteRunId})`
- Events: `run:step-update {caseRunId, order, status}`, `run:log {level, msg}`, `run:finished {suiteRunId, summary}`
- `report:getHtml(suiteRunId)`, `report:exportPdf(suiteRunId) → path`

## 6. UI Spec
- **ProjectsPage:** CRUD projects, baseUrl field.
- **SuiteDetailPage:** case table with checkboxes, Select all/none, search, Save selection, Run Suite (unsupervised only) → pre-run confirm dialog.
- **CaseDetailPage (workflow):** `@xyflow/react` linear chain; node color by latest `step_runs.status`; click → `StepEditorPanel` (action, selector, value with `{{key}}` hints, timeout); drag reorder; Record (launch codegen) / Stop+Import preview; Run split-button: Supervised / Unsupervised; on supervised failure show Resume vs Full re-run.
- **RunReportPage:** suite summary (counts, durations), per-case step grid with thumbnails, links to HTML, Export PDF button, Re-run failed button.

## 7. Recorder Spec (`recorder.ts`)
- `start`: `spawn(npx playwright codegen <baseUrl> --output <tmp>.js)`, track pid.
- `stop`: kill process, read tmp file, parse regex for `page.goto|click|fill|selectOption|check|press|locator(...).waitFor|expect` → `TestStep[]` ordered. Show import preview modal (accept/edit before save). Robust to parse miss → keep raw code block as `value` fallback, never drop user data.

## 8. Runner Spec (`runner.ts`)
- Generate temp spec per case: wrap each step in `await test.step("s<order>-<action>", async()=>{...})` with `{{key}}` substituted from `test_data`. `screenshot: 'on'` (per step via fixture), `video: 'retain-on-failure'`, `trace: 'retain-on-failure'`.
- Supervised-single: `workers:1, headless:false`, on step fail keep `browserContext` alive, emit paused state.
- Unsupervised: `workers:min(cpu/2,cases), headless:true`, `fullyParallel:true`, continue-on-failure at suite level (each case independent test).
- Resume: only if context alive; re-execute edited step + following steps in same context; else toast “context closed — full re-run required”.
- Cancel: `SIGTERM` to playwright child, mark remaining grey/skipped.

## 9. Reports Spec (`reports.ts`)
- HTML: single file, inline CSS, screenshots as relative links + base64 thumbs, no CDN. Sections: suite summary, case table, per-case step timeline with error stack.
- PDF: same data via headless Chromium print-to-PDF or `electron.printToPDF`; A4, includes failed-step screenshots.
- Both written at `suite_runs.report*Path` on `run:finished`.

## 10. Test Data Spec
- KV editor per case (key/value table). Substitution at spec-gen time: `value.replace(/\{\{(\w+)\}\}/g, lookup)`. Missing key → fail step with clear error `missing test-data key: X`. `source` column future-proofs CSV (`csv` rows → multi-run matrix, out of MVP).

## 11. Packaging
- `electron-builder` (nsis/dmg/AppImage). `postinstall`: `playwright install chromium --with-deps` hook + first-run check with progress UI. Browsers excluded from asar.

## 12. Parallel Workstreams (agent boundaries — respect file ownership)
| WS | Scope | Owns | Depends on |
|----|-------|------|------------|
| WS1 | App shell + DB + shared contracts | `src/main/db*, src/shared/*, src/main/ipc-projects*` | — (do first) |
| WS2 | Project/Suite/Case CRUD UI | `src/renderer/pages/Projects*, SuiteDetail*` | WS1 |
| WS3 | Workflow graph + step editor | `src/renderer/**/Step*, CaseDetail*` | WS1 |
| WS4 | Recorder (codegen+parser) | `src/main/recorder.ts, import preview` | WS1 |
| WS5 | Runner + artifacts (supervised/unsupervised, parallel, resume) | `src/main/runner.ts, artifacts.ts` | WS1, WS3 (step types) |
| WS6 | Reports + packaging + test-data UI | `src/main/reports.ts, RunReport*, test-data UI` | WS5 |

Rules: WS1 freezes `src/shared/*` first; others PR against it. No cross-WS file edits without noting in Status Ledger. One agent per WS.

## 13. Milestones
- [ ] M1 Shell+DB+contracts (WS1)
- [ ] M2 CRUD + selection UI (WS2)
- [ ] M3 Workflow editor, no run (WS3)
- [ ] M4 Recorder import (WS4)
- [ ] M5 Single-case run + screenshots + resume (WS5 part 1)
- [ ] M6 Parallel suite + video-on-fail + HTML/PDF + rerun-failed (WS5 part 2 + WS6)
- [ ] M7 KV data substitution + packaging + first-run browser install

## 14. Status Ledger (agents update this)
| Date | WS | Done | Remaining | Notes |
|------|----|------|-----------|-------|
| 2026-10-16 | — | Plan approved | M1–M7 unstarted | Initial plan file created |

## 15. Conventions
TypeScript strict, zod validate all IPC payloads, Drizzle migrations, no `any` in shared, unit-test parser + substitution (`vitest`), e2e smoke: create project → add step → run headed → report exists.

## 16. Risks
Codegen parse fragility → keep raw fallback. Parallel disk I/O (video+screenshots) → cap workers. Resume state confusion → only same-context resume. Browser download size → progress UI + docs.

## 17. Verification per Milestone
`npm run typecheck && npm test && npm run package -- --dir` + manual: record 3-step login, run supervised (pause/resume), run unsupervised suite of 2 (parallel), check HTML+PDF + failure video exist.
