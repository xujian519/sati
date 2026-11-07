import { useCallback } from "react";
import type { Project } from "../../../../types/app";
import { logError } from "../../../../utils/logging";
import type { FileOpenHandler, GitFileWithDiffResponse, GitOperationResponse } from "../../types/types";
import { fetchWithAuth, readJson } from "./apiClient";

type UseGitFileActionsParams = {
  selectedProject: Project | null;
  onFileOpen?: FileOpenHandler;
  fetchGitStatus: (signal?: AbortSignal) => Promise<void>;
};

export function useGitFileActions({ selectedProject, onFileOpen, fetchGitStatus }: UseGitFileActionsParams) {
  const discardChanges = useCallback(
    async (filePath: string) => {
      if (!selectedProject) {
        return;
      }

      try {
        const response = await fetchWithAuth("/api/git/discard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: selectedProject.name,
            file: filePath,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (data.success) {
          void fetchGitStatus();
          return;
        }

        logError("Discard failed:", data.error);
      } catch (error) {
        logError("Error discarding changes:", error);
      }
    },
    [fetchGitStatus, selectedProject],
  );

  const deleteUntrackedFile = useCallback(
    async (filePath: string) => {
      if (!selectedProject) {
        return;
      }

      try {
        const response = await fetchWithAuth("/api/git/delete-untracked", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: selectedProject.name,
            file: filePath,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (data.success) {
          void fetchGitStatus();
          return;
        }

        logError("Delete failed:", data.error);
      } catch (error) {
        logError("Error deleting untracked file:", error);
      }
    },
    [fetchGitStatus, selectedProject],
  );

  const openFile = useCallback(
    async (filePath: string) => {
      if (!onFileOpen) {
        return;
      }

      if (!selectedProject) {
        onFileOpen(filePath);
        return;
      }

      try {
        const response = await fetchWithAuth(
          `/api/git/file-with-diff?project=${encodeURIComponent(selectedProject.name)}&file=${encodeURIComponent(filePath)}`,
        );
        const data = await readJson<GitFileWithDiffResponse>(response);

        if (data.error) {
          logError("Error fetching file with diff:", data.error);
          onFileOpen(filePath);
          return;
        }

        onFileOpen(filePath, {
          old_string: data.oldContent || "",
          new_string: data.currentContent || "",
        });
      } catch (error) {
        logError("Error opening file:", error);
        onFileOpen(filePath);
      }
    },
    [onFileOpen, selectedProject],
  );

  return { discardChanges, deleteUntrackedFile, openFile };
}
