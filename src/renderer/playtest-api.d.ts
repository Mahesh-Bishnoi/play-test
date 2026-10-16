import type { IpcChannel } from "../shared/ipc-contract.js";
import type { RunEventChannel } from "../preload/preload.js";

declare global {
  interface Window {
    playtest: {
      invoke: (channel: IpcChannel, payload: unknown) => Promise<unknown>;
      on: (channel: RunEventChannel, listener: (payload: unknown) => void) => () => void;
    };
  }
}

export {};
