import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CodeEditorFile } from "../../../../types/types";
import { api } from "../../../../../../utils/api";
import { isWordFile } from "../../../../utils/binaryFile";
import { useFileBlob } from "../../hooks/use-file-blob";
import { useOfficeAutoRefresh } from "../../hooks/use-office-auto-refresh";
import DownloadButton from "../atoms/DownloadButton";
import FallbackContent from "../atoms/FallbackContent";
import OfficePreviewSettingsButton from "../atoms/OfficePreviewSettingsButton";
import PreviewSpinner from "../atoms/PreviewSpinner";

const DocxBuiltinPreview = lazy(() => import("../../../subcomponents/DocxBuiltinPreview"));
const PptxBuiltinPreview = lazy(() => import("../../../subcomponents/PptxBuiltinPreview"));

export default function BuiltinModernOfficePreview({
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
  const { blob, errorMessage, loading, reload } = useFileBlob(projectName, file.path, true);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const handleReload = useCallback(() => {
    setRuntimeError(null);
    reload({ force: true });
  }, [reload]);
  const handleRuntimeError = useCallback((error: Error) => {
    setRuntimeError(error.message);
  }, []);

  useOfficeAutoRefresh(projectName, file.path, handleReload);
  useEffect(() => {
    setRuntimeError(null);
  }, [file.path]);

  if (loading && !blob) {
    return <PreviewSpinner label={t("officePreview.loadingBuiltin")} />;
  }
  if (errorMessage || runtimeError || !blob) {
    return (
      <FallbackContent
        title={title}
        message={runtimeError || errorMessage || t("officePreview.failedMessage")}
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

  const commonProps = {
    blob,
    projectName,
    fileName: file.name,
    filePath: file.path,
    downloadUrl: projectName ? api.fileDownloadUrl(projectName, file.path) : null,
    downloadName: file.name,
    isFullscreen,
    onToggleFullscreen,
    refreshing: loading,
    onRefresh: handleReload,
    onError: handleRuntimeError,
  };

  return (
    <Suspense fallback={<PreviewSpinner label={t("officePreview.loadingBuiltin")} />}>
      {isWordFile(file.name) ? <DocxBuiltinPreview {...commonProps} /> : <PptxBuiltinPreview {...commonProps} />}
    </Suspense>
  );
}
