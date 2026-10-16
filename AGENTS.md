# AGENTS.md — How to Work on PlayTest (Multi-Agent)

Read `PLAN.md` first. It is the source of truth for scope, decisions, and status. This file tells you **how to use it**.

## 1. Startup checklist (every agent, every session)
1. Read `PLAN.md` fully — sections 2 (Locked Decisions), 5 (IPC Contract), 12 (Workstreams).
2. Check section 14 Status Ledger — find your WS row, see what's done/remaining.
3. Claim work: add a row `| <date> | <WS> | Claimed: <milestone/task> | ... |` before writing code.
4. Respect file ownership in §12. Edit only your WS paths unless ledger notes a cross-WS exception.

## 2. Workstream rules
- One agent per WS (WS1–WS6). WS1 (`src/shared/*`, DB schema) freezes contracts first — others must not change shared types without a ledger entry + updating all consumers.
- Small, reviewable edits. Match existing style. TypeScript strict, zod-validate all IPC payloads.
- Never commit secrets, browsers, or `~/PlayTestData` artifacts. No `rm -rf`, no network-wide commands.

## 3. How to record work in PLAN.md
- Update checkboxes in §13 Milestones when a milestone is fully verified.
- Append to §14 Status Ledger (never rewrite history):
  `| YYYY-MM-DD | WSx | Done: ... | Remaining: ... | Notes: files changed, checks run |`
- If you change scope, IPC, or schema: add a `Notes:` entry explaining why + what WSs are affected. Locked Decisions (§2) need user approval — propose, don't assume.

## 4. Definition of Done per task
- Code + `npm run typecheck` clean (or WS-specific check in §17).
- Unit tests for parser/substitution if touched (`vitest`).
- Manual smoke where applicable: create project → add step → run → report exists.
- Ledger row added with files changed + checks run + outcome.

## 5. Coordination
- Before editing another WS's files: note it in ledger first, keep diff minimal.
- If blocked (contract mismatch, missing WS1 types): log `Blocked: ...` in ledger, stop, don't invent parallel contracts.
- Prefer editing existing files over creating new ones.

## 6. Dependency version policy
- Never copy dependency versions from memory. Before adding or upgrading any dependency, check the latest stable version first (e.g. `npm view <pkg> version`, `npm view <pkg> versions --json | tail`), then pin/add it.
- Use latest stable unless PLAN.md or a project convention pins otherwise; if you deliberately pin older, note why in the Status Ledger.

## 7. Quick commands (see repo README/AGENTS overrides if present)
- `npm run typecheck`, `npm test`, `npm run package -- --dir`
