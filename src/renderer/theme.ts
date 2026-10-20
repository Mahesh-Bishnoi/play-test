export type AppTheme = "intellij-dark" | "syntax-light";

export const THEME_STORAGE_KEY = "playtest.theme";

export function isAppTheme(value: unknown): value is AppTheme {
  return value === "intellij-dark" || value === "syntax-light";
}

/** Default stays the incumbent dark theme; light is opt-in via the menubar toggle. */
export function getInitialTheme(): AppTheme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isAppTheme(stored)) {
      return stored;
    }
  } catch {
    // Private mode / storage blocked: fall back to dark.
  }
  return "intellij-dark";
}

export function applyTheme(theme: AppTheme): void {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Best-effort persistence only.
  }
}
