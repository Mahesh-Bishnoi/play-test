import { IPC_PAYLOADS } from "../../shared/ipc-contract.js";

/**
 * Electron-agnostic handler registration (WS1/WS2, PLAN §5). Takes a `handle`
 * function instead of importing `ipcMain` so tests inject a fake and
 * `main.ts` (composition root) passes the real one. Every request channel is
 * validated with `IPC_PAYLOADS` before reaching a service.
 *
 * Return-envelope notes (payload schemas unchanged — frozen v1):
 * - `suite:get` → `{ suite, caseIds }` (membership has no dedicated channel).
 * - `case:get` → `{ case, steps }` (there is no `step:list` channel).
 */
export type IpcHandleFn = (channel: string, listener: (payload: unknown) => unknown) => void;

export function payloadSchema(channel: string) {
  const schema = IPC_PAYLOADS[channel];
  if (schema === undefined) {
    throw new Error(`no payload schema for channel: ${channel}`);
  }
  return schema;
}
