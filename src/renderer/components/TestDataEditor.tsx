import { useState } from "react";

import { api } from "../api.js";
import ConfirmDialog from "./ConfirmDialog.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Row {
  key: string;
  value: string;
}

interface Props {
  caseId: string;
  /** Stored KV record at mount (remount per case via `key`). */
  initial: Record<string, string>;
  onSaved: () => void;
}

/**
 * KV test-data editor (M7, PLAN §10). Draft rows edit locally; Save replaces
 * the case's rows via `testdata:set`.
 */
export default function TestDataEditor({ caseId, initial, onSaved }: Props): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(initial).map(([key, value]) => ({ key, value })),
  );
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDeleteIndex, setPendingDeleteIndex] = useState<number | null>(null);

  const dirty =
    JSON.stringify(canonical(rows)) !==
    JSON.stringify(Object.entries(initial).sort(([a], [b]) => (a < b ? -1 : 1)));

  const setRowValue = (index: number, value: string): void => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, value } : row)));
  };

  const deleteRow = (index: number): void => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  };

  const addRow = (): void => {
    const key = newKey.trim();
    if (key === "") {
      setError("Key must not be empty.");
      return;
    }
    if (rows.some((row) => row.key === key)) {
      setError(`Key "${key}" already exists — edit the row above.`);
      return;
    }
    setError(null);
    setRows((prev) => [...prev, { key, value: newValue }]);
    setNewKey("");
    setNewValue("");
  };

  const save = (): void => {
    setSaving(true);
    setError(null);
    api
      .setTestData(caseId, Object.fromEntries(rows.map((row) => [row.key, row.value])))
      .then(() => {
        onSaved();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {error !== null && (
        <p role="alert" className="pt-alert pt-alert-error" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="pt-empty" style={{ margin: 0 }}>
          No keys yet — add the first one below.
        </p>
      ) : (
        <div className="pt-table-wrap">
          <table className="pt-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Value</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.key}>
                  <td className="pt-mono">{row.key}</td>
                  <td>
                    <input
                      aria-label={`Value for ${row.key}`}
                      className="pt-input"
                      style={{ inlineSize: "100%" }}
                      value={row.value}
                      disabled={saving}
                      onChange={(e) => {
                        setRowValue(index, e.target.value);
                      }}
                    />
                  </td>
                  <td style={{ textAlign: "end" }}>
                    <button
                      type="button"
                      aria-label={`Delete key ${row.key}`}
                      title={`Delete key ${row.key} (asks first)`}
                      className="pt-btn pt-btn-danger-ghost pt-btn-sm"
                      disabled={saving}
                      onClick={() => {
                        setPendingDeleteIndex(index);
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="pt-row">
        <input
          aria-label="New key"
          className="pt-input"
          placeholder="key"
          value={newKey}
          disabled={saving}
          onChange={(e) => {
            setNewKey(e.target.value);
          }}
          style={{ maxInlineSize: 180 }}
        />
        <input
          aria-label="New value"
          className="pt-input"
          placeholder="value"
          value={newValue}
          disabled={saving}
          onChange={(e) => {
            setNewValue(e.target.value);
          }}
          style={{ maxInlineSize: 260 }}
        />
        <button type="button" className="pt-btn pt-btn-sm" onClick={addRow} disabled={saving}>
          Add key
        </button>
        <button
          type="button"
          className="pt-btn pt-btn-primary pt-btn-sm"
          onClick={save}
          disabled={saving || !dirty}
          title={dirty ? "Replace stored keys with the table above" : "No unsaved changes"}
        >
          {saving ? "Saving…" : "Save test data"}
        </button>
      </div>
      {pendingDeleteIndex !== null && rows[pendingDeleteIndex] !== undefined && (
        <ConfirmDialog
          title={`Delete key “${rows[pendingDeleteIndex]?.key}”?`}
          body="Steps referencing {{key}} will fail with a missing-key error until the reference is removed. Save afterwards to persist."
          confirmLabel={`Delete ${rows[pendingDeleteIndex]?.key}`}
          onConfirm={() => {
            if (pendingDeleteIndex !== null) {
              deleteRow(pendingDeleteIndex);
            }
            setPendingDeleteIndex(null);
          }}
          onCancel={() => {
            setPendingDeleteIndex(null);
          }}
        />
      )}
    </div>
  );
}

/** Sorted entries so draft-vs-stored comparison ignores row order. */
function canonical(rows: Row[]): Array<[string, string]> {
  return rows
    .map((row): [string, string] => [row.key, row.value])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
