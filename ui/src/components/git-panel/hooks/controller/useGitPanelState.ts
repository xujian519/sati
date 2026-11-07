import { useCallback, useState } from "react";
import type { GitCommitSummary, GitDiffMap, GitRemoteStatus, GitStatusResponse } from "../../types/types";

export function useGitPanelState() {
  const [gitStatus, setGitStatus] = useState<GitStatusResponse | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffMap>({});
  const [isLoading, setIsLoading] = useState(false);
  const [currentBranch, setCurrentBranch] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [recentCommits, setRecentCommits] = useState<GitCommitSummary[]>([]);
  const [commitDiffs, setCommitDiffs] = useState<GitDiffMap>({});
  const [remoteStatus, setRemoteStatus] = useState<GitRemoteStatus | null>(null);
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isCreatingInitialCommit, setIsCreatingInitialCommit] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);

  const clearOperationError = useCallback(() => setOperationError(null), []);

  return {
    gitStatus,
    setGitStatus,
    gitDiff,
    setGitDiff,
    isLoading,
    setIsLoading,
    currentBranch,
    setCurrentBranch,
    branches,
    setBranches,
    recentCommits,
    setRecentCommits,
    commitDiffs,
    setCommitDiffs,
    remoteStatus,
    setRemoteStatus,
    localBranches,
    setLocalBranches,
    remoteBranches,
    setRemoteBranches,
    isCreatingBranch,
    setIsCreatingBranch,
    isFetching,
    setIsFetching,
    isPulling,
    setIsPulling,
    isPushing,
    setIsPushing,
    isPublishing,
    setIsPublishing,
    isCreatingInitialCommit,
    setIsCreatingInitialCommit,
    operationError,
    setOperationError,
    clearOperationError,
  };
}

export type GitPanelState = ReturnType<typeof useGitPanelState>;
