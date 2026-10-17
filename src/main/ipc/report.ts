import { existsSync } from "node:fs";

import type { AppDatabase } from "../db.js";
import {
  ReportExportPdfPayload,
  ReportGetHtmlPayload,
  ReportOpenTracePayload,
} from "../../shared/ipc-contract.js";
import { ensureSuiteHtmlPath, readSuiteHtmlReport, writeSuitePdfReport } from "../reports/files.js";
import { defaultSpawnShowTrace, openTrace, openTraceForCase } from "../trace-viewer.js";
import type { IpcHandleFn } from "./handle.js";

/**
 * Report channels (WS6, PLAN §5 + §9; M8 adds `report:openTrace`). `renderPdf`
 * is Electron's printToPDF in prod and a fake in tests — this module stays
 * Electron-free. Trace launching defaults to the real `playwright show-trace`
 * spawn; tests inject `spawnShowTrace`/`pathExists` fakes so no GUI launches.
 */
export function registerReportHandlers(
  handle: IpcHandleFn,
  db: AppDatabase,
  opts: {
    artifactsRoot: string;
    renderPdf: (htmlPath: string) => Promise<Uint8Array>;
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
    return readSuiteHtmlReport(db, opts.artifactsRoot, payload.suiteRunId);
  });
  handle("report:exportPdf", (rawPayload: unknown) => {
    const payload = ReportExportPdfPayload.parse(rawPayload);
    return (async (): Promise<string> => {
      const htmlPath = ensureSuiteHtmlPath(db, opts.artifactsRoot, payload.suiteRunId);
      const pdfBytes = await opts.renderPdf(htmlPath);
      return writeSuitePdfReport(db, opts.artifactsRoot, payload.suiteRunId, pdfBytes);
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
