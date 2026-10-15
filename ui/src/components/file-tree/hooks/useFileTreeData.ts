import { useCallback, useEffect, useRef, useState } from "react";
import { logError } from "../../../utils/logging";
import { api } from "../../../utils/api";
import type { Project } from "../../../types/app";
import type { FileTreeNode } from "../types/types";

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  /** 服务端按设计拒绝该工作区的文件访问（403）——与「项目确实没有文件」是两回事。 */
  unavailable: boolean;
  refreshFiles: () => void;
};

export function useFileTreeData(selectedProject: Project | null): UseFileTreeDataResult {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const refreshFiles = useCallback(() => {
    setRefreshKey(prev => prev + 1);
  }, []);

  useEffect(() => {
    const projectName = selectedProject?.name;

    if (!projectName) {
      setFiles([]);
      setLoading(false);
      setUnavailable(false);
      return;
    }

    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Track mount state so aborted or late responses do not enqueue stale state updates.
    let isActive = true;

    const fetchFiles = async () => {
      if (isActive) {
        setLoading(true);
      }
      try {
        const response = await api.getFiles(projectName, { signal: abortControllerRef.current!.signal });

        if (!response.ok) {
          const errorText = await response.text();
          logError("File fetch failed:", response.status, errorText);
          if (isActive) {
            setFiles([]);
            setUnavailable(response.status === 403);
          }
          return;
        }

        const data = (await response.json()) as FileTreeNode[];
        if (isActive) {
          setFiles(data);
          setUnavailable(false);
        }
      } catch (error) {
        if ((error as { name?: string }).name === "AbortError") {
          return;
        }

        logError("Error fetching files:", error);
        if (isActive) {
          setFiles([]);
          setUnavailable(false);
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    void fetchFiles();

    return () => {
      isActive = false;
      abortControllerRef.current?.abort();
    };
  }, [selectedProject?.name, refreshKey]);

  return {
    files,
    loading,
    unavailable,
    refreshFiles,
  };
}
