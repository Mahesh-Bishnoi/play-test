import { contextBridge, ipcRenderer } from "electron";

import { IPC_CHANNELS } from "../shared/ipc-contract.js";
import type { IpcChannel } from "../shared/ipc-contract.js";

const ALLOWED = new Set<string>(IPC_CHANNELS);

/**
 * Minimal safe surface (PLAN §5). One generic `invoke` gated by the frozen
 * channel allowlist — per-channel wrappers belong to the WS that owns each
 * domain (WS2+), built on top of this. Main re-validates every payload with
 * `IPC_PAYLOADS`, so this allowlist is defense-in-depth, not the trust
 * boundary.
 */
const api = {
  invoke: (channel: IpcChannel, payload: unknown): Promise<unknown> => {
    if (!ALLOWED.has(channel)) {
      return Promise.reject(new Error(`blocked IPC channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
};

export type PlaytestApi = typeof api;

contextBridge.exposeInMainWorld("playtest", api);
