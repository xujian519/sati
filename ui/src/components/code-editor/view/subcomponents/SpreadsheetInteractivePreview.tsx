import { useEffect, useRef, useState } from 'react';
import {
  LocaleType,
  LogLevel,
  mergeLocales,
  Univer,
  type IWorkbookData,
} from '@univerjs/core';
import { FUniver } from '@univerjs/core/facade';
import DesignZhCN from '@univerjs/design/locale/zh-CN';
import { UniverDocsPlugin } from '@univerjs/docs';
import { UniverDocsUIPlugin } from '@univerjs/docs-ui';
import DocsUIZhCN from '@univerjs/docs-ui/locale/zh-CN';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { UniverRenderEnginePlugin } from '@univerjs/engine-render';
import { UniverSheetsPlugin } from '@univerjs/sheets';
import '@univerjs/sheets/facade';
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula';
import '@univerjs/sheets-formula/facade';
import { UniverSheetsFormulaUIPlugin } from '@univerjs/sheets-formula-ui';
import SheetsFormulaUIZhCN from '@univerjs/sheets-formula-ui/locale/zh-CN';
import { UniverSheetsNumfmtPlugin } from '@univerjs/sheets-numfmt';
import '@univerjs/sheets-numfmt/facade';
import { UniverSheetsNumfmtUIPlugin } from '@univerjs/sheets-numfmt-ui';
import SheetsNumfmtUIZhCN from '@univerjs/sheets-numfmt-ui/locale/zh-CN';
import { UniverSheetsUIPlugin } from '@univerjs/sheets-ui';
import '@univerjs/sheets-ui/facade';
import SheetsUIZhCN from '@univerjs/sheets-ui/locale/zh-CN';
import SheetsZhCN from '@univerjs/sheets/locale/zh-CN';
import { UniverUIPlugin } from '@univerjs/ui';
import '@univerjs/ui/facade';
import UIZhCN from '@univerjs/ui/locale/zh-CN';
import {
  createCellRangeContentReference,
  createImageRegionContentReference,
  type CellRangeSnapshot,
  type ContentReferenceSelectionMode,
  type ReferenceCapabilities,
} from '../../../../types/contentReference';
import ContentReferenceMenu from './ContentReferenceMenu';
import RegionSelectionOverlay, { type CapturedRegion } from './RegionSelectionOverlay';

import '@univerjs/design/lib/index.css';
import '@univerjs/ui/lib/index.css';
import '@univerjs/docs-ui/lib/index.css';
import '@univerjs/sheets-ui/lib/index.css';
import '@univerjs/sheets-formula-ui/lib/index.css';
import '@univerjs/sheets-numfmt-ui/lib/index.css';

type SpreadsheetInteractivePreviewProps = {
  workbook: IWorkbookData;
  projectName?: string;
  fileName: string;
  filePath: string;
  revision?: string;
  activeSheetIndex: number;
  zoom: number;
  onActiveSheetChange: (sheetIndex: number) => void;
  onError: (error: Error) => void;
};

type UniverRuntime = {
  univer: Univer;
  api: ReturnType<typeof FUniver.newAPI>;
  disposeActiveSheetListener?: () => void;
  disposeSelectionListener?: () => void;
};

type SelectedCell = {
  address: string;
  value: string;
};

type SpreadsheetSelectionDraft = {
  sheetId: string;
  sheetName: string;
  ranges: string[];
  activeRange: string;
  cells: CellRangeSnapshot[];
  headers?: string[][];
  surroundingValues?: string[][];
};

const MAX_REFERENCE_SNAPSHOT_ROWS = 100;
const MAX_REFERENCE_SNAPSHOT_COLUMNS = 50;
const MAX_REFERENCE_CONTEXT_ROWS = 20;
const MAX_REFERENCE_CONTEXT_COLUMNS = 30;

function getSheetIndex(sheetId: string) {
  const match = /^sheet-(\d+)$/.exec(sheetId);
  return match ? Number(match[1]) : null;
}

function getColumnName(column: number) {
  let value = column + 1;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

export default function SpreadsheetInteractivePreview({
  workbook,
  projectName,
  fileName,
  filePath,
  revision,
  activeSheetIndex,
  zoom,
  onActiveSheetChange,
  onError,
}: SpreadsheetInteractivePreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<UniverRuntime | null>(null);
  const [selectedCell, setSelectedCell] = useState<SelectedCell>({
    address: 'A1',
    value: '',
  });
  const [selectionDraft, setSelectionDraft] = useState<SpreadsheetSelectionDraft | null>(null);
  const [referenceMode, setReferenceMode] = useState<ContentReferenceSelectionMode | null>(null);
  const userInteractedRef = useRef(false);
  const onActiveSheetChangeRef = useRef(onActiveSheetChange);
  const onErrorRef = useRef(onError);
  const activeSheetIndexRef = useRef(activeSheetIndex);
  const zoomRef = useRef(zoom);
  onActiveSheetChangeRef.current = onActiveSheetChange;
  onErrorRef.current = onError;
  activeSheetIndexRef.current = activeSheetIndex;
  zoomRef.current = zoom;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    try {
      const univer = new Univer({
        locale: LocaleType.ZH_CN,
        locales: {
          [LocaleType.ZH_CN]: mergeLocales(
            DesignZhCN,
            UIZhCN,
            DocsUIZhCN,
            SheetsZhCN,
            SheetsUIZhCN,
            SheetsFormulaUIZhCN,
            SheetsNumfmtUIZhCN,
          ),
        },
        logLevel: LogLevel.ERROR,
      });

      univer.registerPlugin(UniverRenderEnginePlugin);
      univer.registerPlugin(UniverFormulaEnginePlugin);
      univer.registerPlugin(UniverUIPlugin, {
        container,
        header: false,
        toolbar: false,
        footer: false,
        contextMenu: false,
        headerMenu: false,
        disableAutoFocus: true,
      });
      univer.registerPlugin(UniverDocsPlugin);
      univer.registerPlugin(UniverDocsUIPlugin);
      univer.registerPlugin(UniverSheetsPlugin);
      univer.registerPlugin(UniverSheetsUIPlugin, {
        formulaBar: false,
        footer: false,
        disableAutoFocus: true,
        disableEdit: true,
        protectedRangeShadow: false,
      });
      univer.registerPlugin(UniverSheetsFormulaPlugin);
      univer.registerPlugin(UniverSheetsFormulaUIPlugin);
      univer.registerPlugin(UniverSheetsNumfmtPlugin);
      univer.registerPlugin(UniverSheetsNumfmtUIPlugin);

      const api = FUniver.newAPI(univer);
      api.createWorkbook(workbook);
      const fWorkbook = api.getActiveWorkbook();
      const updateSelectedCell = (
        worksheet: ReturnType<NonNullable<typeof fWorkbook>['getActiveSheet']>,
        row = 0,
        column = 0,
      ) => {
        const cell = worksheet.getRange(row, column);
        const formula = cell.getFormula();
        setSelectedCell({
          address: `${getColumnName(column)}${row + 1}`,
          value: formula || cell.getDisplayValue(),
        });
      };
      if (fWorkbook) {
        fWorkbook.setActiveSheet(`sheet-${activeSheetIndexRef.current}`);
        fWorkbook.getActiveSheet().zoom(zoomRef.current);
        void fWorkbook.getWorkbookPermission().setReadOnly();
        updateSelectedCell(fWorkbook.getActiveSheet());
      }
      const activeSheetListener = api.addEvent(
        api.Event.ActiveSheetChanged,
        ({ activeSheet }) => {
          const nextIndex = getSheetIndex(activeSheet.getSheetId());
          if (nextIndex !== null) onActiveSheetChangeRef.current(nextIndex);
          updateSelectedCell(activeSheet);
        },
      );
      const selectionListener = api.addEvent(
        api.Event.SelectionChanged,
        ({ worksheet, selections }) => {
          const selection = selections[0];
          if (!selection) return;
          updateSelectedCell(
            worksheet,
            selection.startRow,
            selection.startColumn,
          );
          if (!userInteractedRef.current) return;
          const cells = selections.map((selectedRange) => {
            const range = worksheet.getRange(selectedRange);
            const rowCount = selectedRange.endRow - selectedRange.startRow + 1;
            const columnCount = selectedRange.endColumn - selectedRange.startColumn + 1;
            const snapshotRowCount = Math.min(rowCount, MAX_REFERENCE_SNAPSHOT_ROWS);
            const snapshotColumnCount = Math.min(columnCount, MAX_REFERENCE_SNAPSHOT_COLUMNS);
            const snapshotRange = worksheet.getRange(
              selectedRange.startRow,
              selectedRange.startColumn,
              snapshotRowCount,
              snapshotColumnCount,
            );
            return {
              range: range.getA1Notation(),
              displayValues: snapshotRange.getDisplayValues(),
              rawValues: snapshotRange.getValues(),
              formulas: snapshotRange.getFormulas(),
              rowCount,
              columnCount,
              truncated: rowCount > snapshotRowCount || columnCount > snapshotColumnCount,
            };
          });
          const headerRowCount = Math.min(2, selection.startRow);
          const headerColumnCount = Math.min(
            selection.endColumn - selection.startColumn + 1,
            MAX_REFERENCE_CONTEXT_COLUMNS,
          );
          const headers = headerRowCount > 0
            ? worksheet.getRange(
              selection.startRow - headerRowCount,
              selection.startColumn,
              headerRowCount,
              headerColumnCount,
            ).getDisplayValues()
            : undefined;
          const contextStartRow = Math.max(0, selection.startRow - 1);
          const contextStartColumn = Math.max(0, selection.startColumn - 1);
          const surroundingValues = worksheet.getRange(
            contextStartRow,
            contextStartColumn,
            Math.min(
              selection.endRow - contextStartRow + 2,
              MAX_REFERENCE_CONTEXT_ROWS,
            ),
            Math.min(
              selection.endColumn - contextStartColumn + 2,
              MAX_REFERENCE_CONTEXT_COLUMNS,
            ),
          ).getDisplayValues();
          setSelectionDraft({
            sheetId: worksheet.getSheetId(),
            sheetName: worksheet.getSheetName(),
            ranges: cells.map((cell) => cell.range),
            activeRange: cells[0]?.range || `${getColumnName(selection.startColumn)}${selection.startRow + 1}`,
            cells,
            headers,
            surroundingValues,
          });
        },
      );
      runtimeRef.current = {
        univer,
        api,
        disposeActiveSheetListener: () => activeSheetListener.dispose(),
        disposeSelectionListener: () => selectionListener.dispose(),
      };
    } catch (error) {
      onErrorRef.current(error instanceof Error ? error : new Error(String(error)));
    }

    return () => {
      const runtime = runtimeRef.current;
      runtimeRef.current = null;
      runtime?.disposeActiveSheetListener?.();
      runtime?.disposeSelectionListener?.();
      runtime?.univer.dispose();
    };
  }, [workbook]);

  useEffect(() => {
    const fWorkbook = runtimeRef.current?.api.getActiveWorkbook();
    if (!fWorkbook) return;
    const targetSheetId = `sheet-${activeSheetIndex}`;
    if (fWorkbook.getActiveSheet().getSheetId() !== targetSheetId) {
      fWorkbook.setActiveSheet(targetSheetId);
    }
    fWorkbook.getActiveSheet().zoom(zoom);
  }, [activeSheetIndex, zoom]);

  const capabilities: ReferenceCapabilities = {
    text: { state: 'unavailable', reason: 'NO_TEXT_LAYER' },
    cells: runtimeRef.current
      ? { state: 'available' }
      : { state: 'loading', reason: 'SURFACE_NOT_READY' },
    region: runtimeRef.current
      ? { state: 'available' }
      : { state: 'loading', reason: 'SURFACE_NOT_READY' },
    recommendedMode: 'cells',
  };

  const addCellReference = () => {
    if (!selectionDraft) return;
    const reference = createCellRangeContentReference({
      selectionMode: 'cells',
      source: {
        projectName,
        relativePath: filePath,
        fileName,
        ...(revision ? { revision: { id: revision } } : {}),
      },
      renderer: { id: 'xlsx', backend: 'builtin', locatorQuality: 'semantic' },
      locator: {
        surface: 'sheet',
        sheetId: selectionDraft.sheetId,
        sheetName: selectionDraft.sheetName,
        ranges: selectionDraft.ranges,
        activeRange: selectionDraft.activeRange,
      },
      cells: selectionDraft.cells,
      headers: selectionDraft.headers,
      surroundingValues: selectionDraft.surroundingValues,
    });
    window.dispatchEvent(new CustomEvent('pilotdeck:add-chat-reference', { detail: reference }));
  };

  const handleRegionCommit = (capture: CapturedRegion) => {
    const activeSheet = runtimeRef.current?.api.getActiveWorkbook()?.getActiveSheet();
    const sheetId = activeSheet?.getSheetId() || `sheet-${activeSheetIndex}`;
    const sheetName = activeSheet?.getSheetName() || sheetId;
    const reference = createImageRegionContentReference({
      selectionMode: 'region',
      source: {
        projectName,
        relativePath: filePath,
        fileName,
        ...(revision ? { revision: { id: revision } } : {}),
      },
      renderer: { id: 'xlsx', backend: 'builtin', locatorQuality: 'visual' },
      locator: {
        surface: 'sheet',
        sheetId,
        sheetName,
        rect: capture.rect,
        ...(selectionDraft?.activeRange ? { anchorRange: selectionDraft.activeRange } : {}),
      },
      image: {
        name: `reference-${fileName}-${sheetName}-${Date.now()}.png`,
        mimeType: 'image/png',
        width: capture.width,
        height: capture.height,
        dataUrl: capture.dataUrl,
      },
    });
    window.dispatchEvent(new CustomEvent('pilotdeck:add-chat-reference', { detail: reference }));
    setReferenceMode(null);
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-white">
      <div className="flex h-9 shrink-0 items-center border-b border-border bg-background text-sm">
        <div
          aria-label="当前单元格"
          className="w-20 shrink-0 border-r border-border px-3 font-medium text-foreground"
        >
          {selectedCell.address}
        </div>
        <div
          aria-hidden="true"
          className="shrink-0 border-r border-border px-3 font-serif italic text-muted-foreground"
        >
          fx
        </div>
        <input
          aria-label="单元格值或公式"
          className="min-w-0 flex-1 bg-transparent px-3 text-foreground outline-none"
          readOnly
          value={selectedCell.value}
        />
        <ContentReferenceMenu
          capabilities={capabilities}
          activeMode={referenceMode}
          onSelectMode={(mode) => setReferenceMode(mode === 'region' ? mode : null)}
          onCancelMode={() => setReferenceMode(null)}
          compact
        />
        {selectionDraft ? (
          <button
            type="button"
            className="mx-1 shrink-0 rounded-md bg-blue-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-blue-700"
            title={`${selectionDraft.sheetName}!${selectionDraft.ranges.join(', ')}`}
            onClick={addCellReference}
          >
            添加到对话
          </button>
        ) : null}
      </div>
      <div
        ref={containerRef}
        data-testid="spreadsheet-interactive-preview"
        className="min-h-0 w-full flex-1 overflow-hidden bg-white"
        onPointerDown={() => {
          userInteractedRef.current = true;
        }}
      />
      <RegionSelectionOverlay
        active={referenceMode === 'region'}
        hostRef={containerRef}
        resolveTarget={() => {
          const element = containerRef.current;
          if (!element) return null;
          const activeSheet = runtimeRef.current?.api.getActiveWorkbook()?.getActiveSheet();
          return {
            element,
            surface: 'sheet',
            sheetId: activeSheet?.getSheetId() || `sheet-${activeSheetIndex}`,
            sheetName: activeSheet?.getSheetName() || `Sheet ${activeSheetIndex + 1}`,
            anchorRange: selectionDraft?.activeRange,
          };
        }}
        onCommit={handleRegionCommit}
        onCancel={() => setReferenceMode(null)}
      />
    </div>
  );
}
