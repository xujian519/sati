import { useCallback, useEffect } from "react";
import type { GitPanelController, UseGitPanelControllerOptions } from "../types/types";
import { useGitBranches } from "./controller/useGitBranches";
import { useGitFileActions } from "./controller/useGitFileActions";
import { useGitHistory } from "./controller/useGitHistory";
import { useGitPanelState } from "./controller/useGitPanelState";
import { useGitRemoteOperations } from "./controller/useGitRemoteOperations";
import { useGitStatusData } from "./controller/useGitStatusData";
import { useSelectedProvider } from "./useSelectedProvider";

export function useGitPanelController({
  selectedProject,
  activeView,
  onFileOpen,
}: UseGitPanelControllerOptions): GitPanelController {
  const state = useGitPanelState();
  const {
    gitStatus,
    gitDiff,
    isLoading,
    currentBranch,
    branches,
    localBranches,
    remoteBranches,
    recentCommits,
    commitDiffs,
    remoteStatus,
    isCreatingBranch,
    isFetching,
    isPulling,
    isPushing,
    isPublishing,
    isCreatingInitialCommit,
    operationError,
    clearOperationError,
    setCurrentBranch,
    setBranches,
    setLocalBranches,
    setRemoteBranches,
    setGitStatus,
    setRemoteStatus,
    setGitDiff,
    setRecentCommits,
    setCommitDiffs,
    setIsLoading,
    setOperationError,
  } = state;

  const provider = useSelectedProvider();

  const { fetchGitStatus } = useGitStatusData({ selectedProject, state });
  const { fetchBranches, switchBranch, createBranch, deleteBranch } = useGitBranches({
    selectedProject,
    state,
    fetchGitStatus,
  });
  const { fetchRemoteStatus, handleFetch, handlePull, handlePush, handlePublish } = useGitRemoteOperations({
    selectedProject,
    currentBranch,
    state,
    fetchGitStatus,
    fetchBranches,
  });
  const { fetchRecentCommits, fetchCommitDiff, generateCommitMessage, commitChanges, createInitialCommit } =
    useGitHistory({ selectedProject, provider, state, fetchGitStatus, fetchRemoteStatus });
  const { discardChanges, deleteUntrackedFile, openFile } = useGitFileActions({
    selectedProject,
    onFileOpen,
    fetchGitStatus,
  });

  const refreshAll = useCallback(() => {
    void fetchGitStatus();
    void fetchBranches();
    void fetchRemoteStatus();
  }, [fetchBranches, fetchGitStatus, fetchRemoteStatus]);

  useEffect(() => {
    const controller = new AbortController();

    // Reset repository-scoped state when project changes to avoid stale UI.
    setCurrentBranch("");
    setBranches([]);
    setLocalBranches([]);
    setRemoteBranches([]);
    setGitStatus(null);
    setRemoteStatus(null);
    setGitDiff({});
    setRecentCommits([]);
    setCommitDiffs({});
    setIsLoading(false);
    setOperationError(null);

    if (!selectedProject) {
      return () => {
        controller.abort();
      };
    }

    void fetchGitStatus(controller.signal);
    void fetchBranches();
    void fetchRemoteStatus();

    return () => {
      controller.abort();
    };
  }, [
    fetchBranches,
    fetchGitStatus,
    fetchRemoteStatus,
    selectedProject,
    setBranches,
    setCommitDiffs,
    setCurrentBranch,
    setGitDiff,
    setGitStatus,
    setIsLoading,
    setLocalBranches,
    setOperationError,
    setRecentCommits,
    setRemoteBranches,
    setRemoteStatus,
  ]);

  useEffect(() => {
    if (!selectedProject || activeView !== "history") {
      return;
    }
    void fetchRecentCommits();
  }, [activeView, fetchRecentCommits, selectedProject]);

  return {
    gitStatus,
    gitDiff,
    isLoading,
    currentBranch,
    branches,
    localBranches,
    remoteBranches,
    recentCommits,
    commitDiffs,
    remoteStatus,
    isCreatingBranch,
    isFetching,
    isPulling,
    isPushing,
    isPublishing,
    isCreatingInitialCommit,
    operationError,
    clearOperationError,
    refreshAll,
    switchBranch,
    createBranch,
    deleteBranch,
    handleFetch,
    handlePull,
    handlePush,
    handlePublish,
    discardChanges,
    deleteUntrackedFile,
    fetchCommitDiff,
    generateCommitMessage,
    commitChanges,
    createInitialCommit,
    openFile,
  };
}
