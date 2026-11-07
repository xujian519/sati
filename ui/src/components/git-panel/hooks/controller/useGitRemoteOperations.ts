import { useCallback } from "react";
import type { Project } from "../../../../types/app";
import { logError } from "../../../../utils/logging";
import type { GitApiErrorResponse, GitOperationResponse, GitRemoteStatus } from "../../types/types";
import { fetchWithAuth, readJson } from "./apiClient";
import type { GitPanelState } from "./useGitPanelState";

type UseGitRemoteOperationsParams = {
  selectedProject: Project | null;
  currentBranch: string;
  state: GitPanelState;
  fetchGitStatus: (signal?: AbortSignal) => Promise<void>;
  fetchBranches: () => Promise<void>;
};

export function useGitRemoteOperations({
  selectedProject,
  currentBranch,
  state,
  fetchGitStatus,
  fetchBranches,
}: UseGitRemoteOperationsParams) {
  const { setRemoteStatus, setOperationError, setIsFetching, setIsPulling, setIsPushing, setIsPublishing } = state;

  const fetchRemoteStatus = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    try {
      const response = await fetchWithAuth(
        `/api/git/remote-status?project=${encodeURIComponent(selectedProject.name)}`,
      );
      const data = await readJson<GitRemoteStatus | GitApiErrorResponse>(response);

      if (!data.error) {
        setRemoteStatus(data as GitRemoteStatus);
        return;
      }

      setRemoteStatus(null);
    } catch (error) {
      logError("Error fetching remote status:", error);
      setRemoteStatus(null);
    }
  }, [selectedProject, setRemoteStatus]);

  const handleFetch = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsFetching(true);
    try {
      const response = await fetchWithAuth("/api/git/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: selectedProject.name,
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        void fetchBranches();
        return;
      }

      setOperationError(data.error ?? "Fetch failed");
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Fetch failed");
    } finally {
      setIsFetching(false);
    }
  }, [fetchBranches, fetchGitStatus, fetchRemoteStatus, selectedProject, setOperationError, setIsFetching]);

  const handlePull = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsPulling(true);
    try {
      const response = await fetchWithAuth("/api/git/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: selectedProject.name,
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return;
      }

      setOperationError(data.error ?? "Pull failed");
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Pull failed");
    } finally {
      setIsPulling(false);
    }
  }, [fetchGitStatus, fetchRemoteStatus, selectedProject, setOperationError, setIsPulling]);

  const handlePush = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsPushing(true);
    try {
      const response = await fetchWithAuth("/api/git/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: selectedProject.name,
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return;
      }

      setOperationError(data.error ?? "Push failed");
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Push failed");
    } finally {
      setIsPushing(false);
    }
  }, [fetchGitStatus, fetchRemoteStatus, selectedProject, setOperationError, setIsPushing]);

  const handlePublish = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsPublishing(true);
    try {
      const response = await fetchWithAuth("/api/git/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: selectedProject.name,
          branch: currentBranch,
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return;
      }

      logError("Publish failed:", data.error);
    } catch (error) {
      logError("Error publishing branch:", error);
    } finally {
      setIsPublishing(false);
    }
  }, [currentBranch, fetchGitStatus, fetchRemoteStatus, selectedProject, setIsPublishing]);

  return { fetchRemoteStatus, handleFetch, handlePull, handlePush, handlePublish };
}
