# PlayTest — Specs

> Source of truth for scope, locked decisions, data model, IPC contract, and behavior.
> Status, next actions, and the active milestone plan live in `PLAN.md`.
> `src/shared/*` is the source of truth for types and IPC — if this file conflicts
> with code on behavior, code wins; on intent, §2 wins (needs user approval to change).
> Tags in parentheses (`M14`–`M16`) mark approved changes specified here but not yet
> implemented; the milestone detail lives in `PLAN.md`.

## 1. Vision

Desktop UI for manual testers: Projects → Suites → Test Cases → record via
Playwright codegen → edit steps in workflow graph → run supervised (single) or
unsupervised (single/suite parallel headless) → screenshots + failure video →
self-contained HTML + PDF reports → re-run failures. Local-first, Chromium only.

## 2. Locked Decisions (do not revisit without user approval)

- Shell: Electron + TypeScript (Forge + Vite), React + Tailwind, `@xyflow/react` step graph.
- DB: local-first SQLite (`better-sqlite3` + Drizzle). Artifacts on disk under `~/PlayTestData`.
- Schema evolution: additive tables/indexes only, added to `BOOTSTRAP_DDL` as
  `CREATE … IF NOT EXISTS`. There is no migration runner and no ALTER support. Re-plan approved
  2026-10-17 for `case_profiles` (M14); further table/column changes need their own re-plan.
- Browsers: Chromium only. `playwright install chromium` on first run + in-app progress check.
- Recording: external `playwright codegen` window (not embedded), launched via the resolved
  Playwright CLI through Electron-as-Node (`ELECTRON_RUN_AS_NODE=1`, `npx` fallback) so spawn
  failures and codegen stderr surface in the UI. Parse output → editable steps; unsupported
  codegen lines are reported, never silently converted (M15).
- Steps: 25 actions today, 33 after M15 (see `STEP_ACTIONS` in `src/shared/step-types.ts`);
  table + linear graph; green=pass, red=fail, grey=skipped, blue=running. Click variants
  (button/modifiers/force) and multi-select encode in `value`.
- Execution: suite-parallel (`workers = min(cpu/2, cases)`); direct `playwright` library plus
  `playwright/test`'s `expect` matchers (no test runner — so no UI mode / sharding /
  multi-browser; see Non-goals). One Chromium per runner/suite worker, fresh context per case.
- Assertions: every `assert-*` step runs through Playwright web-first matchers. Strict
  matching (no `.first()`; `assert-count` counts all matches). URL/title values go straight to
  `toHaveURL`/`toHaveTitle`: a plain string is matched exactly (whitespace normalised), the way
  Playwright 1.64 does it — no glob or substring expansion (`waitForURL` is the glob API) — and
  `/pattern/flags` is a RegExp. Default timeout 30 s, overridable per step via `timeoutMs`.
- Case profile (M14): one `case_profiles` row per case — device/viewport/colorScheme/locale/
  timezone, storage-state filenames, dialog policy — drives both `recorder:start` and every
  run. Auth state files live in `~/PlayTestData/<projectId>/auth/` and are never included in
  transfer bundles or git sync.
- Hierarchy: `Project (1) → Suite (N) → Case (N)` via join table (cases reusable across suites).
- Resume: resume-from-failed-step only for supervised single-case runs (context kept open).
  Suites: full re-run or re-run-failed-cases-only.
- Modes: Supervised = single case, headed, pauses, optional `actionDelayMs` pacing.
  Unsupervised = single or suite, headless, never pauses.
- Artifacts: screenshot after every step (bounded retry, animations disabled); video + trace
  retained on failure only; supervised failures persist a trace chunk at the moment of failure
  so evidence survives a later resume. Downloads land in
  `<case dir>/downloads/` (M16).
- Reports: self-contained single-file HTML + PDF export per suite run. Trace opens via
  `playwright show-trace` (button only when `trace.zip` exists).
- Test data: KV `{{key}}` substitution at run time; missing key fails the step with
  `missing test-data key: X`. `source` column reserved for future CSV.
- Transfer: file import/export (`.playtest.json`, versioned) with copy semantics (fresh ids,
  membership by name, target `baseUrl` wins). No runs/artifacts in bundles. Case profiles
  travel (M14); auth state files do not.
- Sync (Phase 2): per-project local-git sync via `src/main/git-sync.ts`, local-path remotes
  only (http(s) rejected), snapshot layout `project.json` + `suites/<id>.json` + `cases/<id>.json`,
  stable DB ids, entity three-way merge, conflicts in `.git/playtest-conflicts.json`.
  Case profiles are part of the case entity (M14).
- M11 closed as wont-do (2026-10-17): Inspector debug via `PWDEBUG=1`/`page.pause()` is not
  viable in-process (env cached at import, pause is a no-op without inspector, cancel/resume
  hang mid-step). Keep supervised resume instead.
- Non-goals: UI Mode, `--project` multi-browser, sharding, `show-report` HTML-reporter,
  retries/timeout config UI, VS Code extension, per-case `testIdAttribute` (Playwright's
  `selectors.setTestIdAttribute` is process-wide and unsafe under parallel suites; a future
  project-level setting via `project_settings` is the sane shape). Post-MVP path: per-project
  `browser` field + `postinstall` line.
- Deferred out of the M13–M16 batch (new re-plan required): `assert-in-viewport`,
  `clear`/`select-text`/`blur`, an explicit wait-for-load-state action, request
  routing/mocking, HTTP credentials, `ignoreHTTPSErrors`, `goto` waitUntil variants,
  tracing `sources`, JSON/JUnit export.

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
    ipc-profiles.ts / playwright-cli.ts   # planned (M14 / M15)
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
- `test_cases(id, projectId, name, description, url, createdAt)` — `url` is the per-case
  recording start URL; when empty the recording falls back to the project `baseUrl`
- `suite_test_cases(suiteId, caseId)` — PK(suiteId, caseId)
- `test_steps(id, caseId, order, action, selector, value, timeoutMs, editedAt)` —
  `action` is plain text; valid values = `STEP_ACTIONS` (25 today, 33 after M15 — see
  `PLAN.md`). Click variants and multi-select
  encode in `value` (`parseClickValue` / `parseSelectValue` in `runner.ts`).
- `test_data(caseId, key, value, source)` — `source='kv'` today.
- `case_profiles(caseId, device, viewportW, viewportH, colorScheme, locale, timezone,
  storageState, saveStorageState, dialogPolicy, updatedAt)` — M14; storage fields are
  filenames under `~/PlayTestData/<projectId>/auth/`; no row = defaults (1280×720, no auth).
- `suite_runs(id, suiteId|null, mode, status, startedAt, endedAt, reportHtmlPath, reportPdfPath)`
- `case_runs(id, suiteRunId, caseId, status, durationMs, videoPath)`
- `step_runs(id, caseRunId, stepId, order, status, error, screenshotPath, durationMs)`

Artifacts: `~/PlayTestData/<projectId>/<suiteRunId>/<caseId>/step-<NN>.png, failed.webm, trace.zip`
(+ `downloads/<file>` after M16). Auth state: `~/PlayTestData/<projectId>/auth/<file>` (M14).

## 5. IPC Contract (`src/shared/ipc-contract.ts` is canonical, zod-validated in main)

- CRUD: `project:*` (create/list/get/update/delete), `suite:*` (+ `suite:setCases`),
  `case:*` (+ `case:get` returns `{case, steps}`), `step:*` (upsert/move/delete/reorder),
  `testdata:get/set`, `profile:get({caseId}) → {profile | null}` / `profile:set({caseId, profile})` (M14).
- Recorder: `recorder:start({caseId})` — main resolves the case `url` (falling back to the
  project `baseUrl`), then the case profile
  (M14; previously explicit emulation/storage fields). `recorder:stop() → {steps, unsupported:
  [{line, reason}], raw}` (M15 adds `unsupported`).
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
  hints/timeout) + KV TestDataEditor + Case URL field + Record options disclosure
  (viewport/device/theme/locale/timezone/storage-state filenames/dialog policy, persisted
  per case via `profile:get/set`) + import preview + paste-locator
  insert + Supervised (with speed selector) / Unsupervised run + live colors + resume/cancel + log.
- RunReportPage: suite summary, per-case step grid with thumbnails, Open-trace buttons,
  Export PDF, Re-run failed.
- Themes: IntelliJ dark (default) + opt-in Syntax light, persisted, pre-paint no-flash.

## 7. Behavior Notes (current, not history)

The approved M14–M16 changes live in `PLAN.md`. Where that plan conflicts with §6–§7 the
plan wins until the milestone lands; this section describes the code as it is today.

- Recorder: argv-only flag builder (`buildCodegenArgs`, allowlisted; viewport `"W,H"` comma,
  locale → `--lang`, unknown device rejects). Parser: goto/fill/select/check/uncheck/press/
  dblclick/type/hover/focus/click/asserts; unknown statements → `wait` + raw fallback, never
  drop data (M15 changes this: unsupported statements are reported to the user instead of
  becoming `wait`). Resolver `resolveLocator` allowlists `getBy*`/locator chains;
  `page.evaluate` / `frameLocator` fail with edit guidance (`frameLocator` support is M15).
- Runner: `SingleCaseRunner` (supervised pause/resume in same context; cancel settles between
  steps) + `SuiteRunner` (worker pool, missing-key pre-scan, fail→skip-rest, settle
  failed > cancelled > passed, best-effort HTML). Screenshot: animations disabled, caret
  hidden, 10 s budget, up to two 250 ms retries (shared `captureStepScreenshot`); cancel maps
  to skipped bucket.
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

`npm run typecheck && npm test && npm run package`, plus `npm run test:e2e` when
runner/recorder/reports change (M14–M16 add e2e files — list them in the `test:e2e` script).
`package` already stops at the unpacked `out/<app>-<platform>-<arch>/` dir; Forge 8 removed the
`--dir` flag (the command in older notes fails with `unknown option '--dir'`).
Manual smoke: record 3-step login → supervised run (pause/resume) → unsupervised suite of 2
(parallel) → HTML+PDF+failure video exist. After M14: record a login with save-state, run a
second case that loads the same state (must start logged in), and open an existing DB (new
table appears without touching old rows).

## 10. Known Limits

Packaged-app headed path and Win/macOS install behavior unverified; M15 replaces `npx` for
codegen and adds `ELECTRON_RUN_AS_NODE` to the trace-viewer spawn — both need one packaged
smoke test; open case tabs keep mounted state after sync pull (refresh on revisit); pending
sync conflicts surface on pull, not status refresh. Toolchain: `typescript@7.0.2` ↔
`oxlint-tsgolint@7.0.2004` version-locked, upgrade together.
