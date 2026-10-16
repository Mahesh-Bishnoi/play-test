import { useCallback, useEffect, useState } from "react";

import { api } from "../api.js";

type State = "checking" | "ready" | "missing" | "installing" | "error";

/**
 * First-run Chromium banner (M7, PLAN §11). Checks `system:browserStatus` on
 * mount; when the browser is absent it offers a one-click
 * `system:installBrowser` with indeterminate progress. Renders nothing once
 * the browser is present — runs need it, CRUD does not, so this warns rather
 * than blocks.
 */
export default function BrowserBanner(): React.JSX.Element | null {
  const [state, setState] = useState<State>("checking");
  const [message, setMessage] = useState<string | null>(null);

  const check = useCallback(() => {
    setState("checking");
    setMessage(null);
    api.browserStatus().then(
      (status) => {
        setState(status.installed ? "ready" : "missing");
      },
      (err: unknown) => {
        setState("error");
        setMessage(err instanceof Error ? err.message : String(err));
      },
    );
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  const install = (): void => {
    setState("installing");
    setMessage(null);
    api.installBrowser().then(
      () => {
        setState("ready");
      },
      (err: unknown) => {
        setState("error");
        setMessage(err instanceof Error ? err.message : String(err));
      },
    );
  };

  if (state === "ready") {
    return null;
  }

  return (
    <div
      role="status"
      style={{
        marginTop: 16,
        padding: "10px 12px",
        border: "1px solid #d97706",
        borderRadius: 6,
        background: "#fffbeb",
        display: "flex",
        gap: 12,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <span>
        {state === "checking" && "Checking for Chromium…"}
        {state === "missing" &&
          "Chromium is not installed — runs need it (projects and cases still work)."}
        {state === "installing" && "Installing Chromium… this may take a few minutes."}
        {state === "error" && `Browser setup failed${message === null ? "." : `: ${message}`}`}
      </span>
      {(state === "missing" || state === "error") && (
        <>
          <button
            type="button"
            onClick={install}
            style={{
              padding: "6px 12px",
              border: "1px solid #888",
              borderRadius: 4,
              background: "#fff",
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Install Chromium
          </button>
          {state === "error" && (
            <button
              type="button"
              onClick={check}
              style={{
                padding: "6px 12px",
                border: "1px solid #888",
                borderRadius: 4,
                background: "#fff",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              Retry check
            </button>
          )}
        </>
      )}
    </div>
  );
}
