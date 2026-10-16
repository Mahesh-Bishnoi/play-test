import { useEffect, useState } from "react";

import { api } from "../api.js";
import type { Project } from "../../shared/schema.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function inputStyle(): React.CSSProperties {
  return { padding: "6px 8px", border: "1px solid #ccc", borderRadius: 4, fontSize: 14 };
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

interface Props {
  selectedId: string | null;
  onSelect: (projectId: string | null) => void;
}

/**
 * M2 projects CRUD (PLAN §6). Owns project list state; suite/case UI lives in
 * SuiteDetailPage once a project is selected.
 */
export default function ProjectsPage({ selectedId, onSelect }: Props): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editBaseUrl, setEditBaseUrl] = useState("");

  useEffect(() => {
    api
      .listProjects()
      .then(setProjects)
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
  }, []);

  const refresh = (projects: Project[]): void => {
    setProjects([...projects].sort((a, b) => a.name.localeCompare(b.name)));
  };

  const create = (): void => {
    setError(null);
    const trimmed = name.trim();
    if (trimmed === "") {
      return;
    }
    const url = baseUrl.trim();
    api
      .createProject(trimmed, url === "" ? undefined : url)
      .then((created) => {
        refresh([...projects, created]);
        setName("");
        setBaseUrl("");
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
  };

  const remove = (id: string): void => {
    setError(null);
    api
      .deleteProject(id)
      .then(() => {
        refresh(projects.filter((p) => p.id !== id));
        if (selectedId === id) {
          onSelect(null);
        }
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
  };

  const startEdit = (project: Project): void => {
    setEditingId(project.id);
    setEditName(project.name);
    setEditBaseUrl(project.baseUrl ?? "");
  };

  const saveEdit = (): void => {
    if (editingId === null) {
      return;
    }
    const trimmed = editName.trim();
    if (trimmed === "") {
      setError("Project name cannot be empty.");
      return;
    }
    const url = editBaseUrl.trim();
    api
      .updateProject(editingId, { name: trimmed, baseUrl: url === "" ? null : url })
      .then((updated) => {
        refresh(projects.map((p) => (p.id === updated.id ? updated : p)));
        setEditingId(null);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
  };

  return (
    <section aria-label="Projects">
      <h2>Projects</h2>
      {error !== null && (
        <p role="alert" style={{ color: "red" }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <input
          aria-label="Project name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          placeholder="New project name"
          style={inputStyle()}
        />
        <input
          aria-label="Base URL"
          value={baseUrl}
          onChange={(e) => {
            setBaseUrl(e.target.value);
          }}
          placeholder="Base URL (optional)"
          style={{ ...inputStyle(), minWidth: 240 }}
        />
        <button
          type="button"
          onClick={create}
          disabled={name.trim() === ""}
          style={buttonStyle(name.trim() === "")}
        >
          Create
        </button>
      </div>
      {projects.length === 0 ? (
        <p>No projects yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
          {projects.map((p) => (
            <li
              key={p.id}
              style={{
                border: selectedId === p.id ? "2px solid #2563eb" : "1px solid #ccc",
                borderRadius: 6,
                padding: 8,
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              {editingId === p.id ? (
                <>
                  <input
                    aria-label="Edit project name"
                    value={editName}
                    onChange={(e) => {
                      setEditName(e.target.value);
                    }}
                    style={inputStyle()}
                  />
                  <input
                    aria-label="Edit base URL"
                    value={editBaseUrl}
                    onChange={(e) => {
                      setEditBaseUrl(e.target.value);
                    }}
                    style={{ ...inputStyle(), minWidth: 200 }}
                  />
                  <button type="button" onClick={saveEdit} style={buttonStyle()}>
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(null);
                    }}
                    style={buttonStyle()}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(p.id);
                    }}
                    style={{
                      ...buttonStyle(),
                      fontWeight: selectedId === p.id ? "bold" : "normal",
                    }}
                    aria-pressed={selectedId === p.id}
                  >
                    {p.name}
                  </button>
                  {p.baseUrl !== undefined && p.baseUrl !== "" && (
                    <span style={{ color: "#555", fontSize: 13 }}>{p.baseUrl}</span>
                  )}
                  <span style={{ flex: 1 }} />
                  <button
                    type="button"
                    onClick={() => {
                      startEdit(p);
                    }}
                    style={buttonStyle()}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      remove(p.id);
                    }}
                    style={buttonStyle()}
                  >
                    Delete
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
