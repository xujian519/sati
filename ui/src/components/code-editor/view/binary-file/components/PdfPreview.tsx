import { useState } from "react";
import type { CodeEditorFile } from "../../../types/types";
import { api } from "../../../../../utils/api";
import PdfDocumentPreview from "../../subcomponents/PdfDocumentPreview";
import FallbackContent from "./atoms/FallbackContent";

export default function PdfPreview({
  projectName,
  file,
  title,
  message,
  onClose,
  isFullscreen,
  onToggleFullscreen,
}: {
  projectName?: string;
  file: CodeEditorFile;
  title: string;
  message: string;
  onClose: () => void;
  isFullscreen: boolean;
  onToggleFullscreen?: (() => void) | null;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const basePreviewUrl = projectName ? api.fileContentUrl(projectName, file.path) : null;
  const previewUrl = basePreviewUrl
    ? `${basePreviewUrl}${basePreviewUrl.includes("?") ? "&" : "?"}previewRevision=${refreshKey}`
    : null;

  if (!previewUrl) {
    return <FallbackContent title={title} message={message} onClose={onClose} />;
  }

  return (
    <PdfDocumentPreview
      url={previewUrl}
      projectName={projectName}
      fileName={file.name}
      filePath={file.path}
      source="pdf"
      navigationMode="pages"
      onRefresh={() => setRefreshKey(value => value + 1)}
      downloadUrl={projectName ? api.fileDownloadUrl(projectName, file.path) : null}
      downloadName={file.name}
      isFullscreen={isFullscreen}
      onToggleFullscreen={onToggleFullscreen}
    />
  );
}
