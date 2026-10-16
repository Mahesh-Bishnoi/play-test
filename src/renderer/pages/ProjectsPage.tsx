import { useEffect, useState } from "react";

import { api } from "../api.js";
import type { Project } from "../../shared/schema.js";
import ConfirmDialog from "../components/ConfirmDialog.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Props {
  selectedId: string | null;
  onSelect: (projectId: string | null) => void;
}

/**
 * Projects sidebar (UI overhaul): the project name is the select target
 * (full-row button), Rename is a neutral ghost, Delete is a danger-ghost
 * behind a confirm. The create form hides behind a disclosure until needed.
 */
export default function ProjectsPage({ selectedId, onSelect }: Props): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

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
        setShowCreate(false);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
  };

  const confirmDelete = (): void => {
    if (pendingDelete === null) {
      return;
    }
    const id = pendingDelete.id;
    setDeleteBusy(true);
    setError(null);
    api
      .deleteProject(id)
      .then(() => {
        refresh(projects.filter((p) => p.id !== id));
        if (selectedId === id) {
          onSelect(null);
        }
        setPendingDelete(null);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setDeleteBusy(false);
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
      <div className="pt-disclosure">
        <button
          type="button"
          className="pt-btn pt-btn-sm"
          aria-expanded={showCreate}
          onClick={() => {
            setShowCreate((v) => !v);
          }}
        >
          {showCreate ? "− Close" : "+ New project"}
        </button>
      </div>
      {showCreate && (
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
            Create project
          </button>
        </div>
      )}
      {projects.length === 0 && !showCreate ? (
        <p className="pt-empty">No projects yet — press “+ New project”.</p>
      ) : (
        <ul className="pt-list">
          {projects.map((p) => (
            <li
              key={p.id}
              className={`pt-list-item${selectedId === p.id ? " pt-list-item-active" : ""}`}
            >
              {editingId === p.id ? (
                <div className="pt-form-grid" style={{ inlineSize: "100%", padding: 8 }}>
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
                    className="pt-item-select"
                    onClick={() => {
                      onSelect(p.id);
                    }}
                    aria-pressed={selectedId === p.id}
                    title={p.baseUrl ?? p.name}
                  >
                    <span className="pt-item-name">{p.name}</span>
                    {p.baseUrl !== undefined && p.baseUrl !== "" && (
                      <span className="pt-item-meta">{p.baseUrl}</span>
                    )}
                  </button>
                  <span className="pt-item-actions">
                    <button
                      type="button"
                      className="pt-btn pt-btn-ghost pt-btn-sm"
                      title={`Rename ${p.name}`}
                      aria-label={`Rename project ${p.name}`}
                      onClick={() => {
                        startEdit(p);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="pt-btn pt-btn-danger-ghost pt-btn-sm"
                      title={`Delete ${p.name} (asks first)`}
                      aria-label={`Delete project ${p.name}`}
                      onClick={() => {
                        setPendingDelete(p);
                      }}
                    >
                      Delete
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {pendingDelete !== null && (
        <ConfirmDialog
          title={`Delete “${pendingDelete.name}”?`}
          body="This permanently deletes the project and every suite, case, step and run inside it. This cannot be undone."
          confirmLabel={`Delete ${pendingDelete.name}`}
          busy={deleteBusy}
          onConfirm={confirmDelete}
          onCancel={() => {
            if (!deleteBusy) {
              setPendingDelete(null);
            }
          }}
        />
      )}
    </section>
  );
}
