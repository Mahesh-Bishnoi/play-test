/** Thrown when a file's scope doesn't match the import channel used. */
export class ExportScopeMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`expected a ${expected} export, got ${actual}`);
    this.name = "ExportScopeMismatchError";
  }
}

/**
 * File + dialog surface for import/export. The composition root (main.ts)
 * injects the real Electron dialogs + fs; tests inject fakes — transfer.ts
 * itself never imports Electron.
 */
export interface TransferIoDeps {
  showSaveDialog(defaultFileName: string): Promise<string | null>;
  showOpenDialog(): Promise<string | null>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, text: string): Promise<void>;
}

export interface ExportResult {
  saved: boolean;
  path?: string;
}

export interface ImportResult {
  imported: boolean;
  summary?: ImportSummary;
}

export interface ImportSummary {
  projectId: string;
  suiteIds: string[];
  caseIds: string[];
  caseCount: number;
  stepCount: number;
}
