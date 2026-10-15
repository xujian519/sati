import { useEffect, useState } from "react";
import type { CodeEditorFile } from "../../../types/types";
import { api } from "../../../../../utils/api";
import PdfDocumentPreview from "../../subcomponents/PdfDocumentPreview";
import { useDownloadUrl } from "../hooks/use-download-url";
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
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const downloadUrl = useDownloadUrl(projectName, file.path);

  // 预览 URL 携短期票据（#626）：异步申请后再拼 previewRevision，不将会话 JWT 落进 URL。
  useEffect(() => {
    if (!projectName) {
      setPreviewUrl(null);
      return undefined;
    }
    let alive = true;
    api
      .fileContentUrl(projectName, file.path)
      .then(base => {
        if (!alive) return;
        const separator = base.includes("?") ? "&" : "?";
        setPreviewUrl(`${base}${separator}previewRevision=${refreshKey}`);
      })
      .catch(() => {
        if (alive) setPreviewUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [projectName, file.path, refreshKey]);

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
      downloadUrl={downloadUrl}
      downloadName={file.name}
      isFullscreen={isFullscreen}
      onToggleFullscreen={onToggleFullscreen}
    />
  );
}
