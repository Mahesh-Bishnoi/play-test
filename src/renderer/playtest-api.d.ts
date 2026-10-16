import type { IpcChannel } from "../shared/ipc-contract.js";

declare global {
  interface Window {
    playtest: {
      invoke: (channel: IpcChannel, payload: unknown) => Promise<unknown>;
    };
  }
}

export {};
