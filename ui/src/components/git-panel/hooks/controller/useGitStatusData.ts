import { useCallback, useEffect, useRef } from "react";
import type { Project } from "../../../../types/app";
import { logError } from "../../../../utils/logging";
import { DEFAULT_BRANCH } from "../../constants/constants";
import type { GitDiffResponse, GitStatusResponse } from "../../types/types";
import { getAllChangedFiles } from "../../utils/gitPanelUtils";
import { fetchWithAuth, isAbortError, readJson } from "./apiClient";
import type { GitPanelState } from "./useGitPanelState";

type UseGitStatusDataParams = {
  selectedProject: Project | null;
  state: GitPanelState;
};

export function useGitStatusData({ selectedProject, state }: UseGitStatusDataParams) {
  const { setGitDiff, setIsLoading, setGitStatus, setCurrentBranch } = state;

  const selectedProjectNameRef = useRef<string | null>(selectedProject?.name ?? null);

  useEffect(() => {
    selectedProjectNameRef.current = selectedProject?.name ?? null;
  }, [selectedProject]);

  const fetchFileDiff = useCallback(
    async (filePath: string, signal?: AbortSignal) => {
      if (!selectedProject) {
        return;
      }

      const projectName = selectedProject.name;

      try {
        const response = await fetchWithAuth(
          `/api/git/diff?project=${encodeURIComponent(projectName)}&file=${encodeURIComponent(filePath)}`,
          { signal },
        );
        const data = await readJson<GitDiffResponse>(response, signal);

        if (signal?.aborted || selectedProjectNameRef.current !== projectName) {
          return;
        }

        if (!data.error && data.diff) {
          setGitDiff(previous => ({
            ...previous,
            [filePath]: data.diff as string,
          }));
        }
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          return;
        }

        logError("Error fetching file diff:", error);
      }
    },
    [selectedProject, setGitDiff],
  );

  const fetchGitStatus = useCallback(
    async (signal?: AbortSignal) => {
      if (!selectedProject) {
        return;
      }

      const projectName = selectedProject.name;

      setIsLoading(true);
      try {
        const response = await fetchWithAuth(`/api/git/status?project=${encodeURIComponent(projectName)}`, { signal });
        const data = await readJson<GitStatusResponse>(response, signal);

        if (signal?.aborted || selectedProjectNameRef.current !== projectName) {
          return;
        }

        if (data.error) {
          logError("Git status error:", data.error);
          setGitStatus({ error: data.error, details: data.details });
          setCurrentBranch("");
          return;
        }

        setGitStatus(data);
        setCurrentBranch(data.branch || DEFAULT_BRANCH);

        const changedFiles = getAllChangedFiles(data);
        changedFiles.forEach(filePath => {
          void fetchFileDiff(filePath, signal);
        });
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          return;
        }

        if (selectedProjectNameRef.current !== projectName) {
          return;
        }

        logError("Error fetching git status:", error);
        setGitStatus({ error: "Git operation failed", details: String(error) });
        setCurrentBranch("");
      } finally {
        setIsLoading(false);
      }
    },
    [fetchFileDiff, selectedProject, setCurrentBranch, setIsLoading, setGitStatus],
  );

  return { fetchFileDiff, fetchGitStatus };
}
