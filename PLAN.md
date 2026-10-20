# PLAN.md — agent scratchpad

> Status, remaining work, and decisions. Specs live in `SPECS.md`; completed-work history
> lives in git. Keep this file current and edit it freely — no history rows.
> Commit prefixes use the milestone id (`M13: …`).

## Status

| Milestone | Status | Notes |
| --- | --- | --- |
| M1–M19 | done | M19 (whole-repo review fixes) landed 2026-10-20; `npm run verify` + `npm run test:e2e` green |
| M20 | pending | Follow-ups below; no active milestone |

Current work: none in progress. `npm run verify` includes coverage thresholds; e2e is 9
files / 46 tests. Deferred feature work lives in `SPECS.md` §2 and needs a new re-plan.

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
- **Clean-code debt.** Merge the duplicated single/suite runner step loops and split
  `use-suite-detail.ts` by reason to change; do this after the correctness fixes.

## Future re-plan candidates

Left for a future re-plan (all need new UI/schema or are deferred in `SPECS.md` §2):
`page.clock`, live tracing (`tracing.start({ live: true })`), HAR capture, `goto`/`reload`
`waitUntil` encodings, `serviceWorkers: 'block'`, `httpCredentials`/`ignoreHTTPSErrors`,
`assert-in-viewport`, CSV/JSON/JUnit export.
