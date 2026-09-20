import { useEffect, useRef, useState } from "react";
import { api } from "../../../../../utils/api";
import type { SpreadsheetPreviewManifest } from "../types";
import { readPreviewErrorResponse } from "../utils/preview-error";
import { usePreviewReloadRequest } from "./use-preview-reload-request";

export function useSpreadsheetPreviewManifest(projectName: string | undefined, filePath: string, enabled: boolean) {
  const [manifest, setManifest] = useState<SpreadsheetPreviewManifest | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const { reloadRequest, reload } = usePreviewReloadRequest();
  const lastRequestKeyRef = useRef("");

  useEffect(() => {
    if (!enabled || !projectName) {
      setManifest(null);
      setLoading(false);
      setErrorMessage(enabled ? "Project is not available." : null);
      setErrorCode(null);
      return undefined;
    }

    const requestKey = `spreadsheet:${projectName}:${filePath}`;
    const isNewFile = lastRequestKeyRef.current !== requestKey;
    lastRequestKeyRef.current = requestKey;
    const controller = new AbortController();

    if (isNewFile) setManifest(null);
    setLoading(true);
    setErrorMessage(null);
    setErrorCode(null);

    api
      .spreadsheetPreviewManifest(projectName, filePath, {
        force: reloadRequest.force,
        cacheKey: reloadRequest.key,
        signal: controller.signal,
      })
      .then(async (res: Response) => {
        if (!res.ok) throw await readPreviewErrorResponse(res);
        return res.json();
      })
      .then((nextManifest: SpreadsheetPreviewManifest) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(nextManifest?.sheets) || nextManifest.sheets.length === 0) {
          throw new Error("The workbook does not contain a visible worksheet.");
        }
        setManifest(nextManifest);
      })
      .catch((error: Error & { code?: string; name?: string }) => {
        if (controller.signal.aborted || error.name === "AbortError") return;
        if (isNewFile) setManifest(null);
        setErrorMessage(error.message || "Failed to read workbook worksheets.");
        setErrorCode(error.code || null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [enabled, filePath, projectName, reloadRequest.force, reloadRequest.key]);

  return {
    manifest,
    errorMessage,
    errorCode,
    loading,
    reload,
    refreshKey: reloadRequest.key,
  };
}
