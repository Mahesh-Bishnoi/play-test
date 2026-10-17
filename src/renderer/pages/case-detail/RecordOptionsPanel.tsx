import type { ProfileForm } from "./profile-form.js";

interface Props {
  form: ProfileForm;
  busy: boolean;
  recording: boolean;
  onPatch: (patch: Partial<ProfileForm>) => void;
}

/**
 * Record-options form (M14/M17): viewport, device, theme, locale, timezone,
 * dialog policy, and the auth/session state filenames. A collapsed panel so the
 * common path (record → run) stays uncluttered; edits are persisted by the
 * owning page's debounce.
 */
export default function RecordOptionsPanel({
  form,
  busy,
  recording,
  onPatch,
}: Props): React.JSX.Element {
  const disabled = busy || recording;
  return (
    <details className="pt-panel">
      <summary>Record options (viewport, device, theme, locale, auth state, dialogs)</summary>
      <div className="pt-row pt-mb-10">
        <label className="pt-label-inline">
          Viewport W
          <input
            aria-label="Record viewport width"
            className="pt-input pt-mono"
            inputMode="numeric"
            placeholder="1280"
            value={form.viewportW}
            disabled={disabled}
            onChange={(e) => {
              onPatch({ viewportW: e.target.value });
            }}
          />
        </label>
        <label className="pt-label-inline">
          H
          <input
            aria-label="Record viewport height"
            className="pt-input pt-mono"
            inputMode="numeric"
            placeholder="720"
            value={form.viewportH}
            disabled={disabled}
            onChange={(e) => {
              onPatch({ viewportH: e.target.value });
            }}
          />
        </label>
        <label className="pt-label-inline">
          Device
          <input
            aria-label="Record device"
            className="pt-input"
            placeholder="iPhone 11"
            value={form.device}
            disabled={disabled}
            onChange={(e) => {
              onPatch({ device: e.target.value });
            }}
          />
        </label>
        <label className="pt-label-inline">
          Theme
          <select
            aria-label="Record color scheme"
            className="pt-select"
            value={form.colorScheme}
            disabled={disabled}
            onChange={(e) => {
              onPatch({ colorScheme: e.target.value as ProfileForm["colorScheme"] });
            }}
          >
            <option value="">Default</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </div>
      <div className="pt-row pt-mb-10">
        <label className="pt-label-inline">
          Locale
          <input
            aria-label="Record locale"
            className="pt-input pt-mono"
            placeholder="en-GB"
            value={form.locale}
            disabled={disabled}
            onChange={(e) => {
              onPatch({ locale: e.target.value });
            }}
          />
        </label>
        <label className="pt-label-inline">
          Timezone
          <input
            aria-label="Record timezone"
            className="pt-input pt-mono"
            placeholder="Europe/Rome"
            value={form.timezone}
            disabled={disabled}
            onChange={(e) => {
              onPatch({ timezone: e.target.value });
            }}
          />
        </label>
        <label className="pt-label-inline">
          Dialogs
          <select
            aria-label="Dialog policy"
            className="pt-select"
            value={form.dialogPolicy}
            disabled={disabled}
            onChange={(e) => {
              onPatch({ dialogPolicy: e.target.value as ProfileForm["dialogPolicy"] });
            }}
            title="How native dialogs (alert/confirm/prompt) are handled while recording and running"
          >
            <option value="default">Default (unhandled stay open)</option>
            <option value="accept">Auto-accept</option>
            <option value="dismiss">Auto-dismiss</option>
          </select>
        </label>
      </div>
      <div className="pt-row">
        <label className="pt-label-inline">
          Load storage state
          <input
            aria-label="Load storage state filename"
            className="pt-input pt-mono"
            placeholder="login.json"
            value={form.storageState}
            disabled={disabled}
            onChange={(e) => {
              onPatch({ storageState: e.target.value });
            }}
          />
        </label>
        <label className="pt-label-inline">
          Save storage state
          <input
            aria-label="Save storage state filename"
            className="pt-input pt-mono"
            placeholder="login.json"
            value={form.saveStorageState}
            disabled={disabled}
            onChange={(e) => {
              onPatch({ saveStorageState: e.target.value });
            }}
          />
        </label>
        <label className="pt-label-inline">
          Session storage
          <input
            aria-label="Session storage filename"
            className="pt-input pt-mono"
            placeholder="session.json"
            value={form.sessionState}
            disabled={disabled}
            onChange={(e) => {
              onPatch({ sessionState: e.target.value });
            }}
          />
        </label>
      </div>
      <p className="pt-hint">
        Auth state takes a bare filename (e.g. login.json) kept in this project's auth directory —
        log in once with Save set, then reuse the file via Load. Session storage is runs-only
        (recording cannot seed it): save <code>JSON.stringify(sessionStorage)</code> from DevTools
        into that file. An explicit viewport overrides the device preset. The other options drive
        both recording and runs.
      </p>
    </details>
  );
}
