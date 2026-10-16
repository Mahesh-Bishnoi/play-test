import type { AppDatabase } from "./db.js";
import { IPC_PAYLOADS } from "../shared/ipc-contract.js";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from "./ipc-projects.js";

/**
 * Electron-agnostic handler registration (WS1, PLAN §5). Takes a `handle`
 * function instead of importing `ipcMain` so tests inject a fake and
 * `index.ts` (composition root) passes the real one. Only `project:*`
 * channels are wired — WS4/WS5/WS6 register their own channels against
 * `IPC_PAYLOADS` when they land.
 */
export type IpcHandleFn = (channel: string, listener: (payload: unknown) => unknown) => void;

const PROJECT_CHANNELS = [
  "project:create",
  "project:list",
  "project:get",
  "project:update",
  "project:delete",
] as const;

export function registerProjectHandlers(handle: IpcHandleFn, db: AppDatabase): void {
  for (const channel of PROJECT_CHANNELS) {
    handle(channel, (rawPayload: unknown) => {
      const schema = IPC_PAYLOADS[channel];
      if (schema === undefined) {
        throw new Error(`no payload schema for channel: ${channel}`);
      }
      const payload = schema.parse(rawPayload) as Record<string, unknown>;
      switch (channel) {
        case "project:create":
          return createProject(db, payload as Parameters<typeof createProject>[1]);
        case "project:list":
          return listProjects(db);
        case "project:get":
          return getProject(db, payload["id"] as string);
        case "project:update":
          return updateProject(db, payload as Parameters<typeof updateProject>[1]);
        case "project:delete":
          deleteProject(db, payload["id"] as string);
          return null;
      }
    });
  }
}
