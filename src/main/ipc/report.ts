import { existsSync } from "node:fs";

import type { AppDatabase } from "../db.js";
import {
  ReportExportPdfPayload,
  ReportGetHtmlPayload,
  ReportOpenTracePayload,
} from "../../shared/ipc-contract.js";
import {
  ensureSuiteHtmlPath,
  readSuiteHtmlReport,
  suggestedPdfFileName,
  writeSuitePdfReport,
} from "../reports/files.js";
import { isRunActive } from "../run-progress.js";
import { defaultSpawnShowTrace, openTrace, openTraceForCase } from "../trace-viewer.js";
import type { IpcHandleFn } from "./handle.js";

/**
 * Report channels (WS6, PLAN §5 + §9; M8 adds `report:openTrace`). `renderPdf`
 * is Electron's printToPDF in prod and a fake in tests; `showSaveDialog` is the
 * Electron save dialog, injected the same way so this module stays
 * Electron-free. Trace launching defaults to the real `playwright show-trace`
 * spawn; tests inject `spawnShowTrace`/`pathExists` fakes so no GUI launches.
 */
export function registerReportHandlers(
  handle: IpcHandleFn,
  db: AppDatabase,
  opts: {
    artifactsRoot: string;
    renderPdf: (htmlPath: string) => Promise<Uint8Array>;
    showSaveDialog: (defaultFileName: string) => Promise<string | null>;
    spawnShowTrace?: (tracePath: string) => void;
    pathExists?: (path: string) => boolean;
  },
): void {
  const traceDeps = {
    artifactsRoot: opts.artifactsRoot,
    pathExists: opts.pathExists ?? existsSync,
    spawnShowTrace: opts.spawnShowTrace ?? defaultSpawnShowTrace,
  };
  handle("report:getHtml", (rawPayload: unknown) => {
    const payload = ReportGetHtmlPayload.parse(rawPayload);
    // A live run's report must be re-rendered on every read; a finished run
    // keeps the cached file fast path.
    return readSuiteHtmlReport(db, opts.artifactsRoot, payload.suiteRunId, {
      force: isRunActive(db, payload.suiteRunId),
    });
  });
  handle("report:exportPdf", (rawPayload: unknown) => {
    const payload = ReportExportPdfPayload.parse(rawPayload);
    return (async (): Promise<{ saved: boolean; path?: string }> => {
      // Validate + build the suggestion before showing a dialog: an unknown
      // run must fail without opening an orphan save dialog.
      const defaultFileName = suggestedPdfFileName(db, payload.suiteRunId);
      const destination = await opts.showSaveDialog(defaultFileName);
      if (destination === null) {
        return { saved: false };
      }
      const htmlPath = ensureSuiteHtmlPath(db, opts.artifactsRoot, payload.suiteRunId);
      const pdfBytes = await opts.renderPdf(htmlPath);
      return {
        saved: true,
        path: writeSuitePdfReport(db, payload.suiteRunId, destination, pdfBytes),
      };
    })();
  });
  handle("report:openTrace", (rawPayload: unknown) => {
    const payload = ReportOpenTracePayload.parse(rawPayload);
    if ("caseRunId" in payload) {
      return openTraceForCase(db, traceDeps, payload.caseRunId);
    }
    return openTrace(traceDeps, payload.tracePath);
  });
}
