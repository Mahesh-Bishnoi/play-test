import { join } from "node:path";

import { app, BrowserWindow, ipcMain } from "electron";
import started from "electron-squirrel-startup";

import { createDatabase, defaultDbPath } from "./db.js";
import {
  registerCrudHandlers,
  registerRecorderHandlers,
  registerRunnerHandlers,
} from "./ipc-register.js";
import { SingleCaseRunner, playwrightLauncher } from "./runner.js";
import { defaultArtifactsRoot } from "./artifacts.js";

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
  registerCrudHandlers((channel, listener) => {
    ipcMain.handle(channel, (_event, payload: unknown) => listener(payload));
  }, handle.db);
  registerRecorderHandlers((channel, listener) => {
    ipcMain.handle(channel, (_event, payload: unknown) => listener(payload));
  });
  const runner = new SingleCaseRunner(handle.db, {
    launchBrowser: playwrightLauncher(),
    emit: (channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(channel, payload);
      }
    },
    artifactsRoot: defaultArtifactsRoot(),
  });
  registerRunnerHandlers((channel, listener) => {
    ipcMain.handle(channel, (_event, payload: unknown) => listener(payload));
  }, runner);
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
