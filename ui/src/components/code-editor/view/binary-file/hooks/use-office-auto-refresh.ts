import { useEffect } from "react";
import type { ReloadOptions } from "../types";
import { pathsReferToSameFile } from "../utils/paths";

export function useOfficeAutoRefresh(
  projectName: string | undefined,
  filePath: string,
  reload: (options?: ReloadOptions) => void,
) {
  useEffect(() => {
    const matchesFile = (detail: unknown) => {
      if (!detail || typeof detail !== "object") return false;
      const payload = detail as { projectName?: string; filePath?: string; path?: string };
      const changedPath = payload.filePath || payload.path;
      if (!changedPath) return false;
      return (
        (!payload.projectName || payload.projectName === projectName) && pathsReferToSameFile(changedPath, filePath)
      );
    };

    const handleRefreshEvent = (event: Event) => {
      const detail = (event as CustomEvent).detail as { force?: boolean } | undefined;
      if (matchesFile(detail)) {
        reload({ force: detail?.force === true });
      }
    };

    window.addEventListener("sati:file-updated", handleRefreshEvent);
    window.addEventListener("sati:files-changed", handleRefreshEvent);
    return () => {
      window.removeEventListener("sati:file-updated", handleRefreshEvent);
      window.removeEventListener("sati:files-changed", handleRefreshEvent);
    };
  }, [filePath, projectName, reload]);
}
