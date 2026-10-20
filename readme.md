# PlayTest — Manual-Tester Studio

Desktop app for manual testers: create Projects → Suites → Test Cases → record flows with Playwright codegen → edit steps in a workflow graph → run supervised or unsupervised → get screenshots, failure video, and self-contained HTML + PDF reports.

Built with Electron + TypeScript + React + hand-written CSS, SQLite (`better-sqlite3` + Drizzle ORM) local-first storage, and Playwright (Chromium only in MVP) for record/run.

## Features

- **Project / Suite / Case hierarchy** — cases are reusable across suites via a join table. Suite detail has checkbox selection, select-all/none, search, and a pre-run confirm dialog.
- **Record via Playwright codegen** — launches an external `playwright codegen` window against the project's base URL, parses the output into editable `TestStep[]`, with an import-preview modal. Unparseable lines are kept as raw fallback, never dropped.
- **Workflow step editor** — linear `@xyflow/react` chain + step table; node colors by last run status (green pass / red fail / grey skipped / blue running). Edit action, selector, value (with `{{key}}` hints), timeout; drag/arrow reorder.
- **35 step actions** — `goto | click | dblclick | fill | type | select | check | uncheck | press | hover | focus | assert-visible | assert-hidden | assert-text | assert-value | assert-checked | assert-unchecked | assert-enabled | assert-disabled | assert-editable | assert-focused | assert-count | assert-url | assert-title | wait | assert-text-exact | assert-attribute | assert-attached | reload | go-back | go-forward | upload | drag | wait-url | scroll-into-view` (canonical list: `src/shared/step-types.ts`). Recorder `getBy*`/`locator` chains are resolved without `eval`.
- **Supervised single-case runs** — headed, one worker, pauses on failure with context kept open. Resume-from-failed-step (re-runs edited step + followers in the same context) or full re-run. Optional pre-run speed control (Instant / 0.6s / 1.5s / 3s pacing between steps).
- **Unsupervised runs** — single case or whole suite, headless, suite-parallel from day one (`workers = max(1, min(cpu/2, cases))`).
- **Artifacts** — screenshot after every step; video + trace retained on failure only. Stored under `~/PlayTestData/<projectId>/<suiteRunId>/<caseId>/` (`step-NN.png`, `failed.webm`, `trace.zip`).
- **Reports** — self-contained single-file HTML (inline CSS, base64 thumbnails, drill-down suite → case → step with error stacks) + PDF export (headless Chromium print). Per suite run, with Re-run-failed-cases-only.
- **Test data (KV)** — per-case key/value table, `{{key}}` substitution at run time. Missing key fails the step with `missing test-data key: X`. Schema reserves a `source` column for future CSV.
- **First-run browser setup** — checks for Playwright Chromium on boot, banner with install progress; `postinstall` also installs it.
- **Packaging** — Electron Forge + Forge makers (Squirrel, ZIP, deb, rpm); browsers excluded from asar.

## How to use it

1. **Create a project** — name + base URL (e.g. `http://localhost:4137` for the bundled dummy site).
2. **Add suites and cases** — in the sidebar explorer, `+` a suite, then `+ Add case` under it (auto-assigns to that suite).
3. **Record steps** — open a case tab, enter the page URL, Record → interact in the codegen window → Stop → tick the steps to import in the preview.
4. **Edit steps** — click a graph node to edit action/selector/value/timeout; reorder by drag or arrows. Add KV test data (`{{username}}`) in the Test Data section.
5. **Run**
   - Case tab → **Run supervised** (headed, pause/resume) or **Run unsupervised** (headless).
   - Suite page → select cases → **Run Suite** (unsupervised, parallel).
6. **Review** — Run Report page: counts/durations, per-case step grid with thumbnails, Export PDF, Re-run failed.

### Try it with the dummy site

A zero-dependency fake income-tax portal ships in-repo for manual trials:

```sh
npm run dummy:tax-site   # serves http://localhost:4137, creds test@example.com / password123
npm run seed:dummy-tax    # seeds ~/PlayTestData with DummyTax project + "Tax flows" suite (Login, File ITR-1, Respond to notice)
```

## Development

Prerequisites: Node.js (see `.nvmrc` if present, else current LTS) + npm. Chromium is installed automatically via `postinstall` (~170 MB).

```sh
npm install        # installs deps + playwright chromium
npm start          # dev: Electron + Vite hot reload
npm run verify     # typecheck + lint + format check + coverage-gated unit tests
npm test           # vitest unit suite
npm run test:e2e   # hermetic e2e (spins up local fixture + dummy-tax servers, ~27s)
```

Runtime data lives outside the repo in `~/PlayTestData/playtest.db` + artifact folders — never commit it.

## Build for different platforms

| Command | Output | Platform |
|---|---|---|
| `npm run package` | `out/playtest-linux-x64/` (unpacked dir) | current OS, quick check |
| `npm run make` | installers per configured maker | current OS |

Configured makers (`forge.config.ts`): Squirrel (Windows `.exe`), deb + rpm (Linux), zip (macOS). Build on the target OS for that OS's installer (or use CI runners per OS) — Electron installers are not cross-compiled.

```sh
# Windows (on a Windows machine / CI runner)
npm run make   # → Squirrel .exe

# Linux (on Linux)
npm run make   # → .deb + .rpm

# macOS (on a Mac)
npm run make   # → .zip
```

Notes:

- First run on a fresh machine: the app checks for the Playwright Chromium build and offers one-click install with progress if missing.
- The packaged app bundles the `better-sqlite3` native binding (rebuilt at package time, unpacked from asar via `asar.unpack **/*.node`); dev `npm start` uses the project-local binding.
- `npx playwright codegen` recording inside the packaged app is functional but minimally verified — dev-mode recording is the well-tested path.
