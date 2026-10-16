import { useEffect, useState } from "react";

import { api } from "../api.js";
import type { Project } from "../../shared/schema.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Props {
  selectedId: string | null;
  onSelect: (projectId: string | null) => void;
}

/**
 * M2 projects CRUD (PLAN §6). Sidebar-compact: stacked create form + list.
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
    <section aria-label="Projects" style={{ display: "grid", gap: 12 }}>
      {error !== null && (
        <p role="alert" className="pt-alert pt-alert-error">
          {error}
        </p>
      )}
      <div className="pt-form-grid">
        <input
          aria-label="Project name"
          className="pt-input"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          placeholder="New project name"
        />
        <input
          aria-label="Base URL"
          className="pt-input"
          value={baseUrl}
          onChange={(e) => {
            setBaseUrl(e.target.value);
          }}
          placeholder="Base URL (optional)"
        />
        <button
          type="button"
          className="pt-btn pt-btn-primary"
          onClick={create}
          disabled={name.trim() === ""}
        >
          New project
        </button>
      </div>
      {projects.length === 0 ? (
        <p className="pt-empty">No projects yet.</p>
      ) : (
        <ul className="pt-list">
          {projects.map((p) => (
            <li
              key={p.id}
              className={`pt-list-item${selectedId === p.id ? " pt-list-item-active" : ""}`}
            >
              {editingId === p.id ? (
                <div className="pt-form-grid" style={{ inlineSize: "100%" }}>
                  <input
                    aria-label="Edit project name"
                    className="pt-input"
                    value={editName}
                    onChange={(e) => {
                      setEditName(e.target.value);
                    }}
                  />
                  <input
                    aria-label="Edit base URL"
                    className="pt-input"
                    value={editBaseUrl}
                    onChange={(e) => {
                      setEditBaseUrl(e.target.value);
                    }}
                  />
                  <div className="pt-row">
                    <button
                      type="button"
                      className="pt-btn pt-btn-primary pt-btn-sm"
                      onClick={saveEdit}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="pt-btn pt-btn-sm"
                      onClick={() => {
                        setEditingId(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="pt-btn pt-btn-ghost pt-btn-sm"
                    onClick={() => {
                      onSelect(p.id);
                    }}
                    aria-pressed={selectedId === p.id}
                    style={{ fontWeight: selectedId === p.id ? 800 : 600 }}
                  >
                    {p.name}
                  </button>
                  {p.baseUrl !== undefined && p.baseUrl !== "" && (
                    <span
                      className="pt-mono pt-hint"
                      style={{ overflow: "clip", textOverflow: "ellipsis" }}
                    >
                      {p.baseUrl}
                    </span>
                  )}
                  <span className="pt-spacer" />
                  <button
                    type="button"
                    className="pt-btn pt-btn-sm"
                    onClick={() => {
                      startEdit(p);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="pt-btn pt-btn-danger pt-btn-sm"
                    onClick={() => {
                      remove(p.id);
                    }}
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
