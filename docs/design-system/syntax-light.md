# PlayTest design system — “Syntax light” theme

Locked 2026-10-16. Status: approved visual direction, shipped as opt-in theme
alongside the incumbent IntelliJ dark theme (which stays the default).

- Visual golden: `theme-demo.html` at repo root (open in a browser, toggle
  Current dark ↔ Syntax light). Keep it — it is the review artifact.
- Live tokens: `src/renderer/styles.css` under `[data-theme="syntax-light"]`.
- Theme wiring: `src/renderer/theme.ts` (storage key `playtest.theme`) +
  menubar toggle in `src/renderer/App.tsx`, applied in `main.tsx` pre-paint.

## Idea

syntax.fm energy without the black: chunky sticker borders, hard offset
shadows, mono uppercase labels, playful tilted highlight — on a warm
slightly-off-white canvas with orange as the single accent instead of yellow.

## Tokens

| Token | Syntax light | Was (dark) | Use |
|---|---|---|---|
| `--pt-bg` | `#FAF7F1` | `#1E1F22` | app background |
| `--pt-bg-raised` | `#FFFFFF` | `#242528` | raised surfaces |
| `--pt-sidebar` / `--pt-card` | `#FFFFFF` | `#2B2D30` | sidebar, cards |
| `--pt-card-2` | `#FFF4E8` | `#313438` | tinted card |
| `--pt-muted` | `#F1ECE2` | `#393B40` | neutral fills |
| `--pt-border` | `#141210` | `#393B40` | strong borders (2px) |
| `--pt-border-soft` | `#E7DFD2` | `#393B40` | hairlines |
| `--pt-fg` | `#141210` | `#DFE1E5` | body text |
| `--pt-fg-dim` | `#2A2723` | `#BCBEC4` | secondary text |
| `--pt-muted-fg` | `#6F6860` | `#868A93` | muted / placeholders |
| `--pt-accent` | `#FF5C00` | `#3574F0` | primary / active |
| `--pt-accent-hover` | `#E04E00` | `#4682F2` | hover |
| `--pt-accent-ink` | `#141210` | `#FFFFFF` | text on accent (dark-on-orange, like black-on-yellow) |
| `--pt-selection-accent` | `rgb(255 92 0 / .16)` | `rgb(53 116 240 / .28)` | selected tint |
| pass / fail / running | `#166534` / `#b42318` / `#0b6b94` | `#6AAB73` / `#F26B6F` / `#4CB0E0` | status (darker for light bg) |
| `--pt-radius` / `--pt-radius-sm` | `14px` / `9px` | `6px` / `4px` | friendlier corners |
| `--pt-shadow` | `4px 4px 0 #141210` | `0 8px 28px rgb(0 0 0 / .45)` | hard offset shadow |

Supporting washes: pass `#E5F6EA`, fail `#FDE7E5`, running `#E2F2FA`,
warn `#FFF1D6`, selection `#FFE9D6`, table head `#FBF3E7`, log ink `#FFE9D6`
on `#141210`.

## Component rules (light only)

- Borders go 1px → 2px near-black `#141210` on cards, buttons, inputs,
  table wraps, tabs, inline forms; hairlines stay `#E7DFD2`.
- Hard shadow `4px 4px 0 #141210` on cards and table wraps; buttons get
  `3px 3px 0` at rest, `4px 4px 0` + lift on hover, collapse to `0` on press.
- Active tab is filled orange with dark text; sidebar section labels become
  dark sticker pills; active tree rows get orange wash + hard shadow.
- Run log inverts to a dark chip (`#141210` bg, `#FFE9D6` text).
- Mono (`JetBrains Mono` stack) is for data only: counts, ids, timings, table
  heads, labels — never body copy.

## Accessibility notes

- Body `#141210` on `#FAF7F1` ≈ 15:1. Muted `#6F6860` on bg ≈ 5:1 (passes
  4.5:1 — do not lighten it further).
- Dark-on-orange (`#141210` on `#FF5C00` ≈ 5.4:1) is the only acceptable
  accent pairing; white-on-orange (~2.8:1) fails and must not be used.
- Status colors are darkened vs dark theme so badges pass on white.

## Adding a third theme later

1. Add a value to `AppTheme` in `theme.ts`.
2. Add a `[data-theme="<name>"]` token block + overrides in `styles.css`.
3. Extend the menubar toggle (cycle or select) — persistence is automatic.
4. Update this doc + `theme-demo.html` with the new swatches.
