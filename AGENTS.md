# AGENTS.md — How to Work on PlayTest (Multi-Agent)

Read `PLAN.md` first. It is the source of truth for scope, decisions, and status. This file tells you **how to use it**.

## 1. Startup checklist (every agent, every session)
1. Read `PLAN.md` fully — §2 (Locked Decisions), §5 (IPC Contract).
2. Check `git log --oneline -10` + `git status` for what's done/in progress (history lives in git, not PLAN.md).
3. Respect ownership in PLAN §3. Edit only your area unless the task says otherwise.

## 2. Workstream rules
- `src/shared/*` (contracts, step types) is frozen — don't change without updating all consumers + noting why in the commit message.
- Small, reviewable edits. Match existing style. TypeScript strict, zod-validate all IPC payloads.
- Never commit secrets, browsers, or `~/PlayTestData` artifacts. No `rm -rf`, no network-wide commands.

## 3. How to record work
- PLAN.md is a current-state spec, not a log — do not append history rows.
- Update PLAN.md only when scope, IPC, or schema changes (plus §11 Status when a milestone opens/closes).
- Locked Decisions (§2) need user approval — propose, don't assume.

## 4. Definition of Done per task
- Code + `npm run typecheck` clean (PLAN §9 if a narrower check is documented there).
- Unit tests for parser/substitution if touched (`vitest`).
- Manual smoke where applicable: create project → add step → run → report exists.
- Commit message lists files changed + checks run + outcome.

## 5. Coordination
- Before editing another area's files: keep the diff minimal, explain why in the commit message.
- If blocked (contract mismatch, missing shared types): stop, don't invent parallel contracts — ask the user.
- Prefer editing existing files over creating new ones.

## 6. Dependency version policy
- Never copy dependency versions from memory. Before adding or upgrading any dependency, check the latest stable version first (e.g. `npm view <pkg> version`, `npm view <pkg> versions --json | tail`), then pin/add it.
- Use latest stable unless PLAN.md or a project convention pins otherwise; if you deliberately pin older, note why in the commit message.

## 7. Quick commands (see repo README/AGENTS overrides if present)
- `npm run typecheck`, `npm test`, `npm run package -- --dir`

## 8. Commits (agent policy)
- Never create unsigned commits (`--no-gpg-sign` is forbidden).
- Before committing, verify signing works (it requires the user's SSH key passphrase, unavailable in agent sessions). If the commit fails with `ssh_askpass` / `incorrect passphrase` errors: stop, leave changes staged, and hand the user the exact `git commit -m "..."` command to run themselves.

## 9. Skills in use (`/setup` record)
- Library wired project-locally: `.opencode/opencode.jsonc` `skills` entry points at `/home/mahesh/code/skills/skills` (machine-local, never commit personal path).
- Design taste (project-local, 2026-10-16): `@ui-ux-pro-max` at `.opencode/skills/ui-ux-pro-max` (via `uipro init --ai opencode`, target `opencode`) + `@design-taste-frontend` at `.agents/skills/design-taste-frontend` (variant `design-taste-frontend` v2). Scope: project-local. Scan: taste installer reported Safe / 0 alerts / Low Risk; `skillspector scan` timed out (no verdict recorded).
