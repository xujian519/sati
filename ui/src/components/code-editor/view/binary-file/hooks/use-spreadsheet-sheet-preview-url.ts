import { useEffect, useState } from "react";
import { api } from "../../../../../utils/api";
import { readPreviewErrorResponse } from "../utils/preview-error";

export function useSpreadsheetSheetPreviewUrl({
  projectName,
  filePath,
  sheetIndex,
  revision,
  refreshKey,
  enabled,
}: {
  projectName: string | undefined;
  filePath: string;
  sheetIndex: number | null;
  revision: string;
  refreshKey: number;
  enabled: boolean;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled || !projectName || sheetIndex === null) {
      setPreviewUrl(null);
      setLoading(false);
      setErrorMessage(null);
      setErrorCode(null);
      return undefined;
    }

    const controller = new AbortController();
    const cacheKey = `${revision}:${refreshKey}`;

    setPreviewUrl(null);
    setLoading(true);
    setErrorMessage(null);
    setErrorCode(null);

    api
      .preflightSpreadsheetSheetPreview(projectName, filePath, sheetIndex, {
        cacheKey,
        signal: controller.signal,
      })
      .then(async (res: Response) => {
        if (!res.ok) throw await readPreviewErrorResponse(res);
        // Drain the preflight body to release the connection; the content is unused.
        await res.arrayBuffer().catch(() => null);
        // 仅在 preflight 通过后才申请票据：避免失败/中断路径遗留游离 Promise（unhandled rejection）与无谓发票。
        if (!controller.signal.aborted)
          setPreviewUrl(await api.spreadsheetSheetPreviewUrl(projectName, filePath, sheetIndex, { cacheKey }));
      })
      .catch((error: Error & { code?: string; name?: string }) => {
        if (controller.signal.aborted || error.name === "AbortError") return;
        setPreviewUrl(null);
        setErrorMessage(error.message || "Failed to load worksheet preview.");
        setErrorCode(error.code || null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [enabled, filePath, projectName, refreshKey, revision, sheetIndex]);

  return { previewUrl, errorMessage, errorCode, loading };
}
