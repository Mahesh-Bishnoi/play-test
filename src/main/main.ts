import { join } from "node:path";

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import started from "electron-squirrel-startup";

import { createDatabase, defaultDbPath } from "./db.js";
import {
  registerCrudHandlers,
  registerRecorderHandlers,
  registerReportHandlers,
  registerRunnerHandlers,
  registerSystemHandlers,
  registerTransferHandlers,
} from "./ipc-register.js";
import { SingleCaseRunner, playwrightLauncher } from "./runner.js";
import { SuiteRunner } from "./suite-runner.js";
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
  registerSystemHandlers((channel, listener) => {
    ipcMain.handle(channel, (_event, payload: unknown) => listener(payload));
  });
  const artifactsRoot = defaultArtifactsRoot();
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
        const { readFile } = await import("node:fs/promises");
        return readFile(path, "utf8");
      },
      async writeTextFile(path: string, text: string): Promise<void> {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, text, "utf8");
      },
    },
  );
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
