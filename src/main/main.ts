import { join } from "node:path";

import { app, BrowserWindow, ipcMain } from "electron";
import started from "electron-squirrel-startup";

import { createDatabase, defaultDbPath } from "./db.js";
import { registerProjectHandlers } from "./ipc-register.js";

// Forge's vite plugin injects these globals at build/dev time.
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

// Windows installer events — quit immediately when handled.
if (started) {
  app.quit();
}

let closeDb: (() => void) | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL !== undefined && MAIN_WINDOW_VITE_DEV_SERVER_URL !== "") {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

void app.whenReady().then(() => {
  const handle = createDatabase(defaultDbPath());
  closeDb = () => {
    handle.close();
  };
  registerProjectHandlers((channel, listener) => {
    ipcMain.handle(channel, (_event, payload: unknown) => listener(payload));
  }, handle.db);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("quit", () => {
  closeDb?.();
  closeDb = null;
});
