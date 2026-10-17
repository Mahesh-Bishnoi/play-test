import { useEffect, useState } from "react";

import { api, formatApiError } from "../api.js";
import type { SyncConflict, SyncStatusResult } from "../api.js";

interface Props {
  projectId: string;
  projectName: string;
  onChanged: () => void;
}

interface SyncLink {
  dir: string;
  remoteUrl: string;
}

interface SyncAuthor {
  name: string;
  email: string;
}

const AUTHOR_KEY = "playtest.sync.author";

function linkKey(projectId: string): string {
  return `playtest.sync.link.${projectId}`;
}

function loadLink(projectId: string): SyncLink {
  try {
    const raw = window.localStorage.getItem(linkKey(projectId));
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<SyncLink>;
      return {
        dir: typeof parsed.dir === "string" ? parsed.dir : "",
        remoteUrl: typeof parsed.remoteUrl === "string" ? parsed.remoteUrl : "",
      };
    }
  } catch {
    // Corrupt entry: fall through to blanks.
  }
  return { dir: "", remoteUrl: "" };
}

function loadAuthor(): SyncAuthor {
  try {
    const raw = window.localStorage.getItem(AUTHOR_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<SyncAuthor>;
      return {
        name: typeof parsed.name === "string" ? parsed.name : "",
        email: typeof parsed.email === "string" ? parsed.email : "",
      };
    }
  } catch {
    // Corrupt entry: fall through to blanks.
  }
  return { name: "", email: "" };
}

function shortHash(hash: string | null): string {
  return hash === null ? "—" : hash.slice(0, 8);
}

/**
 * Git sync tool window (Phase 2 slice 2 — panel over the sync-core IPC).
 * The linked repo dir + remote persist per project in localStorage; the
 * database holds no sync state, so deleting the link never touches data.
 * Pull is the only op that rewrites local cases — onChanged refreshes the
 * explorer afterwards (open case tabs keep their mounted state).
 */
export default function SyncPanel({ projectId, projectName, onChanged }: Props): React.JSX.Element {
  const [link, setLink] = useState<SyncLink>(() => loadLink(projectId));
  const [author, setAuthor] = useState<SyncAuthor>(() => loadAuthor());
  const [status, setStatus] = useState<SyncStatusResult | null>(null);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [message, setMessage] = useState("");
  const [branchName, setBranchName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setLink(loadLink(projectId));
    setStatus(null);
    setConflicts([]);
    setError(null);
    setNotice(null);
  }, [projectId]);

  const persistLink = (next: SyncLink): void => {
    setLink(next);
    try {
      window.localStorage.setItem(linkKey(projectId), JSON.stringify(next));
    } catch {
      // Storage blocked: link works for this session only.
    }
  };

  const persistAuthor = (next: SyncAuthor): void => {
    setAuthor(next);
    try {
      window.localStorage.setItem(AUTHOR_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked: author works for this session only.
    }
  };

  const dir = link.dir.trim();
  const remote = link.remoteUrl.trim() === "" ? undefined : link.remoteUrl.trim();

  const refreshStatus = (): void => {
    if (dir === "") {
      setError("Set a repo folder first (init below, or link an existing checkout).");
      return;
    }
    setBusy("status");
    setError(null);
    api
      .syncStatus(projectId, dir)
      .then((s) => {
        setStatus(s);
      })
      .catch((err: unknown) => {
        setStatus(null);
        setError(`${formatApiError(err)} — is this folder an initialized sync repo?`);
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const requireAuthor = (): boolean => {
    if (author.name.trim() === "" || author.email.trim() === "") {
      setError("Set your name and email — every sync commit is attributed.");
      return false;
    }
    return true;
  };

  const init = (): void => {
    if (dir === "" || !requireAuthor()) {
      if (dir === "") {
        setError("Set a repo folder first.");
      }
      return;
    }
    setBusy("init");
    setError(null);
    setNotice(null);
    api
      .syncInit(projectId, dir, author, remote === undefined ? {} : { remoteUrl: remote })
      .then((r) => {
        setNotice(`Initialized sync repo (${r.hash.slice(0, 8)}, ${r.changed.length} entities).`);
        refreshStatus();
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const commit = (): void => {
    if (dir === "" || !requireAuthor()) {
      return;
    }
    if (message.trim() === "") {
      setError("Write a commit message first.");
      return;
    }
    setBusy("commit");
    setError(null);
    setNotice(null);
    api
      .syncCommit(projectId, dir, author, message.trim())
      .then((r) => {
        setMessage("");
        setNotice(
          r.changed.length === 0
            ? `Nothing to commit — already clean (${r.hash.slice(0, 8)}).`
            : `Committed ${r.hash.slice(0, 8)} (${r.changed.length} changed). Push to share.`,
        );
        refreshStatus();
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const push = (): void => {
    if (dir === "") {
      return;
    }
    setBusy("push");
    setError(null);
    setNotice(null);
    api
      .syncPush(dir, remote === undefined ? {} : { remote })
      .then((r) => {
        setNotice(
          r.pushed ? `Pushed ${r.hash.slice(0, 8)}.` : "Already up to date — nothing pushed.",
        );
        refreshStatus();
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const pull = (): void => {
    if (dir === "") {
      return;
    }
    setBusy("pull");
    setError(null);
    setNotice(null);
    api
      .syncPull(projectId, dir, remote === undefined ? {} : { remote })
      .then((r) => {
        setConflicts(r.conflicts);
        if (r.applied.length > 0) {
          onChanged();
        }
        if (r.conflicts.length > 0) {
          setNotice(
            `Pulled with ${r.conflicts.length} conflict(s) — your local versions are kept until you resolve below.`,
          );
        } else if (r.applied.length > 0) {
          setNotice(`Pulled ${r.applied.length} change(s) into this project.`);
        } else {
          setNotice("Already up to date.");
        }
        refreshStatus();
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const createBranch = (): void => {
    if (dir === "" || branchName.trim() === "") {
      return;
    }
    setBusy("branch");
    setError(null);
    setNotice(null);
    api
      .syncBranch(dir, branchName.trim())
      .then((r) => {
        setBranchName("");
        setNotice(`Switched to new branch “${r.branch}”. Commit + push to publish it.`);
        refreshStatus();
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const resolve = (conflict: SyncConflict, winner: "mine" | "theirs"): void => {
    setBusy(`resolve:${conflict.id}`);
    setError(null);
    setNotice(null);
    api
      .syncResolve(projectId, dir, conflict.entity, conflict.id, winner)
      .then(() => {
        setConflicts((prev) => prev.filter((c) => c.id !== conflict.id));
        if (winner === "theirs") {
          onChanged();
          setNotice(
            `Took their ${conflict.entity} “${conflict.name}”. Commit to record the resolution.`,
          );
        } else {
          setNotice(
            `Kept your ${conflict.entity} “${conflict.name}”. Commit to record the resolution.`,
          );
        }
        refreshStatus();
      })
      .catch((err: unknown) => {
        setError(formatApiError(err));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const disabled = busy !== null;

  return (
    <div>
      <div className="pt-section-head">
        <h3 className="pt-toolbar-title">Sync — {projectName}</h3>
        <span className="pt-count">local git, stable ids</span>
        <span className="pt-spacer" />
        <button
          type="button"
          className="pt-btn pt-btn-ghost pt-btn-sm"
          disabled={disabled}
          onClick={refreshStatus}
        >
          {busy === "status" ? "Refreshing…" : "Refresh status"}
        </button>
      </div>
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

      <div className="pt-card">
        <div className="pt-section-head">
          <h3 className="pt-toolbar-title">Repository link</h3>
        </div>
        <div className="pt-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input
            aria-label="Sync repo folder"
            className="pt-input pt-mono"
            style={{ minWidth: 260, flex: 1 }}
            placeholder="Repo folder (e.g. ~/teaming/quest-1)"
            value={link.dir}
            onChange={(e) => {
              persistLink({ ...link, dir: e.target.value });
            }}
          />
          <input
            aria-label="Sync remote path"
            className="pt-input pt-mono"
            style={{ minWidth: 260, flex: 1 }}
            placeholder="Remote path (local folder, optional)"
            value={link.remoteUrl}
            onChange={(e) => {
              persistLink({ ...link, remoteUrl: e.target.value });
            }}
          />
          <button type="button" className="pt-btn pt-btn-sm" disabled={disabled} onClick={init}>
            {busy === "init" ? "Initializing…" : "Init repo here"}
          </button>
        </div>
        <p className="pt-hint pt-mt-8">
          Init refuses a non-empty folder (it wipes `suites/` and `cases/` on write) — pick an empty
          folder. Cloning a shared remote into a new folder happens on the Welcome screen — then
          open the clone and link it here, or just pull straight into it.
        </p>
      </div>

      <div className="pt-card">
        <div className="pt-section-head">
          <h3 className="pt-toolbar-title">Status</h3>
          {status !== null && (
            <span className="pt-count">
              {status.branch} · ↑{status.ahead} ↓{status.behind} ·{" "}
              {status.dirty ? "uncommitted changes" : "clean"}
            </span>
          )}
        </div>
        {status === null ? (
          <p className="pt-empty">No status yet — link a folder and press Refresh status.</p>
        ) : (
          <dl className="pt-welcome-meta">
            <dt>Branch</dt>
            <dd className="pt-mono">{status.branch}</dd>
            <dt>Local commit</dt>
            <dd className="pt-mono">{shortHash(status.local)}</dd>
            <dt>Remote commit</dt>
            <dd className="pt-mono">{shortHash(status.tracking)}</dd>
          </dl>
        )}
        <div className="pt-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input
            aria-label="Your name for sync commits"
            className="pt-input"
            style={{ maxWidth: 180 }}
            placeholder="Your name"
            value={author.name}
            onChange={(e) => {
              persistAuthor({ ...author, name: e.target.value });
            }}
          />
          <input
            aria-label="Your email for sync commits"
            className="pt-input pt-mono"
            style={{ minWidth: 220, flex: 1 }}
            placeholder="you@example.com"
            value={author.email}
            onChange={(e) => {
              persistAuthor({ ...author, email: e.target.value });
            }}
          />
        </div>
        <div className="pt-row pt-mt-8" style={{ gap: 8, flexWrap: "wrap" }}>
          <input
            aria-label="Commit message"
            className="pt-input"
            style={{ minWidth: 260, flex: 1 }}
            placeholder="Commit message (e.g. add checkout happy path)"
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && message.trim() !== "") {
                commit();
              }
            }}
          />
          <button
            type="button"
            className="pt-btn pt-btn-primary pt-btn-sm"
            disabled={disabled || message.trim() === ""}
            onClick={commit}
          >
            {busy === "commit" ? "Committing…" : "Commit"}
          </button>
          <button type="button" className="pt-btn pt-btn-sm" disabled={disabled} onClick={push}>
            {busy === "push" ? "Pushing…" : "Push"}
          </button>
          <button type="button" className="pt-btn pt-btn-sm" disabled={disabled} onClick={pull}>
            {busy === "pull" ? "Pulling…" : "Pull"}
          </button>
        </div>
        <p className="pt-hint pt-mt-8">
          Commit snapshots this project&apos;s suites, cases, steps and test data. Push shares the
          branch; pull converges on stable ids (never duplicates) and reports conflicts instead of
          guessing.
        </p>
      </div>

      <div className="pt-card">
        <div className="pt-section-head">
          <h3 className="pt-toolbar-title">Branches</h3>
        </div>
        <div className="pt-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input
            aria-label="New branch name"
            className="pt-input pt-mono"
            style={{ maxWidth: 240 }}
            placeholder="feature/boss-fight"
            value={branchName}
            onChange={(e) => {
              setBranchName(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && branchName.trim() !== "") {
                createBranch();
              }
            }}
          />
          <button
            type="button"
            className="pt-btn pt-btn-sm"
            disabled={disabled || branchName.trim() === ""}
            onClick={createBranch}
          >
            {busy === "branch" ? "Switching…" : "Create & switch"}
          </button>
        </div>
      </div>

      {conflicts.length > 0 && (
        <div className="pt-card">
          <div className="pt-section-head">
            <h3 className="pt-toolbar-title">Conflicts</h3>
            <span className="pt-count">{conflicts.length} pending</span>
          </div>
          <p className="pt-hint">
            Both sides changed the same thing — your local version is live. Pick a winner per row,
            then commit to record the resolution.
          </p>
          <ul className="pt-tree">
            {conflicts.map((c) => (
              <li key={`${c.entity}:${c.id}`} className="pt-tree-row" style={{ cursor: "default" }}>
                <span className="pt-tree-label">
                  <span className="pt-item-name">
                    {c.entity}: {c.name}
                  </span>
                  <span className="pt-item-meta pt-mono">{c.id}</span>
                </span>
                <span className="pt-row" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="pt-btn pt-btn-sm"
                    disabled={disabled}
                    onClick={() => {
                      resolve(c, "mine");
                    }}
                  >
                    {busy === `resolve:${c.id}` ? "Resolving…" : "Keep mine"}
                  </button>
                  <button
                    type="button"
                    className="pt-btn pt-btn-sm"
                    disabled={disabled}
                    onClick={() => {
                      resolve(c, "theirs");
                    }}
                  >
                    Take theirs
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
