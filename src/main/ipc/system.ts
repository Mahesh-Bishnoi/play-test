import {
  SystemBrowserStatusPayload,
  SystemInstallBrowserPayload,
} from "../../shared/ipc-contract.js";
import { defaultBrowserSetupDeps, getBrowserStatus, installChromium } from "../browser-setup.js";
import type { BrowserSetupDeps } from "../browser-setup.js";
import type { IpcHandleFn } from "./handle.js";

/**
 * System channels (M7, PLAN §11). First-run Chromium check + install; the
 * module stays Electron-free by taking `BrowserSetupDeps` (default prod, fake
 * in tests — same pattern as the recorder handlers above).
 */
export function registerSystemHandlers(
  handle: IpcHandleFn,
  deps: BrowserSetupDeps = defaultBrowserSetupDeps(),
): void {
  handle("system:browserStatus", (rawPayload: unknown) => {
    SystemBrowserStatusPayload.parse(rawPayload);
    return getBrowserStatus(deps);
  });
  handle("system:installBrowser", (rawPayload: unknown) => {
    SystemInstallBrowserPayload.parse(rawPayload);
    return installChromium(deps);
  });
}
