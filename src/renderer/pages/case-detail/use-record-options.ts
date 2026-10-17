import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { TestCase } from "../../../shared/schema.js";
import { api, formatApiError } from "../../api.js";
import {
  CASE_URL_SAVE_DEBOUNCE_MS,
  DEFAULT_PROFILE_FORM,
  PROFILE_SAVE_DEBOUNCE_MS,
  normalizeCaseUrl,
  profileToForm,
  toProfileInput,
} from "./profile-form.js";
import type { ProfileForm } from "./profile-form.js";

export interface RecordOptions {
  profileForm: ProfileForm;
  patchProfile: (patch: Partial<ProfileForm>) => void;
  /** Persist the profile now, skipping the debounce (used before recording starts). */
  saveProfileNow: () => Promise<void>;
  caseUrl: string;
  setCaseUrl: Dispatch<SetStateAction<string>>;
  /** Persist the URL now, skipping the debounce (used before recording starts). */
  flushCaseUrl: () => Promise<void>;
}

/**
 * Record-options state for one case (M14): the profile form and the record-start
 * URL, both loaded when the case changes and persisted ~500 ms after the last
 * edit — skipped whenever the value still matches what the server has, so a
 * reload (or the empty default) never writes back. `onError`/`onCaseSaved` must
 * be stable (they are effect dependencies).
 */
export function useRecordOptions(options: {
  caseId: string;
  /** The loaded case whose URL prefills the input, or null while loading. */
  loadedCase: TestCase | null;
  onError: (message: string) => void;
  /** Called with the updated case whenever a URL save lands. */
  onCaseSaved: (updated: TestCase) => void;
}): RecordOptions {
  const { caseId, loadedCase, onError, onCaseSaved } = options;
  const [profileForm, setProfileForm] = useState<ProfileForm>(DEFAULT_PROFILE_FORM);
  // Serialized last-saved profile so a reload (or the empty default) never writes
  // back what the server already has, and edits save once typing pauses.
  const savedProfileRef = useRef<string>(JSON.stringify(toProfileInput(DEFAULT_PROFILE_FORM)));
  // Per-case record-start URL (M14): prefilled from the loaded case, saved on a
  // debounce. Same no-rewrite guard as the profile form; the case id the prefill
  // last ran for keeps a later refresh from clobbering in-flight edits.
  const [caseUrl, setCaseUrl] = useState("");
  const savedCaseUrlRef = useRef<string>(JSON.stringify(normalizeCaseUrl("")));
  const urlPrefilledForRef = useRef<string | null>(null);

  // Load the persisted profile whenever the selected case changes (M14). The
  // form (and the saved ref) reset synchronously first so a debounced save from
  // the previous case can never land under the new case id.
  useEffect(() => {
    const empty = JSON.stringify(toProfileInput(DEFAULT_PROFILE_FORM));
    setProfileForm(DEFAULT_PROFILE_FORM);
    savedProfileRef.current = empty;
    api
      .profileGet(caseId)
      .then((profile) => {
        const form = profileToForm(profile);
        setProfileForm(form);
        savedProfileRef.current = JSON.stringify(toProfileInput(form));
      })
      .catch((err: unknown) => {
        onError(formatApiError(err));
      });
  }, [caseId, onError]);

  // Debounced persistence: write ~500 ms after the last edit (M14). Skipped when
  // the form still matches what the server has.
  useEffect(() => {
    const input = toProfileInput(profileForm);
    const serialized = JSON.stringify(input);
    if (serialized === savedProfileRef.current) {
      return;
    }
    const timer = window.setTimeout(() => {
      api
        .profileSet(caseId, input)
        .then(() => {
          savedProfileRef.current = serialized;
        })
        .catch((err: unknown) => {
          onError(formatApiError(err));
        });
    }, PROFILE_SAVE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [caseId, profileForm, onError]);

  // Reset the URL form + saved ref synchronously on a case switch so a debounced
  // write from the previous case can never land under the new case id (M14).
  useEffect(() => {
    setCaseUrl("");
    savedCaseUrlRef.current = JSON.stringify(normalizeCaseUrl(""));
    urlPrefilledForRef.current = null;
  }, [caseId]);

  // Prefill the Case URL from the loaded case once per case (M14). Keyed on the
  // loaded case id so refreshes after other mutations don't overwrite in-flight
  // edits, while a switch back to a case re-reads its stored URL.
  useEffect(() => {
    if (loadedCase === null || urlPrefilledForRef.current === loadedCase.id) {
      return;
    }
    urlPrefilledForRef.current = loadedCase.id;
    const url = loadedCase.url ?? "";
    setCaseUrl(url);
    savedCaseUrlRef.current = JSON.stringify(normalizeCaseUrl(url));
  }, [loadedCase]);

  // Debounced URL persistence: write ~500 ms after the last edit (most recent
  // wins), skipped when the value still matches what the server has (M14).
  useEffect(() => {
    const normalized = normalizeCaseUrl(caseUrl);
    const serialized = JSON.stringify(normalized);
    if (serialized === savedCaseUrlRef.current) {
      return;
    }
    const timer = window.setTimeout(() => {
      api
        .updateCase(caseId, { url: normalized })
        .then((updated) => {
          savedCaseUrlRef.current = serialized;
          onCaseSaved(updated);
        })
        .catch((err: unknown) => {
          onError(formatApiError(err));
        });
    }, CASE_URL_SAVE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [caseId, caseUrl, onError, onCaseSaved]);

  const patchProfile = useCallback((patch: Partial<ProfileForm>): void => {
    setProfileForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const saveProfileNow = useCallback((): Promise<void> => {
    const input = toProfileInput(profileForm);
    return api.profileSet(caseId, input).then(() => {
      savedProfileRef.current = JSON.stringify(input);
    });
  }, [caseId, profileForm]);

  // Persist the URL now, bypassing the debounce — used before the recorder starts
  // so it begins from exactly what the field shows (M14).
  const flushCaseUrl = useCallback((): Promise<void> => {
    const normalized = normalizeCaseUrl(caseUrl);
    const serialized = JSON.stringify(normalized);
    if (serialized === savedCaseUrlRef.current) {
      return Promise.resolve();
    }
    return api.updateCase(caseId, { url: normalized }).then((updated) => {
      savedCaseUrlRef.current = serialized;
      onCaseSaved(updated);
    });
  }, [caseId, caseUrl, onCaseSaved]);

  return { profileForm, patchProfile, saveProfileNow, caseUrl, setCaseUrl, flushCaseUrl };
}
