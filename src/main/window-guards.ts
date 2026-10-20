/**
 * Window navigation allowlist (review F9). The main window runs a preload that
 * exposes the app IPC bridge on every page it loads, so a dropped link/file or
 * a stray `<a href>` must never navigate it away from the app. Pure and
 * unit-tested; `main.ts` wires it to `will-navigate` / `will-redirect`.
 */

export interface AllowedWindowUrlOptions {
  /** Vite dev-server URL; when present the app lives on its origin. */
  devServerUrl?: string | undefined;
  /** Packaged renderer entry, as a `file://` URL. */
  appFileUrl: string;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** True when `target` is the app itself (dev origin or the packaged entry). */
export function isAllowedAppUrl(target: string, opts: AllowedWindowUrlOptions): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (opts.devServerUrl !== undefined && opts.devServerUrl !== "") {
    try {
      return isHttpUrl(target) && url.origin === new URL(opts.devServerUrl).origin;
    } catch {
      return false;
    }
  }
  if (url.protocol !== "file:") {
    return false;
  }
  let appUrl: URL;
  try {
    appUrl = new URL(opts.appFileUrl);
  } catch {
    return false;
  }
  // Same file, optionally with a hash/query (React never navigates, but a
  // reload of `index.html#x` must stay allowed).
  return url.host === appUrl.host && url.pathname === appUrl.pathname;
}
