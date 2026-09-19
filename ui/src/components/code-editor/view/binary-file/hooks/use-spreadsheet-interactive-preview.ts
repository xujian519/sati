import { useEffect, useRef, useState } from "react";
import { api } from "../../../../../utils/api";
import type { SpreadsheetInteractivePreviewData } from "../types";
import { readPreviewErrorResponse } from "../utils/preview-error";
import { usePreviewReloadRequest } from "./use-preview-reload-request";

export function useSpreadsheetInteractivePreview(projectName: string | undefined, filePath: string, enabled: boolean) {
  const [data, setData] = useState<SpreadsheetInteractivePreviewData | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const { reloadRequest, reload } = usePreviewReloadRequest();
  const lastRequestKeyRef = useRef("");

  useEffect(() => {
    if (!enabled || !projectName) {
      setData(null);
      setLoading(false);
      setErrorMessage(enabled ? "Project is not available." : null);
      setErrorCode(null);
      return undefined;
    }

    const requestKey = `spreadsheet-interactive:${projectName}:${filePath}`;
    const isNewFile = lastRequestKeyRef.current !== requestKey;
    lastRequestKeyRef.current = requestKey;
    const controller = new AbortController();

    if (isNewFile) setData(null);
    setLoading(true);
    setErrorMessage(null);
    setErrorCode(null);

    api
      .spreadsheetInteractivePreview(projectName, filePath, {
        force: reloadRequest.force,
        cacheKey: reloadRequest.key,
        signal: controller.signal,
      })
      .then(async (res: Response) => {
        if (!res.ok) throw await readPreviewErrorResponse(res);
        return res.json();
      })
      .then((nextData: SpreadsheetInteractivePreviewData) => {
        if (controller.signal.aborted) return;
        if (!nextData?.workbook || !Array.isArray(nextData.sheets)) {
          throw new Error("Interactive workbook data is incomplete.");
        }
        setData(nextData);
      })
      .catch((error: Error & { code?: string; name?: string }) => {
        if (controller.signal.aborted || error.name === "AbortError") return;
        if (isNewFile) setData(null);
        setErrorMessage(error.message || "Failed to load interactive workbook preview.");
        setErrorCode(error.code || null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [enabled, filePath, projectName, reloadRequest.force, reloadRequest.key]);

  return {
    data,
    errorMessage,
    errorCode,
    loading,
    reload,
  };
}
