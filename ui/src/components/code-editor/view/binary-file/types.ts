import type { IWorkbookData } from "@univerjs/core";
import type { ReactNode } from "react";
import type { CodeEditorFile } from "../../types/types";
import type { SpreadsheetSheetTab } from "../subcomponents/SpreadsheetTabs";

export type CodeEditorBinaryFileProps = {
  file: CodeEditorFile;
  projectName?: string;
  isSidebar: boolean;
  compactHeader?: boolean;
  isFullscreen: boolean;
  isExpanded?: boolean;
  onClose: () => void;
  onToggleFullscreen: () => void;
  onToggleExpand?: (() => void) | null;
  title: string;
  message: string;
  headerPrefix?: ReactNode;
};

export type BlobSource = "raw" | "office-pdf";

export type ReloadOptions = { force?: boolean };

export type SpreadsheetPreviewManifest = {
  version: number;
  revision: string;
  activeSheetIndex: number;
  sheets: SpreadsheetSheetTab[];
};

export type SpreadsheetPreviewWarning = {
  code: string;
  message: string;
};

export type SpreadsheetInteractivePreviewData = SpreadsheetPreviewManifest & {
  warnings: SpreadsheetPreviewWarning[];
  workbook: IWorkbookData;
};
