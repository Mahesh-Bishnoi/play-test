# PlayTest — Electron + Playwright Manual-Tester Studio

> Current-state spec, not history. Past decisions and fixes live in `git log` + tests.
> `src/shared/*` is the source of truth for types and IPC — if this file conflicts
> with code on behavior, code wins; on intent, §2 wins (needs user approval to change).

## 1. Vision

Desktop UI for manual testers: Projects → Suites → Test Cases → record via
Playwright codegen → edit steps in workflow graph → run supervised (single) or
unsupervised (single/suite parallel headless) → screenshots + failure video →
self-contained HTML + PDF reports → re-run failures. Local-first, Chromium only.

## 2. Locked Decisions (do not revisit without user approval)

- Shell: Electron + TypeScript (Forge + Vite), React + Tailwind, `@xyflow/react` step graph.
- DB: local-first SQLite (`better-sqlite3` + Drizzle). Artifacts on disk under `~/PlayTestData`.
- Browsers: Chromium only. `playwright install chromium` on first run + in-app progress check.
- Recording: external `playwright codegen` window (not embedded). Parse output → editable steps.
- Steps: 25 actions (see `STEP_ACTIONS` in `src/shared/step-types.ts`); table + linear graph;
  green=pass, red=fail, grey=skipped, blue=running.
- Execution: suite-parallel (`workers = min(cpu/2, cases)`); direct `playwright` library
  (not `@playwright/test` — so no UI mode / sharding / multi-browser; see Non-goals).
- Hierarchy: `Project (1) → Suite (N) → Case (N)` via join table (cases reusable across suites).
- Resume: resume-from-failed-step only for supervised single-case runs (context kept open).
  Suites: full re-run or re-run-failed-cases-only.
- Modes: Supervised = single case, headed, pauses, optional `actionDelayMs` pacing.
  Unsupervised = single or suite, headless, never pauses.
- Artifacts: screenshot after every step (retry-once on navigation race); video + trace
  `retain-on-failure` only.
- Reports: self-contained single-file HTML + PDF export per suite run. Trace opens via
  `playwright show-trace` (button only when `trace.zip` exists).
- Test data: KV `{{key}}` substitution at run time; missing key fails the step with
  `missing test-data key: X`. `source` column reserved for future CSV.
- Transfer: file import/export (`.playtest.json`, versioned) with copy semantics (fresh ids,
  membership by name, target `baseUrl` wins). No runs/artifacts in bundles.
- Sync (Phase 2): per-project local-git sync via `src/main/git-sync.ts`, local-path remotes
  only (http(s) rejected), snapshot layout `project.json` + `suites/<id>.json` + `cases/<id>.json`,
  stable DB ids, entity three-way merge, conflicts in `.git/playtest-conflicts.json`.
- M11 closed as wont-do (2026-10-17): Inspector debug via `PWDEBUG=1`/`page.pause()` is not
  viable in-process (env cached at import, pause is a no-op without inspector, cancel/resume
  hang mid-step). Keep supervised resume instead.
- Non-goals: UI Mode, `--project` multi-browser, sharding, `show-report` HTML-reporter,
  retries/sharding/timeout config UI, VS Code extension. Post-MVP path: per-project
  `browser` field + `postinstall` line. No DB migration without re-plan.

## 3. Repo Layout (actual)

```
src/
  main/
    db.ts / schema.ts / artifacts.ts
    ipc-projects.ts / ipc-suites.ts / ipc-cases.ts / ipc-steps.ts
    ipc-register.ts / main.ts
    recorder.ts / runner.ts / suite-runner.ts
    reports.ts / trace-viewer.ts / browser-setup.ts
    transfer.ts / git-sync.ts
  preload/preload.ts            // allowlisted invoke + run:* subscribe only
  renderer/
    api.ts / main.tsx / App.tsx / styles.css / theme.ts
    pages/WelcomeScreen, ProjectExplorer, SuiteDetailPage, CaseDetailPage, RunReportPage
    components/StepNode, StepGraph, StepEditorPanel, TestDataEditor,
      RecorderImportPreview, SyncPanel, BrowserBanner, ConfirmDialog,
      pick-locator.ts, suite-run-filter.ts, workflow-layout.ts
  shared/schema.ts / step-types.ts / ipc-contract.ts / export-format.ts
tests/                          // vitest unit + PLAYTEST_E2E-gated e2e (DummyTax, local site)
dummy-tax-site/server.js        // zero-dep manual-trial portal (npm run dummy:tax-site)
scripts/seed-dummy-tax.mjs      // idempotent seed of ~/PlayTestData (npm run seed:dummy-tax)
```

Runtime data lives in `~/PlayTestData`, never in the repo. Schema DDL lives in
`src/main/db.ts` (`BOOTSTRAP_DDL`, mirroring `src/main/schema.ts`) — Drizzle is
the query builder only; there is no migration runner.

## 4. Data Model (Drizzle/SQLite)

- `projects(id, name, baseUrl, createdAt)`
- `test_suites(id, projectId, name, createdAt)`
- `test_cases(id, projectId, name, description, url, createdAt)`
- `suite_test_cases(suiteId, caseId)` — PK(suiteId, caseId)
- `test_steps(id, caseId, order, action, selector, value, timeoutMs, editedAt)` —
  `action` is plain text; valid values = `STEP_ACTIONS` (25: goto/click/dblclick/fill/type/
  select/check/uncheck/hover/focus/press + 13 asserts + wait). Click variants and multi-select
  encode in `value` (`parseClickValue` / `parseSelectValue` in `runner.ts`).
- `test_data(caseId, key, value, source)` — `source='kv'` today.
- `suite_runs(id, suiteId|null, mode, status, startedAt, endedAt, reportHtmlPath, reportPdfPath)`
- `case_runs(id, suiteRunId, caseId, status, durationMs, videoPath)`
- `step_runs(id, caseRunId, stepId, order, status, error, screenshotPath, durationMs)`

Artifacts: `~/PlayTestData/<projectId>/<suiteRunId>/<caseId>/step-<NN>.png, failed.webm, trace.zip`

## 5. IPC Contract (`src/shared/ipc-contract.ts` is canonical, zod-validated in main)

- CRUD: `project:*` (create/list/get/update/delete), `suite:*` (+ `suite:setCases`),
  `case:*` (+ `case:get` returns `{case, steps}`), `step:*` (upsert/move/delete/reorder),
  `testdata:get/set`.
- Recorder: `recorder:start({baseUrl, viewport?, device?, colorScheme?, locale?, timezone?, storageStatePath?, saveStoragePath?})`, `recorder:stop() → {steps}`.
- Runner: `runner:runSingle({caseId, mode, actionDelayMs?})`, `runner:runSuite({suiteId, caseIds[], mode:'unsupervised'})`,
  `runner:resumeFromStep`, `runner:rerunFailed`, `runner:rerunLastFailed`, `runner:cancel`.
- Reports: `report:getHtml`, `report:exportPdf`, `report:openTrace({caseRunId} | {tracePath})`.
- Transfer: `transfer:exportProject/exportSuite/exportCase`, `transfer:importProject/importSuite/importCase`.
- Sync: `sync:init/commit/push/pull/status/branch/resolve/clone` (local paths only).
- System: `system:browserStatus`, `system:installBrowser`.
- Events (main → renderer): `run:step-update`, `run:log`, `run:finished`.

## 6. UX (current)

- Welcome screen (search, open/create/delete, import project, clone entry) → Project shell
  (menubar + Close Project, Sync tab, browser banner).
- ProjectExplorer: suites → nested cases tree, inline suite/case creation, search.
- SuiteDetailPage: membership + runs only (creation lives in sidebar); checkbox table, search
  doubles as keyword run-filter, Run-filtered scope, Re-run-last-failed, View report.
- CaseDetailPage: linear `@xyflow/react` graph + step editor (action/selector/value+`{{key}}`
  hints/timeout) + KV TestDataEditor + Record options disclosure (viewport/device/theme/
  locale/timezone/storage-state, persisted in localStorage) + import preview + paste-locator
  insert + Supervised (with speed selector) / Unsupervised run + live colors + resume/cancel + log.
- RunReportPage: suite summary, per-case step grid with thumbnails, Open-trace buttons,
  Export PDF, Re-run failed.
- Themes: IntelliJ dark (default) + opt-in Syntax light, persisted, pre-paint no-flash.

## 7. Behavior Notes (current, not history)

- Recorder: argv-only flag builder (`buildCodegenArgs`, allowlisted; viewport `"W,H"` comma,
  locale → `--lang`, unknown device rejects). Parser: goto/fill/select/check/uncheck/press/
  dblclick/type/hover/focus/click/asserts; unknown statements → `wait` + raw fallback, never
  drop data. Resolver `resolveLocator` allowlists `getBy*`/locator chains; `page.evaluate` /
  `frameLocator` fail with edit guidance.
- Runner: `SingleCaseRunner` (supervised pause/resume in same context; cancel settles between
  steps) + `SuiteRunner` (worker pool, missing-key pre-scan, fail→skip-rest, settle
  failed > cancelled > passed, best-effort HTML). Screenshot retry-once; cancel maps to
  skipped bucket.
- Reports: single HTML file (inline CSS, base64 thumbs ≤500KB, step cell `action — detail`,
  trace hint), PDF via hidden `BrowserWindow`.
- Transfer: versioned JSON, dialogs+fs in main, re-exports byte-equal modulo `exportedAt`.
- Sync: wholesale object copy for fetch/push/clone; merge-base walk + entity merge; push
  rejects non-FF and checked-out-branch-of-non-bare; untrusted content zod-validated; blob caps.

## 8. Conventions

TypeScript strict (`noUncheckedIndexedAccess`), zod at every IPC boundary, no `any` in
`src/shared/*`, unit tests for parser/substitution/selectors (`vitest`), `PLAYTEST_E2E=1`
for Chromium legs (`npm run test:e2e`). Match surrounding style; prefer editing existing
files. Never copy dependency versions from memory — check live (`npm view`) before adding.

## 9. Verification

`npm run typecheck && npm test && npm run package -- --dir`, plus `npm run test:e2e` when
runner/recorder/reports change. Manual smoke: record 3-step login → supervised run
(pause/resume) → unsupervised suite of 2 (parallel) → HTML+PDF+failure video exist.

## 10. Known Limits

Packaged-app headed path and Win/macOS install behavior unverified; recorder `npx codegen`
in packaged app unverified; open case tabs keep mounted state after sync pull (refresh on
revisit); pending sync conflicts surface on pull, not status refresh. Toolchain:
`typescript@7.0.2` ↔ `oxlint-tsgolint@7.0.2004` version-locked, upgrade together.

## 11. Status

M1–M10 and M12 complete; transfer (file import/export) and Phase 2 git-sync core + panel
complete; input/assertion parity (9 → 25 actions) complete. M11 closed as wont-do.
