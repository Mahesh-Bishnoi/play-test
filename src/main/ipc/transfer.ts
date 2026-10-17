import type { AppDatabase } from "../db.js";
import {
  TransferExportCasePayload,
  TransferExportProjectPayload,
  TransferExportSuitePayload,
  TransferImportCasePayload,
  TransferImportProjectPayload,
  TransferImportSuitePayload,
} from "../../shared/ipc-contract.js";
import {
  buildCaseExport,
  buildProjectExport,
  buildSuiteExport,
  importCaseBundle,
  importProjectBundle,
  importSuiteBundle,
} from "../transfer/bundles.js";
import { loadImportFile, saveExportFile } from "../transfer/io.js";
import type { TransferIoDeps } from "../transfer/types.js";
import type { IpcHandleFn } from "./handle.js";

/**
 * Transfer channels (file import/export, Phase 1). Export builds the bundle in
 * the handler and saves it through the injected dialogs; import reads + parses
 * (size cap + schema at the trust boundary) and imports with copy semantics.
 * Cancelled dialogs resolve `{ saved: false }` / `{ imported: false }` — never
 * an error — so the UI can silently no-op.
 */
export function registerTransferHandlers(
  handle: IpcHandleFn,
  db: AppDatabase,
  io: TransferIoDeps,
): void {
  handle("transfer:exportProject", (rawPayload: unknown) => {
    const payload = TransferExportProjectPayload.parse(rawPayload);
    return (async () => {
      const file = buildProjectExport(db, payload.id);
      return saveExportFile(io, file.project?.name ?? "project", "project", file);
    })();
  });
  handle("transfer:exportSuite", (rawPayload: unknown) => {
    const payload = TransferExportSuitePayload.parse(rawPayload);
    return (async () => {
      const file = buildSuiteExport(db, payload.id);
      return saveExportFile(io, file.suites[0]?.name ?? "suite", "suite", file);
    })();
  });
  handle("transfer:exportCase", (rawPayload: unknown) => {
    const payload = TransferExportCasePayload.parse(rawPayload);
    return (async () => {
      const file = buildCaseExport(db, payload.id);
      return saveExportFile(io, file.cases[0]?.name ?? "case", "case", file);
    })();
  });
  handle("transfer:importProject", (rawPayload: unknown) => {
    TransferImportProjectPayload.parse(rawPayload);
    return loadImportFile(io, (file) => importProjectBundle(db, file));
  });
  handle("transfer:importSuite", (rawPayload: unknown) => {
    const payload = TransferImportSuitePayload.parse(rawPayload);
    return loadImportFile(io, (file) => importSuiteBundle(db, file, payload.projectId));
  });
  handle("transfer:importCase", (rawPayload: unknown) => {
    const payload = TransferImportCasePayload.parse(rawPayload);
    return loadImportFile(io, (file) =>
      importCaseBundle(db, file, payload.projectId, payload.suiteIds ?? []),
    );
  });
}
