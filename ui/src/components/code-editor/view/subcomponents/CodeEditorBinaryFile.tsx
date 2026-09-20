import { useTranslation } from "react-i18next";
import { isImageFile, isOfficeFile, isPdfFile } from "../../utils/binaryFile";
import FallbackContent from "../binary-file/components/atoms/FallbackContent";
import FileTypeBadge from "../binary-file/components/atoms/FileTypeBadge";
import ImagePreview from "../binary-file/components/ImagePreview";
import PdfPreview from "../binary-file/components/PdfPreview";
import OfficeFilePreviewRouter from "../binary-file/components/office/OfficeFilePreviewRouter";
import type { CodeEditorBinaryFileProps } from "../binary-file/types";

export default function CodeEditorBinaryFile({
  file,
  projectName,
  isSidebar,
  compactHeader = false,
  isFullscreen,
  isExpanded = false,
  onClose,
  onToggleFullscreen,
  onToggleExpand = null,
  title,
  message,
  headerPrefix,
}: CodeEditorBinaryFileProps) {
  const { t } = useTranslation("codeEditor");
  const iconBtn =
    "flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100";

  const isImage = isImageFile(file.name);
  const isPdf = isPdfFile(file.name);
  const isOffice = isOfficeFile(file.name);
  const canPreview = isImage || isPdf || isOffice;
  const hasEmbeddedDocumentToolbar = isPdf || isOffice;
  const documentIsFullscreen = isSidebar ? isExpanded : isFullscreen;
  const onToggleDocumentFullscreen = isSidebar ? onToggleExpand : onToggleFullscreen;

  const previewContent = isImage ? (
    <ImagePreview projectName={projectName} file={file} title={title} message={message} onClose={onClose} />
  ) : isPdf ? (
    <PdfPreview
      projectName={projectName}
      file={file}
      title={title}
      message={message}
      onClose={onClose}
      isFullscreen={documentIsFullscreen}
      onToggleFullscreen={onToggleDocumentFullscreen}
    />
  ) : isOffice ? (
    <OfficeFilePreviewRouter
      projectName={projectName}
      file={file}
      title={title}
      onClose={onClose}
      isFullscreen={documentIsFullscreen}
      onToggleFullscreen={onToggleDocumentFullscreen}
    />
  ) : (
    <FallbackContent title={title} message={message} onClose={onClose} />
  );

  const headerTopBar = (
    <div
      className={
        compactHeader
          ? "absolute top-1 right-2 z-10 flex h-8 items-center rounded-md bg-neutral-50 px-1 dark:bg-neutral-900"
          : "flex flex-shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-4 py-2 dark:border-neutral-800 dark:bg-neutral-950"
      }
    >
      {!compactHeader && (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FileTypeBadge fileName={file.name} />
          <h3 className="truncate text-[13px] font-medium text-neutral-900 dark:text-neutral-100">{file.name}</h3>
        </div>
      )}
      <div className="flex shrink-0 items-center gap-0.5">
        {!isSidebar && !hasEmbeddedDocumentToolbar && (
          <button
            type="button"
            onClick={onToggleFullscreen}
            className={iconBtn}
            title={isFullscreen ? t("actions.exitFullscreen") : t("actions.fullscreen")}
          >
            {isFullscreen ? (
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.75}
                  d="M9 9V4.5M9 9H4.5M9 9L3.5 3.5M9 15v4.5M9 15H4.5M9 15l-5.5 5.5M15 9h4.5M15 9V4.5M15 9l5.5-5.5M15 15h4.5M15 15v4.5m0-4.5l5.5 5.5"
                />
              </svg>
            ) : (
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.75}
                  d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
                />
              </svg>
            )}
          </button>
        )}
        {!headerPrefix ? (
          <button type="button" onClick={onClose} className={iconBtn} title={t("actions.close")}>
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        ) : null}
      </div>
    </div>
  );

  if (isSidebar) {
    return (
      <div className="relative flex h-full w-full flex-col bg-white dark:bg-neutral-950">
        {headerPrefix}
        {!compactHeader || !headerPrefix ? headerTopBar : null}
        {previewContent}
      </div>
    );
  }

  const containerClassName = isFullscreen
    ? "fixed inset-0 z-[9999] bg-white dark:bg-neutral-950 flex flex-col"
    : "fixed inset-0 z-[9999] md:bg-black/40 md:backdrop-blur-xs md:flex md:items-center md:justify-center md:p-4";

  const innerClassName = isFullscreen
    ? "bg-white dark:bg-neutral-950 flex flex-col w-full h-full"
    : `bg-white dark:bg-neutral-950 flex flex-col w-full h-full md:rounded-xl md:border md:border-neutral-200 dark:md:border-neutral-800 md:shadow-xl ${
        canPreview
          ? "md:w-full md:max-w-5xl md:h-[85vh] md:max-h-[85vh]"
          : "md:w-full md:max-w-2xl md:h-auto md:max-h-[60vh]"
      }`;

  return (
    <div className={containerClassName}>
      <div className={innerClassName}>
        {headerPrefix}
        {headerTopBar}
        {previewContent}
      </div>
    </div>
  );
}
