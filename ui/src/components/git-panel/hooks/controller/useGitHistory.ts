import { useCallback } from "react";
import type { Project } from "../../../../types/app";
import { authenticatedFetch } from "../../../../utils/api";
import { logError } from "../../../../utils/logging";
import { RECENT_COMMITS_LIMIT } from "../../constants/constants";
import type {
  GitCommitsResponse,
  GitDiffResponse,
  GitGenerateMessageResponse,
  GitOperationResponse,
} from "../../types/types";
import { fetchWithAuth, readJson } from "./apiClient";
import type { GitPanelState } from "./useGitPanelState";

type UseGitHistoryParams = {
  selectedProject: Project | null;
  provider: string;
  state: GitPanelState;
  fetchGitStatus: (signal?: AbortSignal) => Promise<void>;
  fetchRemoteStatus: () => Promise<void>;
};

export function useGitHistory({
  selectedProject,
  provider,
  state,
  fetchGitStatus,
  fetchRemoteStatus,
}: UseGitHistoryParams) {
  const { setRecentCommits, setCommitDiffs, setIsCreatingInitialCommit } = state;

  const fetchRecentCommits = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    try {
      const response = await fetchWithAuth(
        `/api/git/commits?project=${encodeURIComponent(selectedProject.name)}&limit=${RECENT_COMMITS_LIMIT}`,
      );
      const data = await readJson<GitCommitsResponse>(response);

      if (!data.error && data.commits) {
        setRecentCommits(data.commits);
      }
    } catch (error) {
      logError("Error fetching commits:", error);
    }
  }, [selectedProject, setRecentCommits]);

  const fetchCommitDiff = useCallback(
    async (commitHash: string) => {
      if (!selectedProject) {
        return;
      }

      try {
        const response = await fetchWithAuth(
          `/api/git/commit-diff?project=${encodeURIComponent(selectedProject.name)}&commit=${commitHash}`,
        );
        const data = await readJson<GitDiffResponse>(response);

        if (!data.error && data.diff) {
          setCommitDiffs(previous => ({
            ...previous,
            [commitHash]: data.diff as string,
          }));
        }
      } catch (error) {
        logError("Error fetching commit diff:", error);
      }
    },
    [selectedProject, setCommitDiffs],
  );

  const generateCommitMessage = useCallback(
    async (files: string[]) => {
      if (!selectedProject || files.length === 0) {
        return null;
      }

      try {
        const response = await authenticatedFetch("/api/git/generate-commit-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: selectedProject.name,
            files,
            provider,
          }),
        });

        const data = await readJson<GitGenerateMessageResponse>(response);
        if (data.message) {
          return data.message;
        }

        logError("Failed to generate commit message:", data.error);
        return null;
      } catch (error) {
        logError("Error generating commit message:", error);
        return null;
      }
    },
    [provider, selectedProject],
  );

  const commitChanges = useCallback(
    async (message: string, files: string[]) => {
      if (!selectedProject || !message.trim() || files.length === 0) {
        return false;
      }

      try {
        const response = await fetchWithAuth("/api/git/commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: selectedProject.name,
            message,
            files,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (data.success) {
          void fetchGitStatus();
          void fetchRemoteStatus();
          return true;
        }

        logError("Commit failed:", data.error);
        return false;
      } catch (error) {
        logError("Error committing changes:", error);
        return false;
      }
    },
    [fetchGitStatus, fetchRemoteStatus, selectedProject],
  );

  const createInitialCommit = useCallback(async () => {
    if (!selectedProject) {
      throw new Error("No project selected");
    }

    setIsCreatingInitialCommit(true);
    try {
      const response = await fetchWithAuth("/api/git/initial-commit", {
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
        return true;
      }

      throw new Error(data.error || "Failed to create initial commit");
    } catch (error) {
      logError("Error creating initial commit:", error);
      throw error;
    } finally {
      setIsCreatingInitialCommit(false);
    }
  }, [fetchGitStatus, fetchRemoteStatus, selectedProject, setIsCreatingInitialCommit]);

  return { fetchRecentCommits, fetchCommitDiff, generateCommitMessage, commitChanges, createInitialCommit };
}
