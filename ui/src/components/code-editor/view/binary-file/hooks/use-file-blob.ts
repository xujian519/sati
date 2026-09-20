import { useEffect, useRef, useState } from "react";
import { api } from "../../../../../utils/api";
import type { BlobSource } from "../types";
import { readPreviewErrorResponse } from "../utils/preview-error";
import { usePreviewReloadRequest } from "./use-preview-reload-request";

export function useFileBlob(
  projectName: string | undefined,
  filePath: string,
  enabled: boolean,
  source: BlobSource = "raw",
) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const { reloadRequest, reload } = usePreviewReloadRequest();
  const lastRequestKeyRef = useRef("");

  useEffect(() => {
    if (!enabled || !projectName) {
      setBlob(null);
      setLoading(false);
      setErrorMessage(enabled ? "Project is not available." : null);
      setErrorCode(null);
      return;
    }

    const requestKey = `${source}:${projectName}:${filePath}`;
    const isNewFile = lastRequestKeyRef.current !== requestKey;
    lastRequestKeyRef.current = requestKey;

    let cancelled = false;

    if (isNewFile) {
      setBlob(null);
    }
    setLoading(true);
    setErrorMessage(null);
    setErrorCode(null);

    const request =
      source === "office-pdf"
        ? api.readOfficePdfPreviewBlob(projectName, filePath, { force: reloadRequest.force })
        : api.readFileBlob(projectName, filePath);

    request
      .then(async (res: Response) => {
        if (res.ok) {
          return res.blob();
        }

        throw await readPreviewErrorResponse(res);
      })
      .then((nextBlob: Blob) => {
        if (cancelled) return;
        setBlob(nextBlob);
      })
      .catch((error: Error & { code?: string }) => {
        if (cancelled) return;
        if (isNewFile) {
          setBlob(null);
        }
        setErrorMessage(error.message || "Failed to load file preview.");
        setErrorCode(error.code || null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, projectName, filePath, source, reloadRequest.force, reloadRequest.key]);

  return { blob, errorMessage, errorCode, loading, reload };
}
