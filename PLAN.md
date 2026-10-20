# PLAN.md — agent scratchpad

> Status, remaining work, and decisions. Specs live in `SPECS.md`; completed-work history
> lives in git. Keep this file current and edit it freely — no history rows.
> Commit prefixes use the milestone id (`M13: …`).

## Status

| Milestone | Status | Notes |
| --- | --- | --- |
| M1–M19 | done | M19 (whole-repo review fixes) landed 2026-10-20; `npm run verify` + `npm run test:e2e` green |
| M20 | pending | Follow-ups below; clean-code debt partly reduced by M21 |
| M21 | done | Live suite/case progress landed 2026-10-20; verify + e2e + package green |

Current work: none in progress. `npm run verify` includes coverage thresholds; deferred feature
work lives in `SPECS.md` §2 and needs a new re-plan.

## M21 — live run progress (approved 2026-10-20)

The suite page previously had only a transient notice, the case page only graph colours, and a
mid-run report froze at its first snapshot. M21 adds:

- `runner:getProgress({suiteRunId})` (read-only snapshot, no schema/DDL change) + a ~1 s poll.
- Suite case lifecycle: `pending` (queued) → `running` (worker claimed) → `passed | failed |
  cancelled`; reconcile/settle close pending rows too.
- Case page: step progress bar from `run:step-update` (starting/running/paused/passed/failed/
  cancelled), with the denominator captured at run start.
- Suite page: full live panel (overall bar, per-case badges, elapsed, Cancel, View report),
  `App`-owned run id so the panel survives tab switches, plus a compact strip on other tabs.
- Report page: live banner + "snapshot" hint; `report:getHtml` regenerates while the run is
  active; pending/cancelled status styles in the report HTML.
- Pure models + the bar's ARIA markup are unit-tested (`tests/run-progress.test.ts`,
  `tests/step-progress.test.ts`, `tests/progress-model.test.ts`,
  `tests/run-progress-bar.test.ts`); e2e runs because runner/report behaviour changed.
- Verified 2026-10-20: `npm run verify` (346 tests, coverage 49.8/48.3/36.5/50.2),
  `npm run test:e2e` (46 tests), and `npx electron-forge package` with an npm
  `npm_config_user_agent` override (the ambient shell advertises pnpm, which Forge refuses).

Overlap with M20: the live monitor lives in `components/run-progress/` rather than growing
`use-suite-detail.ts`, and the stale `lastSuiteRunId` button was removed. The **duplicated
single/suite runner step loops** and the remaining full `use-suite-detail.ts` split are still
deferred to the clean-code-debt item.

## M20 — remaining work

Confirmed review findings deliberately deferred from M19, with the decision each needs:

- **Recorder-tab recovery (#3).** Closing a case tab while codegen is open leaves the
  process-wide recorder active, so the next start fails until restart. Needs a
  `recorder:status` channel or lifted recorder state, plus a UX choice (reopen, stop, or
  discard the recording).
- **Unsaved suite membership ticks (#4).** Switching suites silently drops unsaved ticks.
  Needs a user-facing choice: prompt before switching, or autosave membership.
- **Export membership by name (#12).** Import maps suites by case name, so duplicate names
  can attach the wrong case and unknown names are dropped silently. Needs export v2 with
  stable case keys (keep the v1 reader).
- **CSP (#14).** No Content-Security-Policy. Verify dev HMR vs the packaged app before
  adding a meta tag or session header.
- **Clean-code debt.** Merge the duplicated single/suite runner step loops and split the rest of
  `use-suite-detail.ts` by reason to change; do this after the correctness fixes. M21 already
  moved live run monitoring into `components/run-progress/` and lifted the active run id to
  `App`, so only the runner-loop merge + membership/feedback split remain.

## Future re-plan candidates

Left for a future re-plan (all need new UI/schema or are deferred in `SPECS.md` §2):
`page.clock`, live tracing (`tracing.start({ live: true })`), HAR capture, `goto`/`reload`
`waitUntil` encodings, `serviceWorkers: 'block'`, `httpCredentials`/`ignoreHTTPSErrors`,
`assert-in-viewport`, CSV/JSON/JUnit export.
