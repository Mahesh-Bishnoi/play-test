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
- [x] M1 Shell+DB+contracts (WS1)
- [x] M2 CRUD + selection UI (WS2)
- [x] M3 Workflow editor, no run (WS3)
- [x] M4 Recorder import (WS4)
- [ ] M5 Single-case run + screenshots + resume (WS5 part 1)
- [ ] M6 Parallel suite + video-on-fail + HTML/PDF + rerun-failed (WS5 part 2 + WS6)
- [ ] M7 KV data substitution + packaging + first-run browser install

## 14. Status Ledger (agents update this)
| Date | WS | Done | Remaining | Notes |
|------|----|------|-----------|-------|
| 2026-10-16 | — | Plan approved | M1–M7 unstarted | Initial plan file created |
| 2026-10-16 | setup | Toolchain: TS 7.0.2 + oxlint 1.88.0 + oxlint-tsgolint 7.0.2004 (type-aware) + vitest 5.0.5 + prettier 3.9.10; `verify` = typecheck+lint+format+test, all green | M1–M7 unstarted | typescript-eslint rejected: needs classic compiler API removed in TS7 (verified in typescript-7.0.2.tgz; upstream #12518 closed "not planned", support waits on TS 7.1). oxlint proven: no-explicit-any + type-aware no-floating-promises fire, exit 1 on violation. TS pinned 7.0.2 ↔ tsgolint 7.0.2004 must stay in sync. Files: package.json, tsconfig.json (strict+noUncheckedIndexedAccess), .oxlintrc.json, .prettierrc.json, vitest.config.ts, tests/toolchain.test.ts, .gitignore |
| 2026-10-16 | WS1 | Claimed: M1 shared contracts + DB schema + project service (no cross-WS edits) | M1 in progress; M2–M7 unstarted | Scope: src/shared/* freeze, src/main/schema.ts + db.ts + ipc-projects.ts, drizzle.config.ts, tests. Electron shell bootstrap deferred to M1-part-2. Deps checked live: zod 4.6.7, drizzle-orm 0.45.4, better-sqlite3 13.0.3, drizzle-kit 0.31.11 |
| 2026-10-16 | WS1 | Done (M1-part-1): shared contracts frozen (step-types, schema, ipc-contract v1); drizzle tables + bootstrap DDL + createDatabase; project CRUD service; drizzle migration 0000 generated | Remaining M1: Electron shell bootstrap (src/main/index.ts, preload, forge/vite wiring). M2–M7 unstarted | Files: src/shared/step-types.ts, schema.ts, ipc-contract.ts; src/main/schema.ts, db.ts, ipc-projects.ts; drizzle.config.ts, drizzle/0000_*; tests/shared-contracts.test.ts, db-projects.test.ts; .prettierignore (drizzle/ excluded as generated). Checks: `npm run verify` green (typecheck+lint+format+test, 15 tests/3 files). No cross-WS edits. |
| 2026-10-16 | WS1 | Claimed: M1-part-2 Electron shell bootstrap (index.ts, preload, forge/vite wiring, project IPC registration) — no cross-WS edits | M1 in progress; M2–M7 unstarted | Scope: src/main/index.ts + ipc-register.ts, src/preload/preload.ts, src/renderer shell placeholder, forge.config + vite.*.config, index.html, package.json scripts. Deps checked live: electron 44.8.0, vite 8.3.4, react 19.3.1, @vitejs/plugin-react 6.1.2, @electron-forge/* 8.0.1 |
| 2026-10-16 | WS1 | Done (M1-part-2): Electron shell boots; project:* IPC wired with zod validation; Forge 8 + Vite 8 build + `npm run package` green | M1 complete; M2–M7 unstarted (WS2 unblocked) | Files: src/main/main.ts (composition root), ipc-register.ts (testable handle registration); src/preload/preload.ts (allowlisted invoke); src/renderer/main.tsx + App.tsx (M1 IPC smoke, WS2 replaces) + playtest-api.d.ts + vite-env.d.ts; forge.config.ts, vite.{main,preload,renderer}.config.ts, index.html; package.json (start/package/make, main=.vite/build/main.cjs, electron 44.8.0/vite 8.3.4/react 19.3.1/forge 8.0.1 + @types/electron-squirrel-startup 1.0.2) + tsconfig include configs. Fixes during build: entry renamed index.ts→main.ts (forge emits main.js from basename); main/preload are .cjs (plugin-vite v8 + type:module). Checks: `npm run verify` green (17 tests/4 files, incl. new tests/ipc-register.test.ts); `npm run package` → out/playtest-linux-x64. No cross-WS edits. NOTE for WS5/WS6: better-sqlite3 native rebuild for packaged app not yet verified — packaged binary boots but DB write path in packaged app untested. |
| 2026-10-16 | WS2 | Claimed: M2 suite/case/step/testdata services + CRUD/selection UI (extends ipc-register + main.ts wiring, replaces App.tsx) | M2 in progress; M3–M7 unstarted | Scope: src/main/ipc-suites.ts + ipc-cases.ts + ipc-steps.ts (incl. testdata), ipc-register additions, src/renderer/pages/* + App wiring. No shared contract changes (payload schemas reused; return envelopes only). No new deps. |
| 2026-10-16 | WS2 | Done (M2): suite/case/step/testdata services + CRUD/selection UI; M2 checkbox ticked | Remaining: M3–M7 (WS3 workflow editor unblocked — case:get returns {case, steps}, step channels live) | Files: src/main/ipc-suites.ts (CRUD + setCases with same-project validation + getSuiteCaseIds), ipc-cases.ts (CRUD + cascade delete + listCasesByIds), ipc-steps.ts (upsert/move/delete/reorder with dense 0..n-1 orders + KV get/set), ipc-register.ts (registerSuite/Case/Step/TestDataHandlers + registerCrudHandlers), main.ts (registerCrudHandlers); src/renderer/api.ts (typed invoke + zod envelopes), pages/ProjectsPage.tsx (project CRUD + picker), pages/SuiteDetailPage.tsx (suite/case CRUD, checkbox table, search, select all/none, save, unsupervised pre-run dialog), App.tsx (picker + detail shell). Contract note (no payload change): suite:get → {suite, caseIds}, case:get → {case, steps} — envelopes only, IPC_PAYLOADS untouched. Checks: `npm run verify` green (24 tests/5 files, incl. new tests/crud.test.ts: 7 tests); `npm run package` green. No cross-WS file edits beyond WS2 scope (main.ts wiring + App.tsx replacement as claimed). |
| 2026-10-16 | WS3 | Done (M3): workflow editor — CaseDetailPage (graph + table + editor, no run); M3 checkbox ticked | Remaining: M4–M7 (WS4 recorder unblocked — step types frozen, import writes via step:upsert) | Files: NEW src/renderer/components/workflow-layout.ts (pure chain/status/position helpers) + StepNode.tsx (xyflow card) + StepGraph.tsx (linear ReactFlow chain) + StepEditorPanel.tsx (action/selector/value+{{key}} hints/timeout) + pages/CaseDetailPage.tsx (load/add/save/delete/up-down + HTML5 drag reorder via step:reorder, record/run as disabled placeholders); EXTENDED src/renderer/api.ts (step:upsert/move/delete/reorder + testdata:get wrappers, additive) + App.tsx (openCaseId shell) + pages/SuiteDetailPage.tsx (optional Open button). Dep: @xyflow/react 12.12.0 (checked live, React 19 compatible). Checks: `npm run verify` green (31 tests/6 files, incl. new tests/workflow-layout.test.ts: 7 tests); `npm run package` green. No shared contract changes. |
| 2026-10-16 | WS4 | Done (M4): codegen spawn/stop + parser + recorder IPC + import preview; M4 checkbox ticked | Remaining: M5–M7 (WS5 runner unblocked — step types frozen, steps read via listSteps) | Files: NEW src/main/recorder.ts (parseCodegenOutput pure: goto/fill/select/check/press/click/waitForTimeout→wait/asserts, unknown page stmts → wait+raw fallback, terminalStringArg so fill values don't pick up selector strings; CodegenRecorder class with injected RecorderDeps + sharedRecorder) + src/renderer/components/RecorderImportPreview.tsx (checkbox preview modal, empty-state) + tests/recorder.test.ts (7 tests: parser order/values/fallback/boilerplate + lifecycle + IPC handlers); EXTENDED ipc-register.ts (registerRecorderHandlers, zod re-validation at boundary), main.ts (recorder wiring), api.ts (start/stopRecorder wrappers), CaseDetailPage.tsx (Record URL input + Record/Stop + preview→sequential step:upsert import; runs stay WS5 placeholders). Bug found by test: firstStringArg returned selector string for fill — fixed via terminalStringArg. Checks: `npm run verify` green (38 tests/7 files); `npm run package` green. No shared contract changes. Cross-WS touches (ipc-register/main/api/CaseDetailPage) as claimed. |

## 15. Conventions
TypeScript strict, zod validate all IPC payloads, Drizzle migrations, no `any` in shared, unit-test parser + substitution (`vitest`), e2e smoke: create project → add step → run headed → report exists.

## 16. Risks
Codegen parse fragility → keep raw fallback. Parallel disk I/O (video+screenshots) → cap workers. Resume state confusion → only same-context resume. Browser download size → progress UI + docs.
- Toolchain lockstep (2026-10-16): `typescript@7.0.2` ↔ `oxlint-tsgolint@7.0.2004` are version-locked (tsgolint tracks an exact TS release). Upgrade both together or type-aware lint silently mismatches. Revisit typescript-eslint when TS 7.1 lands (upstream support waits on it, #12518).
- Toolchain gaps (2026-10-16): Windows/macOS install behavior unverified; no React/import-ordering lint rules yet — add when WS2/WS3 land renderer code.

## 17. Verification per Milestone
`npm run typecheck && npm test && npm run package -- --dir` + manual: record 3-step login, run supervised (pause/resume), run unsupervised suite of 2 (parallel), check HTML+PDF + failure video exist.
