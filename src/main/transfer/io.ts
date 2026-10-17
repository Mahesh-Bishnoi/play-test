import {
  exportFileName,
  parseExportText,
  type ExportFile,
  type ExportScope,
} from "../../shared/export-format.js";
import type { ExportResult, ImportResult, ImportSummary, TransferIoDeps } from "./types.js";

/** Save-dialog flow for one built export file. */
export async function saveExportFile(
  io: TransferIoDeps,
  baseName: string,
  scope: ExportScope,
  file: ExportFile,
): Promise<ExportResult> {
  const chosen = await io.showSaveDialog(exportFileName(baseName, scope));
  if (chosen === null) {
    return { saved: false };
  }
  await io.writeTextFile(chosen, JSON.stringify(file, null, 2));
  return { saved: true, path: chosen };
}

/** Open-dialog flow: read a file, parse + validate, run the importer. */
export async function loadImportFile(
  io: TransferIoDeps,
  run: (file: ExportFile) => ImportSummary,
): Promise<ImportResult> {
  const chosen = await io.showOpenDialog();
  if (chosen === null) {
    return { imported: false };
  }
  const text = await io.readTextFile(chosen);
  const summary = run(parseExportText(text));
  return { imported: true, summary };
}
