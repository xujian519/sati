import { useTranslation } from "react-i18next";
import type { CodeEditorFile } from "../../../../types/types";
import { api } from "../../../../../../utils/api";
import { getPdfNavigationMode } from "../../../../utils/documentPreview";
import PdfDocumentPreview from "../../../subcomponents/PdfDocumentPreview";
import { useOfficeAutoRefresh } from "../../hooks/use-office-auto-refresh";
import { useOfficePdfPreviewUrl } from "../../hooks/use-office-pdf-preview-url";
import DownloadButton from "../atoms/DownloadButton";
import FallbackContent from "../atoms/FallbackContent";
import OfficePreviewSettingsButton from "../atoms/OfficePreviewSettingsButton";
import PreviewSpinner from "../atoms/PreviewSpinner";

export default function OfficePreview({
  projectName,
  file,
  title,
  onClose,
  isFullscreen,
  onToggleFullscreen,
}: {
  projectName?: string;
  file: CodeEditorFile;
  title: string;
  onClose: () => void;
  isFullscreen: boolean;
  onToggleFullscreen?: (() => void) | null;
}) {
  const { t } = useTranslation("codeEditor");
  const { previewUrl, errorMessage, errorCode, loading, reload } = useOfficePdfPreviewUrl(projectName, file.path, true);

  useOfficeAutoRefresh(projectName, file.path, reload);

  if (loading && !previewUrl) return <PreviewSpinner label={t("officePreview.converting")} />;
  if (errorMessage || !previewUrl) {
    const needsLibreOffice =
      errorCode === "LIBREOFFICE_NOT_FOUND" ||
      errorMessage?.includes("LibreOffice") ||
      errorMessage === "LIBREOFFICE_NOT_FOUND";
    const fallbackTitle = needsLibreOffice ? t("officePreview.libreOfficeUnavailableTitle") : title;
    const fallbackMessage = needsLibreOffice
      ? t("officePreview.libreOfficeUnavailableMessage")
      : errorMessage || t("officePreview.failedMessage");

    return (
      <FallbackContent
        title={fallbackTitle}
        message={fallbackMessage}
        onClose={onClose}
        actions={
          <>
            <DownloadButton projectName={projectName} file={file} />
            <OfficePreviewSettingsButton />
          </>
        }
      />
    );
  }

  return (
    <PdfDocumentPreview
      url={previewUrl}
      projectName={projectName}
      fileName={file.name}
      filePath={file.path}
      source="office-pdf"
      loadingOverlay={loading ? t("officePreview.refreshing") : null}
      navigationMode={getPdfNavigationMode(file.name)}
      onRefresh={() => reload({ force: true })}
      refreshDisabled={loading}
      downloadUrl={projectName ? api.fileDownloadUrl(projectName, file.path) : null}
      downloadName={file.name}
      isFullscreen={isFullscreen}
      onToggleFullscreen={onToggleFullscreen}
    />
  );
}
