import { useEffect, useState } from "react";

import { api, formatApiError } from "../api.js";
import type { Project } from "../../shared/schema.js";
import ConfirmDialog from "./ConfirmDialog.js";

interface Props {
  onOpen: (projectId: string) => void;
}

/**
 * IntelliJ-style Welcome screen: project list on the left, New/Open actions
 * on the right. This is the app entry point — a project must be opened
 * before the IDE shell appears.
 */
export default function WelcomeScreen({ onOpen }: Props): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .listProjects()
      .then((rows) => {
        const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));
        setProjects(sorted);
        setSelectedId(sorted[0]?.id ?? null);
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const selected = projects.find((p) => p.id === selectedId) ?? null;
  const q = search.trim().toLowerCase();
  const visible = q === "" ? projects : projects.filter((p) => p.name.toLowerCase().includes(q));

  const create = (): void => {
    const trimmed = name.trim();
    if (trimmed === "") {
      return;
    }
    setError(null);
    const url = baseUrl.trim();
    api
      .createProject(trimmed, url === "" ? undefined : url)
      .then((created) => {
        setProjects((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
        setSelectedId(created.id);
        setName("");
        setBaseUrl("");
        onOpen(created.id);
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      });
  };

  const refreshProjects = (selectId?: string): void => {
    api
      .listProjects()
      .then((rows) => {
        const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));
        setProjects(sorted);
        setSelectedId(selectId ?? sorted[0]?.id ?? null);
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      });
  };

  const importProject = (): void => {
    setError(null);
    setNotice(null);
    setImportBusy(true);
    api
      .importProject()
      .then((outcome) => {
        if (!outcome.imported || outcome.summary === undefined) {
          return;
        }
        const { projectId, caseCount, stepCount } = outcome.summary;
        setNotice(`Imported ${caseCount} cases (${stepCount} steps) as a new project.`);
        refreshProjects(projectId);
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      })
      .finally(() => {
        setImportBusy(false);
      });
  };
  const confirmDelete = (): void => {
    if (pendingDelete === null) {
      return;
    }
    const id = pendingDelete.id;
    setDeleteBusy(true);
    api
      .deleteProject(id)
      .then(() => {
        setProjects((prev) => {
          const next = prev.filter((p) => p.id !== id);
          if (selectedId === id) {
            setSelectedId(next[0]?.id ?? null);
          }
          return next;
        });
        setPendingDelete(null);
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      })
      .finally(() => {
        setDeleteBusy(false);
      });
  };

  return (
    <div className="pt-welcome-screen">
      <div
        className="pt-welcome-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to PlayTest"
      >
        <aside className="pt-welcome-side" aria-label="Projects">
          <div className="pt-welcome-brand">
            <span className="pt-brand-mark" aria-hidden="true">
              P
            </span>
            <div>
              <strong>PlayTest</strong>
              <span>Manual-tester studio</span>
            </div>
          </div>
          <input
            aria-label="Search projects"
            className="pt-input"
            placeholder="Search projects"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
            }}
          />
          <div className="pt-welcome-list">
            {loading ? (
              <p className="pt-hint">Loading projects…</p>
            ) : visible.length === 0 ? (
              <p className="pt-empty">No projects yet — create one on the right.</p>
            ) : (
              <ul className="pt-tree" role="listbox" aria-label="Recent projects">
                {visible.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selectedId === p.id}
                      className={`pt-tree-row${selectedId === p.id ? " pt-tree-row-active" : ""}`}
                      onClick={() => {
                        setSelectedId(p.id);
                      }}
                      onDoubleClick={() => {
                        onOpen(p.id);
                      }}
                      title={p.baseUrl ?? p.name}
                    >
                      <span className="pt-tree-icon" aria-hidden="true">
                        ▦
                      </span>
                      <span className="pt-tree-label">
                        <span className="pt-item-name">{p.name}</span>
                        {p.baseUrl !== undefined && p.baseUrl !== "" && (
                          <span className="pt-item-meta">{p.baseUrl}</span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
        <main className="pt-welcome-main">
          <h2>Welcome to PlayTest</h2>
          <p className="pt-sub">Create a project, or open one to get to the test editor.</p>
          {error !== null && (
            <p role="alert" className="pt-alert pt-alert-error">
              {error}
            </p>
          )}
          {notice !== null && (
            <p role="status" className="pt-alert pt-alert-ok">
              {notice}
            </p>
          )}
          <div className="pt-welcome-actions">
            <button
              type="button"
              className="pt-btn pt-btn-primary"
              disabled={selected === null}
              onClick={() => {
                if (selected !== null) {
                  onOpen(selected.id);
                }
              }}
            >
              Open selected project
            </button>
            {selected !== null && (
              <button
                type="button"
                className="pt-btn pt-btn-danger-ghost"
                onClick={() => {
                  setPendingDelete(selected);
                }}
              >
                Delete
              </button>
            )}
            <button
              type="button"
              className="pt-btn"
              disabled={importBusy}
              onClick={importProject}
              title="Import a project from a .playtest.json file (creates a new project with fresh ids)"
            >
              {importBusy ? "Importing…" : "Import project…"}
            </button>
          </div>
          {selected !== null && (
            <dl className="pt-welcome-meta">
              <dt>Project</dt>
              <dd>{selected.name}</dd>
              <dt>Base URL</dt>
              <dd className="pt-mono">{selected.baseUrl ?? "—"}</dd>
            </dl>
          )}
          <div className="pt-welcome-new">
            <h3>New project</h3>
            <input
              aria-label="New project name"
              className="pt-input"
              placeholder="Project name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim() !== "") {
                  create();
                }
              }}
            />
            <input
              aria-label="New project base URL"
              className="pt-input pt-mono"
              placeholder="Base URL (optional, e.g. https://…)"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim() !== "") {
                  create();
                }
              }}
            />
            <button type="button" className="pt-btn" disabled={name.trim() === ""} onClick={create}>
              Create and open
            </button>
          </div>
        </main>
      </div>
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
    </div>
  );
}
