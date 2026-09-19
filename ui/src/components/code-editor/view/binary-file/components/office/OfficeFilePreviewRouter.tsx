import { useTranslation } from "react-i18next";
import type { CodeEditorFile } from "../../../../types/types";
import { isBuiltinOfficeFile, isSpreadsheetFile } from "../../../../utils/binaryFile";
import { getExtension } from "../../utils/file-type";
import { useOfficePreviewService } from "../../hooks/use-office-preview-service";
import DownloadButton from "../atoms/DownloadButton";
import FallbackContent from "../atoms/FallbackContent";
import OfficePreviewSettingsButton from "../atoms/OfficePreviewSettingsButton";
import PreviewSpinner from "../atoms/PreviewSpinner";
import SpreadsheetPreview from "../spreadsheet/SpreadsheetPreview";
import BuiltinModernOfficePreview from "./BuiltinModernOfficePreview";
import OfficePreview from "./OfficePreview";

export default function OfficeFilePreviewRouter({
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
  const { status, loading } = useOfficePreviewService();
  const service = status?.service || "builtin";

  if (loading) {
    return <PreviewSpinner label={t("officePreview.checkingService")} />;
  }
  if (service === "libreoffice") {
    return isSpreadsheetFile(file.name) ? (
      <SpreadsheetPreview
        service={service}
        projectName={projectName}
        file={file}
        title={title}
        onClose={onClose}
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
      />
    ) : (
      <OfficePreview
        projectName={projectName}
        file={file}
        title={title}
        onClose={onClose}
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
      />
    );
  }

  if (!isBuiltinOfficeFile(file.name)) {
    return (
      <FallbackContent
        title={t("officePreview.unsupportedBuiltinTitle")}
        message={t("officePreview.unsupportedBuiltinMessage", {
          extension: `.${getExtension(file.name)}`,
        })}
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

  if (isSpreadsheetFile(file.name)) {
    return (
      <SpreadsheetPreview
        service={service}
        projectName={projectName}
        file={file}
        title={title}
        onClose={onClose}
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
      />
    );
  }

  return (
    <BuiltinModernOfficePreview
      projectName={projectName}
      file={file}
      title={title}
      onClose={onClose}
      isFullscreen={isFullscreen}
      onToggleFullscreen={onToggleFullscreen}
    />
  );
}
