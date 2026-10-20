import { useCallback, useEffect, useState } from "react";

import { api, formatApiError } from "../api.js";

type State = "checking" | "ready" | "missing" | "installing" | "error";

/**
 * First-run Chromium banner (M7, PLAN §11). Warns rather than blocks.
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
        setMessage(formatApiError(err));
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
        setMessage(formatApiError(err));
      },
    );
  };

  if (state === "ready") {
    return null;
  }

  return (
    <div role="status" className="pt-banner pt-mb-16">
      <span>
        {state === "checking" && "Checking for Chromium…"}
        {state === "missing" &&
          "Chromium is not installed — runs need it (projects and cases still work)."}
        {state === "installing" && "Installing Chromium… this may take a few minutes."}
        {state === "error" && `Browser setup failed${message === null ? "." : `: ${message}`}`}
      </span>
      {(state === "missing" || state === "error") && (
        <>
          <button type="button" className="pt-btn pt-btn-sm" onClick={install}>
            Install Chromium
          </button>
          {state === "error" && (
            <button type="button" className="pt-btn pt-btn-sm" onClick={check}>
              Retry check
            </button>
          )}
        </>
      )}
    </div>
  );
}
