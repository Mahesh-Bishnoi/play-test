import { useState } from "react";

import { api } from "../api.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buttonStyle(disabled?: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    border: "1px solid #888",
    borderRadius: 4,
    background: disabled === true ? "#eee" : "#fff",
    cursor: disabled === true ? "not-allowed" : "pointer",
    fontSize: 14,
  };
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
 * the case's rows via `testdata:set` (fail-fast: the handler validates before
 * deleting, so a rejected save changes nothing). Patterns reference keys as
 * `{{key}}`; runners substitute at spec-gen time and fail the step on a
 * missing key. Key-shape enforcement stays server-side (`TestDataSetPayload`
 * is the single source of truth) — this panel surfaces its message as-is.
 */
export default function TestDataEditor({ caseId, initial, onSaved }: Props): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(initial).map(([key, value]) => ({ key, value })),
  );
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <div style={{ display: "grid", gap: 8 }}>
      {error !== null && (
        <p role="alert" style={{ color: "red", margin: 0 }}>
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <p style={{ color: "#666", margin: 0 }}>No keys yet — add the first one below.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: 4 }}>Key</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: 4 }}>
                Value
              </th>
              <th style={{ borderBottom: "1px solid #ccc", padding: 4 }} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.key}>
                <td
                  style={{
                    padding: 4,
                    borderBottom: "1px solid #eee",
                    fontFamily: "ui-monospace, monospace",
                    fontSize: 13,
                  }}
                >
                  {row.key}
                </td>
                <td style={{ padding: 4, borderBottom: "1px solid #eee" }}>
                  <input
                    aria-label={`Value for ${row.key}`}
                    value={row.value}
                    disabled={saving}
                    onChange={(e) => {
                      setRowValue(index, e.target.value);
                    }}
                    style={{
                      padding: "6px 8px",
                      border: "1px solid #ccc",
                      borderRadius: 4,
                      width: "100%",
                    }}
                  />
                </td>
                <td style={{ padding: 4, borderBottom: "1px solid #eee", textAlign: "right" }}>
                  <button
                    type="button"
                    aria-label={`Delete key ${row.key}`}
                    disabled={saving}
                    onClick={() => {
                      deleteRow(index);
                    }}
                    style={buttonStyle(saving)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          aria-label="New key"
          placeholder="key"
          value={newKey}
          disabled={saving}
          onChange={(e) => {
            setNewKey(e.target.value);
          }}
          style={{ padding: "6px 8px", border: "1px solid #ccc", borderRadius: 4, width: 160 }}
        />
        <input
          aria-label="New value"
          placeholder="value"
          value={newValue}
          disabled={saving}
          onChange={(e) => {
            setNewValue(e.target.value);
          }}
          style={{ padding: "6px 8px", border: "1px solid #ccc", borderRadius: 4, width: 240 }}
        />
        <button type="button" onClick={addRow} disabled={saving} style={buttonStyle(saving)}>
          Add key
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          title={dirty ? "Replace stored keys with the table above" : "No unsaved changes"}
          style={buttonStyle(saving || !dirty)}
        >
          {saving ? "Saving…" : "Save test data"}
        </button>
      </div>
    </div>
  );
}

/** Sorted entries so draft-vs-stored comparison ignores row order. */
function canonical(rows: Row[]): Array<[string, string]> {
  return rows
    .map((row): [string, string] => [row.key, row.value])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
