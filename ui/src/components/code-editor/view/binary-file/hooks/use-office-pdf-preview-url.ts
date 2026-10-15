import { useEffect, useRef, useState } from "react";
import { api } from "../../../../../utils/api";
import { readPreviewErrorResponse } from "../utils/preview-error";
import { usePreviewReloadRequest } from "./use-preview-reload-request";

export function useOfficePdfPreviewUrl(projectName: string | undefined, filePath: string, enabled: boolean) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const { reloadRequest, reload } = usePreviewReloadRequest();
  const lastRequestKeyRef = useRef("");

  useEffect(() => {
    if (!enabled || !projectName) {
      setPreviewUrl(null);
      setLoading(false);
      setErrorMessage(enabled ? "Project is not available." : null);
      setErrorCode(null);
      return undefined;
    }

    const requestKey = `office-pdf:${projectName}:${filePath}`;
    const isNewFile = lastRequestKeyRef.current !== requestKey;
    lastRequestKeyRef.current = requestKey;
    const controller = new AbortController();

    if (isNewFile) {
      setPreviewUrl(null);
    }
    setLoading(true);
    setErrorMessage(null);
    setErrorCode(null);

    const cacheKey = `${reloadRequest.key}`;

    api
      .preflightOfficePdfPreview(projectName, filePath, {
        force: reloadRequest.force,
        cacheKey,
        signal: controller.signal,
      })
      .then(async (res: Response) => {
        if (!res.ok) {
          throw await readPreviewErrorResponse(res);
        }
        // Drain the preflight body to release the connection; the content is unused.
        await res.arrayBuffer().catch(() => null);
        if (!controller.signal.aborted) {
          // 仅在 preflight 通过后才申请票据：避免失败/中断路径遗留游离 Promise（unhandled rejection）与无谓发票。
          setPreviewUrl(await api.officePdfPreviewUrl(projectName, filePath, { cacheKey }));
        }
      })
      .catch((error: Error & { code?: string; name?: string }) => {
        if (controller.signal.aborted || error.name === "AbortError") return;
        if (isNewFile) {
          setPreviewUrl(null);
        }
        setErrorMessage(error.message || "Failed to load file preview.");
        setErrorCode(error.code || null);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [enabled, projectName, filePath, reloadRequest.force, reloadRequest.key]);

  return { previewUrl, errorMessage, errorCode, loading, reload };
}
