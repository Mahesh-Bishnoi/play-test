import { useState } from "react";

import type { StepRow } from "../../shared/schema.js";
import type { StepAction } from "../../shared/step-types.js";
import { STEP_ACTIONS, listTestDataKeys } from "../../shared/step-types.js";
import ConfirmDialog from "./ConfirmDialog.js";

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
  click: "Needs a Selector. Value is optional: right, double, shift/ctrl/alt/meta, force, or JSON.",
  dblclick: "Needs a Selector (double-click).",
  fill: "Needs a Selector plus the text in Value.",
  type: "Needs a Selector plus the text in Value (typed char-by-char).",
  select: "Needs a Selector plus the option in Value (JSON array for multi-select).",
  check: "Needs a Selector (checkbox / radio).",
  uncheck: "Needs a Selector (checkbox).",
  hover: "Needs a Selector to hover.",
  focus: "Needs a Selector to focus.",
  press: "Needs a Selector plus the key in Value (e.g. Enter).",
  "assert-visible": "Needs a Selector to assert visible.",
  "assert-hidden": "Needs a Selector to assert hidden.",
  "assert-text": "Needs a Selector plus the expected text in Value.",
  "assert-value": "Needs a Selector plus the expected field value in Value.",
  "assert-checked": "Needs a Selector to assert checked.",
  "assert-unchecked": "Needs a Selector to assert unchecked.",
  "assert-enabled": "Needs a Selector to assert enabled.",
  "assert-disabled": "Needs a Selector to assert disabled.",
  "assert-editable": "Needs a Selector to assert editable.",
  "assert-focused": "Needs a Selector to assert focused.",
  "assert-count": "Needs a Selector plus the expected count in Value.",
  "assert-url": "Value = expected URL text (substring or /regex/).",
  "assert-title": "Value = expected page-title text (substring or /regex/).",
  wait: "Value = milliseconds to sleep, or a Selector to wait for.",
};

/**
 * Editor for the selected workflow step (WS3, PLAN §6).
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
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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
    <aside aria-label="Step editor" className="pt-editor">
      <div className="pt-section-head">
        <h3>
          Step #{step.order + 1} <span className="pt-mono pt-hint">{step.id.slice(0, 8)}</span>
        </h3>
        <span className="pt-badge">{action}</span>
      </div>
      {error !== null && (
        <p role="alert" className="pt-alert pt-alert-error">
          {error}
        </p>
      )}
      <div className="pt-form-grid">
        <label className="pt-label">
          Action
          <select
            aria-label="Step action"
            className="pt-select"
            value={action}
            disabled={busy}
            onChange={(e) => {
              setAction(e.target.value as StepAction);
            }}
          >
            {STEP_ACTIONS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <p className="pt-hint">{ACTION_HINTS[action]}</p>
        <label className="pt-label">
          Selector
          <input
            aria-label="Step selector"
            className="pt-input pt-mono"
            value={selector}
            disabled={busy}
            onChange={(e) => {
              setSelector(e.target.value);
            }}
            placeholder="e.g. #login, text=Sign in"
          />
        </label>
        <p className="pt-hint">
          Tip: in the codegen window use Pick Locator → Copy, then paste the locator here.
        </p>
        <label className="pt-label">
          Value
          <textarea
            aria-label="Step value"
            className="pt-textarea pt-mono"
            value={value}
            disabled={busy}
            onChange={(e) => {
              setValue(e.target.value);
            }}
            placeholder="https://…, text, or {{key}}"
            rows={3}
          />
        </label>
        {referenced.length > 0 && (
          <p className="pt-hint">
            References {referenced.map((k) => `{{${k}}}`).join(", ")}
            {missing.length > 0 && (
              <span className="pt-warn-text"> — missing test-data key: {missing.join(", ")}</span>
            )}
          </p>
        )}
        {availableKeys.length > 0 && (
          <p className="pt-hint">
            Available keys: {availableKeys.map((k) => `{{${k}}}`).join(", ")}
          </p>
        )}
        <label className="pt-label">
          Timeout (ms, optional)
          <input
            aria-label="Step timeout milliseconds"
            className="pt-input"
            value={timeoutText}
            disabled={busy}
            onChange={(e) => {
              setTimeoutText(e.target.value);
            }}
            placeholder="e.g. 5000"
            inputMode="numeric"
          />
        </label>
        <div className="pt-row">
          <button
            type="button"
            className="pt-btn pt-btn-primary pt-btn-sm"
            onClick={save}
            disabled={busy}
          >
            Save step
          </button>
          <button
            type="button"
            className="pt-btn pt-btn-danger-ghost pt-btn-sm"
            title={`Delete step #${step.order + 1} (asks first)`}
            onClick={() => {
              setConfirmingDelete(true);
            }}
            disabled={busy}
          >
            Delete
          </button>
        </div>
      </div>
      {confirmingDelete && (
        <ConfirmDialog
          title={`Delete step #${step.order + 1} (${step.action})?`}
          body="The step is removed and the steps after it move up. This cannot be undone."
          confirmLabel={`Delete step #${step.order + 1}`}
          onConfirm={() => {
            setConfirmingDelete(false);
            onDelete(step.id);
          }}
          onCancel={() => {
            setConfirmingDelete(false);
          }}
        />
      )}
    </aside>
  );
}
