import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import started from "electron-squirrel-startup";

import { createDatabase, defaultDbPath } from "./db.js";
import { ExportValidationError, MAX_EXPORT_BYTES } from "../shared/export-format.js";
import { registerCrudHandlers } from "./ipc/crud.js";
import { registerRecorderHandlers } from "./ipc/recorder.js";
import { registerReportHandlers } from "./ipc/report.js";
import { registerRunnerHandlers } from "./ipc/runner.js";
import { registerSystemHandlers } from "./ipc/system.js";
import { registerTransferHandlers } from "./ipc/transfer.js";
import { registerSyncHandlers } from "./ipc/sync.js";
import { SingleCaseRunner } from "./runner/single-runner.js";
import { playwrightLauncher } from "./runner/launcher.js";
import { SuiteRunner } from "./suite-runner/suite-runner.js";
import { defaultArtifactsRoot } from "./artifacts.js";
import { isAllowedAppUrl } from "./window-guards.js";
import { reconcileInterruptedRuns } from "./run-reconcile.js";
import { sharedRecorder } from "./recorder/codegen-shell.js";

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
  const appFile = join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
  const allowed = {
    devServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL,
    appFileUrl: pathToFileURL(appFile).href,
  };
  // The preload bridge (`window.playtest`) is attached to whatever this window
  // loads, so navigation away from the app and popup windows are both denied.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const blockOutside = (event: { preventDefault(): void }, url: string): void => {
    if (!isAllowedAppUrl(url, allowed)) {
      event.preventDefault();
    }
  };
  win.webContents.on("will-navigate", blockOutside);
  win.webContents.on("will-redirect", blockOutside);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL !== undefined && MAIN_WINDOW_VITE_DEV_SERVER_URL !== "") {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(appFile);
  }
}

void app.whenReady().then(() => {
  const handle = createDatabase(defaultDbPath());
  // A quit/crash mid-run leaves rows "running" forever; settle them before the
  // UI can read the history (review counted #2).
  reconcileInterruptedRuns(handle.db);
  closeDb = () => {
    handle.close();
  };
  const artifactsRoot = defaultArtifactsRoot();
  registerRecorderHandlers(
    (channel, listener) => {
      ipcMain.handle(channel, (_event, payload: unknown) => listener(payload));
    },
    handle.db,
    { artifactsRoot },
  );
  registerSystemHandlers((channel, listener) => {
    ipcMain.handle(channel, (_event, payload: unknown) => listener(payload));
  });
  let suiteRunner: SuiteRunner;
  const runner = new SingleCaseRunner(handle.db, {
    launchBrowser: playwrightLauncher(),
    emit: (channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(channel, payload);
      }
    },
    artifactsRoot,
    isSuiteActive: () => suiteRunner.hasActiveRun(),
  });
  suiteRunner = new SuiteRunner(handle.db, {
    launchBrowser: playwrightLauncher(),
    emit: (channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(channel, payload);
      }
    },
    artifactsRoot,
    isSingleActive: () => runner.hasActiveSession(),
  });
  // Destructive CRUD is registered after both runners exist so a live run can
  // refuse deletes (review F6).
  registerCrudHandlers(
    (channel, listener) => {
      ipcMain.handle(channel, (_event, payload: unknown) => listener(payload));
    },
    handle.db,
    {
      isRunActive: () => runner.hasActiveSession() || suiteRunner.hasActiveRun(),
      artifactsRoot,
    },
  );
  registerRunnerHandlers(
    (channel, listener) => {
      ipcMain.handle(channel, (_event, payload: unknown) => listener(payload));
    },
    runner,
    suiteRunner,
  );
  registerReportHandlers(
    (channel, listener) => {
      ipcMain.handle(channel, (_event, payload: unknown) => listener(payload));
    },
    handle.db,
    { artifactsRoot, renderPdf: renderPdfWithElectron },
  );
  registerTransferHandlers(
    (channel, listener) => {
      ipcMain.handle(channel, (_event, payload: unknown) => listener(payload));
    },
    handle.db,
    {
      async showSaveDialog(defaultFileName: string): Promise<string | null> {
        const result = await dialog.showSaveDialog({
          defaultPath: defaultFileName,
          filters: [{ name: "PlayTest export", extensions: ["json"] }],
        });
        return result.canceled || result.filePath === undefined ? null : result.filePath;
      },
      async showOpenDialog(): Promise<string | null> {
        const result = await dialog.showOpenDialog({
          properties: ["openFile"],
          filters: [{ name: "PlayTest export", extensions: ["json"] }],
        });
        return result.canceled || result.filePaths.length === 0
          ? null
          : (result.filePaths[0] as string);
      },
      async readTextFile(path: string): Promise<string> {
        const { readFile, stat } = await import("node:fs/promises");
        // Pre-read size guard: parseExportText caps at the same limit, but
        // only after the whole file is already in memory.
        if ((await stat(path)).size > MAX_EXPORT_BYTES) {
          throw new ExportValidationError(`export file too large (max ${MAX_EXPORT_BYTES} bytes)`);
        }
        return readFile(path, "utf8");
      },
      async writeTextFile(path: string, text: string): Promise<void> {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, text, "utf8");
      },
    },
  );
  registerSyncHandlers((channel, listener) => {
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

// A codegen child outlives the window unless killed explicitly; app shutdown
// must not leave an orphaned browser window (review counted #2).
app.on("before-quit", () => {
  sharedRecorder.dispose();
});

/**
 * Render an HTML report file to PDF bytes via a hidden window (WS6,
 * PLAN §9). A4, prefers the report's CSS page size; the window is destroyed
 * before resolving so batch exports cannot leak windows.
 */
async function renderPdfWithElectron(htmlPath: string): Promise<Uint8Array> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true },
  });
  try {
    await win.loadFile(htmlPath);
    return await win.webContents.printToPDF({ preferCSSPageSize: true });
  } finally {
    win.destroy();
  }
}
