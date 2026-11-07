import { useCallback } from "react";
import type { Project } from "../../../../types/app";
import { logError } from "../../../../utils/logging";
import type { GitBranchesResponse, GitOperationResponse } from "../../types/types";
import { fetchWithAuth, readJson } from "./apiClient";
import type { GitPanelState } from "./useGitPanelState";

type UseGitBranchesParams = {
  selectedProject: Project | null;
  state: GitPanelState;
  fetchGitStatus: (signal?: AbortSignal) => Promise<void>;
};

export function useGitBranches({ selectedProject, state, fetchGitStatus }: UseGitBranchesParams) {
  const { setBranches, setLocalBranches, setRemoteBranches, setCurrentBranch, setIsCreatingBranch, setOperationError } =
    state;

  const fetchBranches = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    try {
      const response = await fetchWithAuth(`/api/git/branches?project=${encodeURIComponent(selectedProject.name)}`);
      const data = await readJson<GitBranchesResponse>(response);

      if (!data.error && data.branches) {
        setBranches(data.branches);
        setLocalBranches(data.localBranches ?? data.branches);
        setRemoteBranches(data.remoteBranches ?? []);
        return;
      }

      setBranches([]);
      setLocalBranches([]);
      setRemoteBranches([]);
    } catch (error) {
      logError("Error fetching branches:", error);
      setBranches([]);
      setLocalBranches([]);
      setRemoteBranches([]);
    }
  }, [selectedProject, setBranches, setLocalBranches, setRemoteBranches]);

  const switchBranch = useCallback(
    async (branchName: string) => {
      if (!selectedProject) {
        return false;
      }

      try {
        const response = await fetchWithAuth("/api/git/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: selectedProject.name,
            branch: branchName,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          logError("Failed to switch branch:", data.error);
          return false;
        }

        setCurrentBranch(branchName);
        void fetchGitStatus();
        return true;
      } catch (error) {
        logError("Error switching branch:", error);
        return false;
      }
    },
    [fetchGitStatus, selectedProject, setCurrentBranch],
  );

  const createBranch = useCallback(
    async (branchName: string) => {
      const trimmedBranchName = branchName.trim();
      if (!selectedProject || !trimmedBranchName) {
        return false;
      }

      setIsCreatingBranch(true);
      try {
        const response = await fetchWithAuth("/api/git/create-branch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project: selectedProject.name,
            branch: trimmedBranchName,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          logError("Failed to create branch:", data.error);
          return false;
        }

        setCurrentBranch(trimmedBranchName);
        void fetchBranches();
        void fetchGitStatus();
        return true;
      } catch (error) {
        logError("Error creating branch:", error);
        return false;
      } finally {
        setIsCreatingBranch(false);
      }
    },
    [fetchBranches, fetchGitStatus, selectedProject, setCurrentBranch, setIsCreatingBranch],
  );

  const deleteBranch = useCallback(
    async (branchName: string) => {
      if (!selectedProject) return false;

      try {
        const response = await fetchWithAuth("/api/git/delete-branch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project: selectedProject.name, branch: branchName }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          setOperationError(data.error ?? "Delete branch failed");
          return false;
        }

        void fetchBranches();
        return true;
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : "Delete branch failed");
        return false;
      }
    },
    [fetchBranches, selectedProject, setOperationError],
  );

  return { fetchBranches, switchBranch, createBranch, deleteBranch };
}
