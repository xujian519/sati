import { Suspense, lazy, useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { CodeEditorFile } from "../../../../types/types";
import { api } from "../../../../../../utils/api";
import PdfDocumentPreview from "../../../subcomponents/PdfDocumentPreview";
import SpreadsheetTabs from "../../../subcomponents/SpreadsheetTabs";
import type { OfficePreviewService } from "../../../../../../utils/officePreviewStatus";
import type { ReloadOptions } from "../../types";
import { useOfficeAutoRefresh } from "../../hooks/use-office-auto-refresh";
import { useSpreadsheetInteractivePreview } from "../../hooks/use-spreadsheet-interactive-preview";
import { useSpreadsheetPreviewManifest } from "../../hooks/use-spreadsheet-preview-manifest";
import { useSpreadsheetSheetPreviewUrl } from "../../hooks/use-spreadsheet-sheet-preview-url";
import DownloadButton from "../atoms/DownloadButton";
import FallbackContent from "../atoms/FallbackContent";
import OfficePreviewSettingsButton from "../atoms/OfficePreviewSettingsButton";
import PreviewSpinner from "../atoms/PreviewSpinner";
import RetryPreviewButton from "../atoms/RetryPreviewButton";
import SpreadsheetPreviewToolbar from "./SpreadsheetPreviewToolbar";

const SpreadsheetInteractivePreview = lazy(() => import("../../../subcomponents/SpreadsheetInteractivePreview"));

export default function SpreadsheetPreview({
  service,
  projectName,
  file,
  title,
  onClose,
  isFullscreen,
  onToggleFullscreen,
}: {
  service: OfficePreviewService;
  projectName?: string;
  file: CodeEditorFile;
  title: string;
  onClose: () => void;
  isFullscreen: boolean;
  onToggleFullscreen?: (() => void) | null;
}) {
  const { t } = useTranslation("codeEditor");
  const [zoom, setZoom] = useState(1);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const usePrintPreview = service === "libreoffice";
  const interactiveEnabled = !usePrintPreview;
  const {
    data: interactiveData,
    errorMessage: interactiveError,
    errorCode: interactiveErrorCode,
    loading: interactiveLoading,
    reload: reloadInteractive,
  } = useSpreadsheetInteractivePreview(projectName, file.path, interactiveEnabled);
  const interactiveFailure = interactiveError || runtimeError;
  const printPreviewEnabled = usePrintPreview;
  const {
    manifest,
    errorMessage: manifestError,
    errorCode: manifestErrorCode,
    loading: manifestLoading,
    reload: reloadPrint,
    refreshKey,
  } = useSpreadsheetPreviewManifest(projectName, file.path, printPreviewEnabled);
  const [selectedSheetIndex, setSelectedSheetIndex] = useState<number | null>(null);

  const reload = useCallback(
    (options: ReloadOptions = {}) => {
      setRuntimeError(null);
      if (!usePrintPreview) reloadInteractive(options);
      else reloadPrint(options);
    },
    [reloadInteractive, reloadPrint, usePrintPreview],
  );

  useOfficeAutoRefresh(projectName, file.path, reload);

  /**
   * 服务端错误码 → 用户可读提示。
   *
   * 失败态此前直接把服务端下发的原始异常文本当正文（`Error: ... at ...`），用户既读不懂
   * 也无法据此行动。错误码是既有契约，按码给可操作的话。
   *
   * 无错误码时**不能**直接丢给通用文案——hook 的 `!projectName`（"Project is not
   * available."）与客户端侧失败（"Interactive workbook data is incomplete."）都是
   * `errorCode === null` 但 message 有实义，故 fallback 由调用方传入原始 message。
   */
  const failureMessageFor = useCallback(
    (code: string | null, fallback: string) => {
      switch (code) {
        case "SPREADSHEET_PACKAGE_INVALID":
        case "SPREADSHEET_WORKBOOK_XML_MISSING":
          return t("spreadsheetPreview.errors.invalidFile");
        case "SPREADSHEET_INTERACTIVE_PARSE_FAILED":
          return t("spreadsheetPreview.errors.cannotParse");
        case "SPREADSHEET_INTERACTIVE_TOO_LARGE":
          return t("spreadsheetPreview.errors.tooLarge");
        case "SPREADSHEET_VISIBLE_SHEET_MISSING":
          return t("spreadsheetPreview.errors.noVisibleSheets");
        case "SPREADSHEET_PREVIEW_SOURCE_NOT_FOUND":
          return t("spreadsheetPreview.errors.fileMissing");
        default:
          return fallback;
      }
    },
    [t],
  );

  useEffect(() => {
    setZoom(1);
    setRuntimeError(null);
    setSelectedSheetIndex(null);
  }, [file.path]);

  const activeManifest = usePrintPreview ? manifest : interactiveData;

  useEffect(() => {
    if (!activeManifest) return;
    setSelectedSheetIndex(current =>
      current !== null && activeManifest.sheets.some(sheet => sheet.index === current)
        ? current
        : activeManifest.sheets.some(sheet => sheet.index === activeManifest.activeSheetIndex)
          ? activeManifest.activeSheetIndex
          : (activeManifest.sheets[0]?.index ?? null),
    );
  }, [activeManifest]);

  const {
    previewUrl,
    errorMessage: sheetError,
    errorCode: sheetErrorCode,
    loading: sheetLoading,
  } = useSpreadsheetSheetPreviewUrl({
    projectName,
    filePath: file.path,
    sheetIndex: selectedSheetIndex,
    revision: manifest?.revision || "",
    refreshKey,
    enabled: printPreviewEnabled && Boolean(manifest) && selectedSheetIndex !== null,
  });

  let sheetContent: ReactNode;
  if (!usePrintPreview) {
    if (interactiveLoading && !interactiveData) {
      sheetContent = <PreviewSpinner label={t("spreadsheetPreview.readingWorkbook")} />;
    } else if (interactiveFailure || !interactiveData || selectedSheetIndex === null) {
      sheetContent = (
        <FallbackContent
          title={title}
          message={failureMessageFor(
            interactiveErrorCode,
            interactiveFailure || t("spreadsheetPreview.interactiveFailedMessage"),
          )}
          onClose={onClose}
          actions={
            <>
              <RetryPreviewButton onRetry={() => reload()} />
              <DownloadButton projectName={projectName} file={file} />
              <OfficePreviewSettingsButton />
            </>
          }
        />
      );
    } else {
      sheetContent = (
        <Suspense fallback={<PreviewSpinner label={t("spreadsheetPreview.loadingInteractive")} />}>
          <SpreadsheetInteractivePreview
            key={interactiveData.revision}
            workbook={interactiveData.workbook}
            projectName={projectName}
            fileName={file.name}
            filePath={file.path}
            revision={interactiveData.revision}
            activeSheetIndex={selectedSheetIndex}
            zoom={zoom}
            onActiveSheetChange={setSelectedSheetIndex}
            onError={error => setRuntimeError(error.message)}
          />
        </Suspense>
      );
    }
  } else if (manifestLoading && !manifest) {
    sheetContent = <PreviewSpinner label={t("spreadsheetPreview.readingWorkbook")} />;
  } else if (manifestError || !manifest) {
    const needsLibreOffice = manifestErrorCode === "LIBREOFFICE_NOT_FOUND";
    sheetContent = (
      <FallbackContent
        title={needsLibreOffice ? t("officePreview.libreOfficeUnavailableTitle") : title}
        message={
          needsLibreOffice
            ? t("officePreview.libreOfficeUnavailableMessage")
            : failureMessageFor(manifestErrorCode, manifestError || t("spreadsheetPreview.failedMessage"))
        }
        onClose={onClose}
        actions={
          <>
            <RetryPreviewButton onRetry={() => reload()} />
            <DownloadButton projectName={projectName} file={file} />
            {needsLibreOffice && <OfficePreviewSettingsButton />}
          </>
        }
      />
    );
  } else {
    const needsLibreOffice = sheetErrorCode === "LIBREOFFICE_NOT_FOUND";
    if (sheetLoading || selectedSheetIndex === null) {
      sheetContent = <PreviewSpinner label={t("spreadsheetPreview.renderingSheet")} />;
    } else if (sheetError || !previewUrl) {
      sheetContent = (
        <FallbackContent
          title={needsLibreOffice ? t("officePreview.libreOfficeUnavailableTitle") : title}
          message={
            needsLibreOffice
              ? t("officePreview.libreOfficeUnavailableMessage")
              : failureMessageFor(sheetErrorCode, sheetError || t("spreadsheetPreview.failedMessage"))
          }
          onClose={onClose}
          actions={
            <>
              <RetryPreviewButton onRetry={() => reload()} />
              <DownloadButton projectName={projectName} file={file} />
              {needsLibreOffice && <OfficePreviewSettingsButton />}
            </>
          }
        />
      );
    } else {
      sheetContent = (
        <PdfDocumentPreview
          url={previewUrl}
          projectName={projectName}
          fileName={file.name}
          filePath={file.path}
          source="office-pdf"
          viewKey={`worksheet:${selectedSheetIndex}`}
          loadingOverlay={manifestLoading ? t("officePreview.refreshing") : null}
          navigationMode="none"
          showPageControls={false}
          onRefresh={() => reloadPrint({ force: true })}
          refreshDisabled={manifestLoading || sheetLoading}
          downloadUrl={projectName ? api.fileDownloadUrl(projectName, file.path) : null}
          downloadName={file.name}
          isFullscreen={isFullscreen}
          onToggleFullscreen={onToggleFullscreen}
        />
      );
    }
  }

  const previewWarning = !usePrintPreview ? interactiveData?.warnings?.[0] : null;
  const warning = previewWarning
    ? t(`spreadsheetPreview.warnings.${previewWarning.code}`, {
        defaultValue: previewWarning.message,
      })
    : null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-neutral-100 dark:bg-neutral-900">
      {!usePrintPreview && (
        <SpreadsheetPreviewToolbar
          zoom={zoom}
          projectName={projectName}
          file={file}
          isFullscreen={isFullscreen}
          refreshing={interactiveLoading}
          onZoomChange={setZoom}
          onRefresh={() => reload({ force: true })}
          onToggleFullscreen={onToggleFullscreen}
        />
      )}
      {warning && (
        <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
          {warning}
        </div>
      )}
      <div className="min-h-0 flex-1">{sheetContent}</div>
      {activeManifest && (
        <SpreadsheetTabs
          sheets={activeManifest.sheets}
          activeSheetIndex={selectedSheetIndex ?? activeManifest.activeSheetIndex}
          disabled={usePrintPreview ? manifestLoading : interactiveLoading}
          onSelect={setSelectedSheetIndex}
        />
      )}
    </div>
  );
}
