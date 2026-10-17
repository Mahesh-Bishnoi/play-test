# PLAN.md — agent scratchpad

> Working file for agents: status, next actions, milestone breakdown, notes. Keep it
> current and edit it freely — no history rows needed (`git log` is the history).
> Specs (scope, locked decisions, schema, IPC) live in `SPECS.md`; update that file only
> when the spec changes, and never edit `SPECS.md` §2 without user approval.
> Prefix commits for planned work with the milestone id (`M13: …`).

## Status

| Milestone | Status | Notes |
| --- | --- | --- |
| M13 — Playwright `expect` assertions + diagnostics | in progress | items 1–3 done; next item 4 |
| M14 — Case profiles: recorded environment applied at run time | not started | after M13 |
| M15 — Recorder & locator coverage + new actions | not started | after M14 |
| M16 — Runtime parity: popups and downloads | not started | after M15 |

Completed: M1–M10, M12; file transfer (import/export) and Phase-2 git-sync core;
input/assertion parity (9 → 25 actions). M11 closed as wont-do (`SPECS.md` §2).

Order M13 → M14 → M15 → M16; each milestone leaves `npm run verify` green. New files
follow existing naming (`src/main/ipc-*.ts`, `tests/*.test.ts`, e2e legs added to the
`test:e2e` script). Rule of thumb: if Playwright exposes a native API for a behavior,
use it instead of reimplementing.

Background: this batch came from an audit of playwright.dev docs (actionability,
best-practices, assertions, auth, locators, navigations, videos, trace-viewer, codegen)
against the current implementation.

## M13 — Playwright `expect` assertions + diagnostics

Status: in progress · Next: item 4 (`screenshot` options + retry)

Goal: every `assert-*` step runs through Playwright web-first matchers; errors keep
Playwright's full detail; failure evidence survives a supervised resume.

- [x] **1.** `vite.main.config.ts` — keep `playwright/test` external: replace `"playwright"`
      with `/^playwright($|\/)/` (or add `"playwright/test"`); the exact-match entry would
      bundle the subpath.
- [x] **2.** `src/main/runner.ts` — `import { expect } from "playwright/test"` (ships inside
      the installed `playwright` package; no `@playwright/test` dependency). Replace
      `pollState`, the count loop, the URL/title loops, `matchesText`, and the `.first()` waits:
      - visible/hidden → `toBeVisible` / `toBeHidden`; enabled/disabled → `toBeEnabled` /
        `toBeDisabled`; editable/focused → `toBeEditable` / `toBeFocused`; checked/unchecked →
        `toBeChecked` / `not.toBeChecked()`; value → `toHaveValue` (JSON array value →
        `toHaveValues`); text → `toContainText`; count → `toHaveCount`; url → `toHaveURL`;
        title → `toHaveTitle`.
      - URL/title: plain string = **exact** match, `/pattern/flags` = RegExp. **Corrected
        2026-10-17:** the plan said "anchored glob"; verified against Playwright 1.64.1
        (`toHaveURL` → `serializeExpectedTextValues`), plain strings are exact and no glob is
        expanded (`**/x` fails, substring fails). Glob semantics belong to `waitForURL`, not
        `toHaveURL`/`toHaveTitle`. User chose native passthrough (no hand-rolled glob shim);
        `SPECS.md` §2 wording amended 2026-10-17 (user-approved) to the exact-match semantics.
        Existing e2e fixtures that relied on substring values were switched to `/regex/`.
      - Strict matching: no `.first()` — `assert-text` on a selector that resolves to several
        elements now fails with Playwright's "resolved to N elements" strict-mode error.
        `assert-count` keeps counting all matches.
      - Every matcher gets `{ timeout: timeoutMs ?? 30_000 }` (`assertTimeout` helper).
- [x] **3.** Error fidelity — `asMessage` was already deleted with item 2; added
      `formatStepError(err)` (keeps the full Playwright message + call log, trims trailing
      whitespace, caps at 8 000 chars) used for `step_runs.error`, report cells and the run
      log in both `runner.ts` and `suite-runner.ts`; the old `slice(0, 20000)` in
      `updateStepRun` is gone now that the formatter owns the bound.
- [ ] **4.** Screenshots — `page.screenshot({ animations: 'disabled', caret: 'hide', timeout })`;
      up to 2 retries 250 ms apart instead of the single 1 s retry; warn after the last failure.
- [ ] **5.** Trace — start with `title: <case name>`; wrap each step in
      `context.tracing.group('Step N · action — detail')` / `groupEnd()`. A failure while
      paused (supervised) calls `stopChunk({ path: <caseDir>/trace.zip })` immediately, then
      `startChunk()` so a resume keeps tracing; resume-pass/cancel calls `stop()` without a
      path so the failure chunk stays; a later failure overwrites `trace.zip`.
- [ ] **6.** Video — extend `RunContext` with `saveVideo(dest)` / `discardVideo()` backed by
      `Video.saveAs()/delete()`; drop the rename/unlink helpers (path builders stay).
- [ ] **7.** Tests — new `tests/e2e-assertions.test.ts` (real Chromium): strict violation
      reports `resolved to N elements`; a `/regex/` URL value patterns a dynamic path while a
      plain string stays exact; title drift fails; full call log is present in the step error;
      supervised failure writes `trace.zip` before the pause. Update `tests/runner.test.ts` fakes for
      the `RunContext` additions; add the e2e file to `test:e2e`.

**Done when:** no hand-rolled polling remains, error text shows Playwright's diff, and
`npm run verify` + `npm run package` (Forge 8 dropped the old `--dir` flag; plain
`package` already writes `out/…-linux-x64`), plus the new e2e leg pass.

## M14 — Case profiles: recorded environment applied at run time

Status: not started · Next: item 1 (`case_profiles` DDL) — after M13

Goal: recording environment == run environment; one persisted profile per case; one browser
per suite worker with a fresh context per case.

- [ ] **1.** Schema (additive only): `case_profiles` per `SPECS.md` §4 — in `src/main/db.ts`
      `BOOTSTRAP_DDL` and the Drizzle `src/main/schema.ts`. Cleanup on case delete
      (`ipc-cases.ts`) and sync-pull deletes; no FKs (services enforce cleanup, existing
      convention).
- [ ] **2.** Contract: `CaseProfile` type in `src/shared/schema.ts`; `CaseProfileSchema` +
      `profile:get` / `profile:set` in `src/shared/ipc-contract.ts`, registered in
      `IPC_CONTRACT`. Validation: device regex as the current recorder payload; viewport
      ints 100..7680 / 100..4320; colorScheme light|dark; locale/timezone as today;
      `storageState`/`saveStorageState` are bare filenames matching
      `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; `dialogPolicy` ∈ default|accept|dismiss;
      `updatedAt` server-set. Reuse the recorder regexes — one helper, no second dialect.
- [ ] **3.** `src/main/ipc-profiles.ts` — get/set/delete helpers + `resolveAuthStatePath(projectId,
      filename)` → `~/PlayTestData/<projectId>/auth/<filename>` (reject anything but a bare
      filename). Missing auth file at run time fails before launching with `auth state missing:
      <file> — record the login flow again or clear the profile field`.
- [ ] **4.** Recorder: `recorder:start({caseId})`; the main handler resolves project `baseUrl`
      + profile into the existing `RecorderStartOptions` (absolute storage paths,
      viewport/device/locale/timezone/colorScheme). `CodegenRecorder.start(baseUrl, options)`
      keeps its shape; resolution lives in `ipc-register.ts` (or a helper it calls).
- [ ] **5.** Launcher seam (also removes the per-case browser cost):

      ```ts
      interface ContextLaunchOptions {
        videoDir: string; viewport?: { width: number; height: number }; device?: string;
        colorScheme?: "light" | "dark"; locale?: string; timezoneId?: string;
        storageState?: string; baseURL?: string; dialogPolicy?: "default" | "accept" | "dismiss";
      }
      interface BrowserHandle {
        newContext(o: ContextLaunchOptions): Promise<RunContext>;
        close(): Promise<void>;
      }
      interface BrowserLauncher { launchBrowser(headless: boolean): Promise<BrowserHandle> }
      ```

      `playwrightLauncher()` maps to `browser.newContext({ ...devices[device], viewport,
      colorScheme, locale, timezoneId, storageState, baseURL, recordVideo: { dir: videoDir,
      size: viewport ?? { width: 1280, height: 720 } } })`; `dialogPolicy` attaches
      `page.on('dialog')` accept/dismiss per page. An explicit viewport wins over the device
      preset (hint in the UI when both are set). `RunContext.close()` closes only the context;
      the owner closes the browser — `SingleCaseRunner`: one browser per run; `SuiteRunner`: one
      per worker, `newContext` per case. Update `main.ts` wiring and both runner test fakes.
- [ ] **6.** Runners: load the profile (`getCaseProfile(db, caseId)`) in `runSingle`,
      `SuiteRunner.runOneCase`, and `resumeFromStep` (an already-open context keeps its
      original profile). `runSingle` / `runSuite` payloads are unchanged.
- [ ] **7.** Renderer: `CaseDetailPage.tsx` drops the `playtest.recorder.options` localStorage
      key and loads/saves the profile through `profile:get`/`profile:set` (debounced, errors
      surfaced); `api.ts` gains `profileGet`/`profileSet`. Run buttons unchanged.
- [ ] **8.** Transfer/sync: `ExportCaseSchema` (`src/shared/export-format.ts`) and git-sync
      `SnapshotCaseSchema` gain an optional `profile`; import writes it; sync treats it as
      part of the case entity (write/pull/merge). No version bump — old readers strip the
      unknown field.
- [ ] **9.** Tests — profile CRUD + validation, recorder start from the profile (fakes),
      runners pass options to the fake launcher, transfer round-trip, `git-sync-merge`,
      `ipc-register` channels, and opening an existing DB creates the table. New
      `tests/e2e-profiles.test.ts`: a cookie-gated local-site page passes only with the
      profile's `storageState`; a device profile changes the screenshot dimensions.

**Done when:** no emulation option is read from localStorage; a login recorded with save-state
is reused by later runs (`SPECS.md` §9 smoke); suite runs still pass after the browser-reuse
refactor.

## M15 — Recorder & locator coverage + new actions

Status: not started · Next: item 1 (parser `unsupported` reporting) — after M14

Goal: imported codegen either runs faithfully or is loudly rejected; the step vocabulary
covers common real-app interactions.

- [ ] **1.** Parser (`src/main/recorder.ts`): `parseCodegenOutput` returns `{ steps, unsupported:
      [{ line, reason }] }`; unknown `expect(...)` / `page.*` statements go to `unsupported`
      (never `assert-visible`, never a raw `wait` step). `recorder:stop` carries the list;
      `RecorderImportPreview` shows the lines so users add manual steps.
- [ ] **2.** New mappings: click modifiers/`clickCount`/`button` → existing click value
      encoding; `toHaveText` → `assert-text-exact`; `toHaveAttribute` → `assert-attribute`
      (`name=expected`, `/re/` stays RegExp); `toBeAttached` → `assert-attached`;
      `reload`/`goBack`/`goForward` → actions; `setInputFiles` → `upload` (path or JSON array);
      `dragTo` → `drag` (selector = source locator, value = target locator; needs two-locator
      extraction in the parser); `selectOption({label|value|index})` → JSON object value
      (extend `parseSelectValue`).
- [ ] **3.** Actions 25 → 33 in `src/shared/step-types.ts`, `executeStep` / `RunPage` /
      `PlaywrightRunPage`, and `StepEditorPanel` labels/hints:
      - `assert-text-exact` (`toHaveText`; JSON array = multi-element), `assert-attribute`,
        `assert-attached`;
      - `reload`, `go-back`, `go-forward` (guidance when there is no history);
      - `upload` (clear error when the path does not exist);
      - `drag` (`locator.dragTo(target, { timeout })`).
- [ ] **4.** Resolver/allowlist (`src/shared/locator-allowlist.ts`, `runner.ts`,
      `src/renderer/components/pick-locator.ts`): `page.frameLocator(...)` factory with
      `FrameLocator` chains (`getBy*`, `locator`, nested `frameLocator`); `filter({ has | hasNot })`
      with a recursively parsed locator; `or()/and()` only if the literal parser stays clean.
      Keep the no-eval guarantees (arg length/nesting caps).
- [ ] **5.** CLI spawn hardening: new `src/main/playwright-cli.ts` — resolve `playwright/cli.js`
      via `createRequire`, spawn `process.execPath` with `ELECTRON_RUN_AS_NODE=1` (detached for
      the viewer, piped stderr for codegen). Recorder falls back to `npx playwright codegen`
      when resolution fails, captures a stderr tail, and `start()` waits a short injectable
      grace period (~1.5 s), throwing `RecorderStartError(stderrTail)` if the child already
      exited. `trace-viewer.ts` uses the same helper (fixes the missing env).
- [ ] **6.** Tests — parser (new mappings + unsupported reporting), locator-resolve
      (frameLocator, filter has), `shared-contracts` (33 actions), runner/suite fakes for the
      new actions, pick-locator, trace-viewer env.

**Done when:** a flow with an iframe, an upload, a drag, and a reload imports into runnable
steps, and an unsupported assertion is visible before running rather than silently skipped.

## M16 — Runtime parity: popups and downloads

Status: not started · Next: item 1 (click tokens + parser) — after M15

Goal: clicks that open a tab or start a download behave like Playwright's own patterns.

- [ ] **1.** Click value tokens `popup` / `download` (same encoding as `force`/`right`; extend
      `parseClickValue`) and parser support for the codegen `waitForEvent('popup'|'download')`
      promise pattern.
- [ ] **2.** `RunPage.click` options gain `popup`/`download`; `PlaywrightRunPage`:
      - popup → `Promise.all([context.waitForEvent('page'), click])`, adopt the new page for
        subsequent steps (dialog policy re-attached; tracing is context-level);
      - download → `Promise.all([page.waitForEvent('download'), click])`,
        `download.saveAs(<caseDir>/downloads/<sanitized suggestedFilename>)`, run-log the path.
- [ ] **3.** After a click without the token: if `context.pages().length` grew, run-log a
      warning suggesting the `popup` token (no auto-adoption).
- [ ] **4.** Tests — parser tokens; runner fake simulating a second page and a download; new
      `tests/e2e-popup-download.test.ts` against the local site (`target=_blank` + download
      link); update the `test:e2e` list.

**Done when:** a recorded OAuth-style popup flow and a download flow run end-to-end.

---

Deferred items (out of scope for M13–M16, new re-plan required): `SPECS.md` §2.

## Notes

Scratch space for the active milestone — blockers, findings, decisions to raise. Move
anything durable to `SPECS.md`.
