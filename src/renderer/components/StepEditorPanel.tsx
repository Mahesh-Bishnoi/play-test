import { useState } from "react";

import type { StepRow } from "../../shared/schema.js";
import type { StepAction } from "../../shared/step-types.js";
import { STEP_ACTIONS, listTestDataKeys } from "../../shared/step-types.js";

export interface StepPatch {
  action: StepAction;
  selector?: string;
  value?: string;
  timeoutMs?: number;
}

interface Props {
  step: StepRow;
  /** KV keys stored for this case (testdata:get) — powers `{{key}}` hints. */
  availableKeys: string[];
  busy: boolean;
  onSave: (patch: StepPatch) => void;
  onDelete: (id: string) => void;
}

const ACTION_HINTS: Record<StepAction, string> = {
  goto: "Navigates to a URL — put the URL in Value.",
  click: "Needs a Selector (CSS or Playwright locator).",
  fill: "Needs a Selector plus the text in Value.",
  select: "Needs a Selector plus the option in Value.",
  check: "Needs a Selector (checkbox / radio).",
  press: "Needs a Selector plus the key in Value (e.g. Enter).",
  "assert-visible": "Needs a Selector to assert visible.",
  "assert-text": "Needs a Selector plus the expected text in Value.",
  wait: "Value = milliseconds to sleep, or a Selector to wait for.",
};

function inputStyle(): React.CSSProperties {
  return {
    width: "100%",
    boxSizing: "border-box",
    padding: "6px 8px",
    border: "1px solid #ccc",
    borderRadius: 4,
    fontSize: 14,
  };
}

/**
 * Editor for the selected workflow step (WS3, PLAN §6). Local draft state is
 * reset by the parent via `key={step.id}`; save/delete go through step:upsert
 * / step:delete in CaseDetailPage. Key editing lives in TestDataEditor (M7);
 * this panel only hints at `availableKeys` referenced by the value.
 */
export default function StepEditorPanel({
  step,
  availableKeys,
  busy,
  onSave,
  onDelete,
}: Props): React.JSX.Element {
  const [action, setAction] = useState<StepAction>(step.action as StepAction);
  const [selector, setSelector] = useState(step.selector ?? "");
  const [value, setValue] = useState(step.value ?? "");
  const [timeoutText, setTimeoutText] = useState(
    step.timeoutMs === undefined ? "" : String(step.timeoutMs),
  );
  const [error, setError] = useState<string | null>(null);

  const referenced = listTestDataKeys(value);
  const missing = referenced.filter((key) => !availableKeys.includes(key));

  const save = (): void => {
    const trimmedTimeout = timeoutText.trim();
    let timeoutMs: number | undefined;
    if (trimmedTimeout !== "") {
      const parsed = Number(trimmedTimeout);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        setError("Timeout must be a positive whole number of milliseconds.");
        return;
      }
      timeoutMs = parsed;
    }
    setError(null);
    const patch: StepPatch = { action };
    const trimmedSelector = selector.trim();
    const trimmedValue = value;
    if (trimmedSelector !== "") {
      patch.selector = trimmedSelector;
    }
    if (trimmedValue !== "") {
      patch.value = trimmedValue;
    }
    if (timeoutMs !== undefined) {
      patch.timeoutMs = timeoutMs;
    }
    onSave(patch);
  };

  return (
    <aside
      aria-label="Step editor"
      style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, minWidth: 300 }}
    >
      <h3 style={{ marginTop: 0 }}>
        Step #{step.order + 1} <span style={{ color: "#666" }}>({step.id.slice(0, 8)})</span>
      </h3>
      {error !== null && (
        <p role="alert" style={{ color: "red" }}>
          {error}
        </p>
      )}
      <label style={{ display: "grid", gap: 4, marginBottom: 8 }}>
        Action
        <select
          aria-label="Step action"
          value={action}
          disabled={busy}
          onChange={(e) => {
            setAction(e.target.value as StepAction);
          }}
          style={inputStyle()}
        >
          {STEP_ACTIONS.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <p style={{ fontSize: 12, color: "#555", margin: "0 0 8px" }}>{ACTION_HINTS[action]}</p>
      <label style={{ display: "grid", gap: 4, marginBottom: 8 }}>
        Selector
        <input
          aria-label="Step selector"
          value={selector}
          disabled={busy}
          onChange={(e) => {
            setSelector(e.target.value);
          }}
          placeholder="e.g. #login, text=Sign in"
          style={inputStyle()}
        />
      </label>
      <label style={{ display: "grid", gap: 4, marginBottom: 8 }}>
        Value
        <textarea
          aria-label="Step value"
          value={value}
          disabled={busy}
          onChange={(e) => {
            setValue(e.target.value);
          }}
          placeholder="https://…, text, or {{key}}"
          rows={3}
          style={inputStyle()}
        />
      </label>
      {referenced.length > 0 && (
        <p style={{ fontSize: 12, margin: "0 0 8px" }}>
          References {referenced.map((k) => `{{${k}}}`).join(", ")}
          {missing.length > 0 && (
            <span style={{ color: "#b45309" }}> — missing test-data key: {missing.join(", ")}</span>
          )}
        </p>
      )}
      {availableKeys.length > 0 && (
        <p style={{ fontSize: 12, color: "#555", margin: "0 0 8px" }}>
          Available keys: {availableKeys.map((k) => `{{${k}}}`).join(", ")}
        </p>
      )}
      <label style={{ display: "grid", gap: 4, marginBottom: 12 }}>
        Timeout (ms, optional)
        <input
          aria-label="Step timeout milliseconds"
          value={timeoutText}
          disabled={busy}
          onChange={(e) => {
            setTimeoutText(e.target.value);
          }}
          placeholder="e.g. 5000"
          inputMode="numeric"
          style={inputStyle()}
        />
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          style={{
            padding: "6px 12px",
            border: "1px solid #888",
            borderRadius: 4,
            background: "#fff",
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          Save step
        </button>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Delete step #${step.order + 1} (${step.action})?`)) {
              onDelete(step.id);
            }
          }}
          disabled={busy}
          style={{
            padding: "6px 12px",
            border: "1px solid #888",
            borderRadius: 4,
            background: "#fff",
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          Delete
        </button>
      </div>
    </aside>
  );
}
