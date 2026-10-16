import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

import { IPC_CHANNELS } from "../shared/ipc-contract.js";
import type { IpcChannel } from "../shared/ipc-contract.js";

const ALLOWED = new Set<string>(IPC_CHANNELS);

/** Main → renderer stream (PLAN §5). Invoke stays request/response-only. */
const EVENT_CHANNELS = new Set(["run:step-update", "run:log", "run:finished"]);

export type RunEventChannel = "run:step-update" | "run:log" | "run:finished";

/**
 * Minimal safe surface (PLAN §5). One generic `invoke` gated by the frozen
 * channel allowlist — per-channel wrappers belong to the WS that owns each
 * domain (WS2+), built on top of this. Main re-validates every payload with
 * `IPC_PAYLOADS`, so this allowlist is defense-in-depth, not the trust
 * boundary. `on` subscribes to main → renderer streams; only `run:*`
 * channels are exposed, and it returns an unsubscribe function.
 */
const api = {
  invoke: (channel: IpcChannel, payload: unknown): Promise<unknown> => {
    if (!ALLOWED.has(channel)) {
      return Promise.reject(new Error(`blocked IPC channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  on: (channel: RunEventChannel, listener: (payload: unknown) => void): (() => void) => {
    if (!EVENT_CHANNELS.has(channel)) {
      throw new Error(`blocked event channel: ${channel}`);
    }
    const sub = (_event: IpcRendererEvent, payload: unknown): void => {
      listener(payload);
    };
    ipcRenderer.on(channel, sub);
    return () => {
      ipcRenderer.removeListener(channel, sub);
    };
  },
};

export type PlaytestApi = typeof api;

contextBridge.exposeInMainWorld("playtest", api);
