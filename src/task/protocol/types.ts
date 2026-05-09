/**
 * Background task runtime protocol (C5 §6.5 of the deferred-feature guide).
 * Mirrors `third-party/claude-code-main/src/tasks/LocalShellTask` (T1-T11).
 */

export type PolitDeckBackgroundTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type PolitDeckBackgroundTaskKind = "bash" | "monitor";

/**
 * State envelope for a single background bash task. The shape is a strict
 * superset of legacy `LocalShellTaskState` for the fields PolitDeck actually
 * uses; legacy-only "task" classes (`local_agent`, `remote`) are not part of
 * this PR (D-tier).
 */
export type PolitDeckBackgroundBashTask = {
  taskId: string;
  type: "local_bash";
  /** T4 — owning agent; agent exit triggers `killForAgent(agentId)`. */
  agentId?: string;
  /** T5 — UI badge variant (`bash` plain task vs. long-running `monitor`). */
  kind: PolitDeckBackgroundTaskKind;
  command: string;
  cwd: string;
  /** Set once the child process has been spawned. */
  pid?: number;
  status: PolitDeckBackgroundTaskStatus;
  exitCode?: number | null;
  /** T6 — flipped to `true` once the runtime has dispatched a completion attachment. */
  completionStatusSentInAttachment: boolean;
  /** T7 — bookkeeping for incremental output reporters. */
  lastReportedTotalLines: number;
  /** T8 — flips foreground → background when bash mode flips at runtime. */
  isBackgrounded: boolean;
  /** Set when the task was killed via `task_stop` / SIGTERM. */
  interrupted: boolean;
  startedAt: Date;
  endedAt?: Date;
  /** Total bytes captured across stdout + stderr. */
  outputBytes: number;
};

export type PolitDeckTaskOutputSlice = {
  content: string;
  /** Offset into the combined byte stream from which the next read may resume. */
  nextOffset: number;
  /** Total bytes captured so far. */
  totalBytes: number;
  /** True when older bytes have been dropped beyond the buffer limit. */
  truncated: boolean;
};

export type PolitDeckBackgroundTaskListFilter = {
  agentId?: string;
  status?: PolitDeckBackgroundTaskStatus | PolitDeckBackgroundTaskStatus[];
  kind?: PolitDeckBackgroundTaskKind;
};
