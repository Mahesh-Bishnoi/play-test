import type { CaseProfile, CaseProfileInput } from "../../../shared/schema.js";

/** Debounce for persisting record-option edits to the case profile (M14). */
export const PROFILE_SAVE_DEBOUNCE_MS = 500;

/** Debounce for persisting the per-case record-start URL (M14). */
export const CASE_URL_SAVE_DEBOUNCE_MS = 500;

/** Case URL input → the `case:update` value (blank clears it to null). */
export function normalizeCaseUrl(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Record-options form (M14): mirrors the per-case `CaseProfileInput`. Values stay
 * as the raw strings the inputs hold so blanks can be omitted on save; viewport
 * width/height are parsed back to numbers.
 */
export interface ProfileForm {
  viewportW: string;
  viewportH: string;
  device: string;
  colorScheme: "" | "light" | "dark";
  locale: string;
  timezone: string;
  /** Bare filenames resolved under `~/PlayTestData/<projectId>/auth/`. */
  storageState: string;
  saveStorageState: string;
  /** Run-only: seeds `sessionStorage` before the first script (M17). */
  sessionState: string;
  dialogPolicy: "default" | "accept" | "dismiss";
}

export const DEFAULT_PROFILE_FORM: ProfileForm = {
  viewportW: "",
  viewportH: "",
  device: "",
  colorScheme: "",
  locale: "",
  timezone: "",
  storageState: "",
  saveStorageState: "",
  sessionState: "",
  dialogPolicy: "default",
};

/** Persisted profile (or none) → form values. */
export function profileToForm(profile: CaseProfile | null): ProfileForm {
  if (profile === null) {
    return DEFAULT_PROFILE_FORM;
  }
  return {
    viewportW: profile.viewportW !== undefined ? String(profile.viewportW) : "",
    viewportH: profile.viewportH !== undefined ? String(profile.viewportH) : "",
    device: profile.device ?? "",
    colorScheme: profile.colorScheme ?? "",
    locale: profile.locale ?? "",
    timezone: profile.timezone ?? "",
    storageState: profile.storageState ?? "",
    saveStorageState: profile.saveStorageState ?? "",
    sessionState: profile.sessionState ?? "",
    dialogPolicy: profile.dialogPolicy ?? "default",
  };
}

/** Form values → sparse `CaseProfileInput` (blank fields omitted). */
export function toProfileInput(form: ProfileForm): CaseProfileInput {
  const profile: CaseProfileInput = {};
  if (form.viewportW.trim() !== "") {
    profile.viewportW = Number(form.viewportW);
  }
  if (form.viewportH.trim() !== "") {
    profile.viewportH = Number(form.viewportH);
  }
  if (form.device.trim() !== "") {
    profile.device = form.device.trim();
  }
  if (form.colorScheme !== "") {
    profile.colorScheme = form.colorScheme;
  }
  if (form.locale.trim() !== "") {
    profile.locale = form.locale.trim();
  }
  if (form.timezone.trim() !== "") {
    profile.timezone = form.timezone.trim();
  }
  if (form.storageState.trim() !== "") {
    profile.storageState = form.storageState.trim();
  }
  if (form.saveStorageState.trim() !== "") {
    profile.saveStorageState = form.saveStorageState.trim();
  }
  if (form.sessionState.trim() !== "") {
    profile.sessionState = form.sessionState.trim();
  }
  // "default" is Playwright's own behavior — equivalent to leaving it unset.
  if (form.dialogPolicy !== "default") {
    profile.dialogPolicy = form.dialogPolicy;
  }
  return profile;
}
