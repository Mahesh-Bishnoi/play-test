# DummyTax — fake income-tax portal for PlayTest trials

**DUMMY SITE. Not a government website. No real data. Localhost only.**

A zero-dependency fake tax portal to point PlayTest at while testing
record → run → report flows.

## Run it

```bash
node dummy-tax-site/server.js --port 4137
# → http://127.0.0.1:4137
```

Or via npm:

```bash
npm run dummy:tax-site
```

Reset all in-memory state between test runs:

```bash
curl http://127.0.0.1:4137/__reset
```

## Automated e2e coverage

`tests/e2e-dummy-tax-site.test.ts` drives the real product runners
(`SingleCaseRunner` + `SuiteRunner`, real headless Chromium) against this
site spawned as a child process on an ephemeral port — no manual server
needed:

```bash
PLAYTEST_E2E=1 npx vitest run tests/e2e-dummy-tax-site.test.ts
npm run test:e2e   # both e2e files (fixture shop + tax portal)
```

Covered: login (happy/negative/keyboard-Enter/locator-chains), auth-guard
redirect, profile update with cross-page assert, ITR filing
(select/fill/check/submit → acknowledgement → history), filing validation
errors, notice filter/open/respond, `wait`, step move/reorder, parallel
suite (3/3) + HTML report, failure video + mixed suite + rerun-failed,
and missing-KV-key fail-fast.

## Login

| Email            | Password    |
| ---------------- | ----------- |
| test@example.com | password123 |

Unauthenticated pages redirect to `/login`. Wrong credentials show
`#login-error`.

## What to test against it

| PlayTest flow              | Steps on DummyTax                                                        |
| -------------------------- | ------------------------------------------------------------------------ |
| Record login               | `goto /` → click login → `fill` email + password → click Sign in → `assert-text` on `#welcome` |
| Form submission            | `/file-return`: `fill` salary/other/80C, `select` AY, `check` verify → submit → `assert-visible` `#acknowledgement` |
| Negative validation        | Submit without ticking verify → `#form-error`; bad PAN → `#form-error`   |
| Profile update             | `/profile`: `fill` name/phone/address → Save → `assert-visible` `#profile-saved` |
| Notices                    | `/notices`: `fill` + submit filter form; click `notice-link-*` → detail → `fill` response → `assert-visible` `#response-saved` |
| KV data substitution       | `{{pan}}`, `{{salary}}`, `{{customer}}` into ITR / profile fields        |
| Parallel suite             | Login + file-return + notices cases run headless in parallel             |

Every key element carries a stable `id` + `data-testid`
(`login-form`, `itr-form`, `acknowledgement`, `profile-saved`,
`notice-row`, `response-saved`, …) so Playwright codegen output stays
stable across runs.

## Routes

- `/` landing (or dashboard when logged in)
- `/login`, `/logout`
- `/dashboard` (shows `#welcome`, open-notice badge, filing count)
- `/profile` (GET form, POST saves)
- `/file-return` (ITR-1 form), `/filing-success?id=…`, `/filings` (history)
- `/notices?status=Open|Closed`, `/notices/:id`, `POST /notices/:id/respond`
- `/health` (JSON), `/__reset` (test helper)
