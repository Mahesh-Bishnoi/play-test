import { useEffect, useState } from "react";

import { ProjectSchema } from "../shared/schema.js";
import type { Project } from "../shared/schema.js";

function parseProjects(raw: unknown): Project[] {
  if (!Array.isArray(raw)) {
    throw new Error("expected project list from main");
  }
  return raw.map((item) => ProjectSchema.parse(item));
}

/**
 * M1 shell smoke: proves preload → IPC → DB round-trips before WS2 builds
 * the real ProjectsPage. WS2 replaces this file with full CRUD UI.
 */
export default function App(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  useEffect(() => {
    window.playtest
      .invoke("project:list", {})
      .then((raw) => {
        setProjects(parseProjects(raw));
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  const create = (): void => {
    setError(null);
    window.playtest
      .invoke("project:create", { name })
      .then((raw) => {
        const created = ProjectSchema.parse(raw);
        setProjects((prev) => [...prev, created]);
        setName("");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 640 }}>
      <h1>PlayTest</h1>
      <p>M1 shell — project IPC smoke (WS2 builds the real ProjectsPage).</p>
      {error !== null && (
        <p role="alert" style={{ color: "red" }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          aria-label="Project name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          placeholder="New project name"
        />
        <button type="button" onClick={create} disabled={name.trim() === ""}>
          Create
        </button>
      </div>
      <ul>
        {projects.map((p) => (
          <li key={p.id}>
            {p.name}
            {p.baseUrl !== undefined && p.baseUrl !== "" ? ` — ${p.baseUrl}` : ""}
          </li>
        ))}
      </ul>
      {projects.length === 0 && <p>No projects yet.</p>}
    </main>
  );
}
