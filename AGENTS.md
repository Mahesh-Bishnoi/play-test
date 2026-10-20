# AGENTS.md — How to Work on PlayTest (Multi-Agent)

Read `SPECS.md` first — the source of truth for scope, locked decisions, the data model, and the IPC contract. `PLAN.md` is the agent scratchpad: milestone breakdown, current status, next actions. This file tells you **how to use them**.

## 1. Startup checklist (every agent, every session)
1. Read `SPECS.md` fully — §2 (Locked Decisions), §5 (IPC Contract).
2. Read `PLAN.md` — the status table + the milestone you are picking up.
3. Check `git log --oneline -10` + `git status` for what's done/in progress (history lives in git, not in the docs).
4. Respect ownership in SPECS §3. Edit only your area unless the task says otherwise.

## 2. Workstream rules
- `src/shared/*` (contracts, step types) is frozen — don't change without updating all consumers + noting why in the commit message.
- Small, reviewable edits. Match existing style. TypeScript strict, zod-validate all IPC payloads.
- Never commit secrets, browsers, or `~/PlayTestData` artifacts. No `rm -rf`, no network-wide commands.

## 3. How to record work
- `SPECS.md` is a current-state spec, not a log — update it only when scope, IPC, schema, or a locked decision changes. Locked Decisions (`SPECS.md` §2) need user approval — propose, don't assume.
- `PLAN.md` is the scratchpad — keep its status table and the active milestone's `Status:` line (and checkboxes) current as you go. Edit it freely; no history rows.
- Commit messages for planned work start with the milestone id (`M13: …`).

## 4. Definition of Done per task
- Code + `npm run typecheck` clean (SPECS §9 if a narrower check is documented there).
- Unit tests for parser/substitution if touched (`vitest`).
- Manual smoke where applicable: create project → add step → run → report exists.
- Commit message lists files changed + checks run + outcome.

## 5. Coordination
- Before editing another area's files: keep the diff minimal, explain why in the commit message.
- If blocked (contract mismatch, missing shared types): stop, don't invent parallel contracts — ask the user.
- Prefer editing existing files over creating new ones.

## 6. Dependency version policy
- Never copy dependency versions from memory. Before adding or upgrading any dependency, check the latest stable version first (e.g. `npm view <pkg> version`, `npm view <pkg> versions --json | tail`), then pin/add it.
- Use latest stable unless SPECS.md or a project convention pins otherwise; if you deliberately pin older, note why in the commit message.

## 7. Quick commands (see repo README/AGENTS overrides if present)
- `npm run typecheck`, `npm test`, `npm run package`

## 8. Commits (agent policy)
- Never create unsigned commits (`--no-gpg-sign` is forbidden).
- Before committing, verify signing works (it requires the user's SSH key passphrase, unavailable in agent sessions). If the commit fails with `ssh_askpass` / `incorrect passphrase` errors: stop, leave changes staged, and hand the user the exact `git commit -m "..."` command to run themselves.

## 9. Skills in use (`/setup` record)
- Library wired project-locally: `.opencode/opencode.jsonc` `skills` entry points at `/home/mahesh/code/skills/skills` (machine-local, never commit personal path).
- Design taste (project-local, 2026-10-16): `@ui-ux-pro-max` at `.opencode/skills/ui-ux-pro-max` (via `uipro init --ai opencode`, target `opencode`) + `@design-taste-frontend` at `.agents/skills/design-taste-frontend` (variant `design-taste-frontend` v2). Scope: project-local. Scan: taste installer reported Safe / 0 alerts / Low Risk; `skillspector scan` timed out (no verdict recorded).
- DSH (project-local, 2026-10-18): DSH's `dsh-skill-filesystem` provider scans `.agents/skills`, where every bundle from `.opencode/skills` and the external library root is linked with a relative symlink. `.agents/` stays machine-local and gitignored; rerun the same idempotent `ln -sfn` loop after installing or removing a bundle.
