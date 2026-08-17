// dream-review 的类型与常量（从 dream-review.ts 拆出，G1 聚类，逐字搬移）。
import type { HeartbeatStats } from "../pipeline/heartbeat.js";
import type { DreamTraceRecord } from "../types.js";

export type LoggerLike = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export interface DreamReviewRunnerOptions {
  logger?: LoggerLike;
}

export interface DreamRewriteOutcome {
  reviewedFiles: number;
  rewrittenProjects: number;
  deletedProjects: number;
  deletedFiles: number;
  profileUpdated: boolean;
  duplicateTopicCount: number;
  conflictTopicCount: number;
  summary: string;
}

export interface DreamRunResult extends DreamRewriteOutcome {
  prepFlush: HeartbeatStats;
  trigger?: "manual" | "scheduled";
  status?: "success" | "skipped";
  skipReason?: string;
}

export interface DreamExecutionResult extends DreamRewriteOutcome {
  finishedAt: string;
  isNoOp: boolean;
  trace: DreamTraceRecord;
}

export const DREAM_HEADER_SCAN_LIMIT = 200;
export const DREAM_CLUSTER_MAX_FILES = 8;
export const DREAM_META_PROJECT_CONTEXT_LIMIT = 5;
export const DREAM_META_FEEDBACK_CONTEXT_LIMIT = 5;
export const DREAM_USER_NOTE_MAX_FILES = 200;
export const DREAM_USER_NOTE_CHAR_BUDGET = 120_000;

export type CategoryDreamResult = {
  plannedClusters: number;
  refinedClusters: number;
  deletedFiles: number;
  droppedWarnings: string[];
};

export type GeneralProjectMergeResult = {
  mergedProjects: number;
  deletedProjects: number;
  relinkedFiles: number;
  planSummary: string;
  droppedWarnings: string[];
  groups: Array<{
    keeperProjectId: string;
    keeperProjectName: string;
    mergedProjectIds: string[];
    reason: string;
    relinkedFiles: string[];
  }>;
};
