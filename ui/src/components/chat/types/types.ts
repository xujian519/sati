import type { Project, ProjectSession, SessionProvider } from "../../../types/app";
import type { ContentReference } from "../../../types/contentReference";
import type { WsMessage } from "../../../contexts/WebSocketContext";

export type Provider = SessionProvider;

export type PermissionMode = "default" | "bypassPermissions" | "plan";
export type ChatRunMode = "agent" | "plan" | "ask";

export interface ChatImage {
  data: string;
  name: string;
  path?: string;
  mimeType?: string;
  size?: number;
}

export interface ChatAttachment {
  kind?: "file" | "document-selection" | "content-reference";
  name: string;
  path?: string;
  size?: number;
  mimeType?: string;
  fileName?: string;
  filePath?: string;
  source?: "pdf" | "office-pdf";
  pageNumbers?: number[];
  selectedText?: string;
  surroundingText?: string;
  occurrenceIndex?: number | null;
  createdAt?: string;
  truncated?: boolean;
  contentReference?: ContentReference;
}

export interface ChatFileArtifact {
  id: string;
  name: string;
  path: string;
  operation: "created" | "updated";
  source: "tool" | "workspace_diff";
  status: "complete" | "incomplete";
  size: number;
  sha256: string;
  mimeType?: string;
  createdAt: string;
}

export interface ToolResult {
  content?: unknown;
  isError?: boolean;
  /**
   * `SatiToolErrorCode` from the backend (e.g. `permission_denied`,
   * `permission_required`, `tool_execution_failed`, `file_not_found`).
   * Optional because legacy / replayed messages may not carry it. Used by
   * `getSatiPermissionSuggestion` to gate the "Add to Allowed Tools"
   * affordance so it only fires for genuine permission failures.
   */
  errorCode?: string;
  timestamp?: string | number | Date;
  toolUseResult?: unknown;
  /**
   * Inline images returned by the tool (e.g. `read_file` on a PNG/JPG, PDF
   * page renders). Each entry's `data` is a ready-to-render data URL. These
   * render alongside the tool row instead of in a stray user-side bubble.
   */
  images?: ChatImage[];
  [key: string]: unknown;
}

export interface SubagentChildTool {
  toolId: string;
  toolName: string;
  toolInput: unknown;
  toolResult?: ToolResult | null;
  timestamp: Date;
}

export interface ChatMessage {
  id?: string;
  entryId?: string;
  type: string;
  content?: string;
  timestamp: string | number | Date;
  images?: ChatImage[];
  attachments?: ChatAttachment[];
  artifacts?: ChatFileArtifact[];
  reasoning?: string;
  isThinking?: boolean;
  isStreaming?: boolean;
  isInteractivePrompt?: boolean;
  isToolUse?: boolean;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: ToolResult | null;
  toolId?: string;
  toolCallId?: string;
  taskStatus?: string;
  taskId?: string;
  outputFile?: string;
  taskResult?: string;
  isSubagentContainer?: boolean;
  subagentId?: string;
  isTaskNotification?: boolean;
  isInterruptedNotice?: boolean;
  isAgentActivity?: boolean;
  isAgentActivitySummary?: boolean;
  isCompactBoundary?: boolean;
  activityId?: string;
  runId?: string;
  /** Stable identity shared by live and persisted representations of a compaction pass. */
  compactionId?: string;
  compactTrigger?: string;
  preTokens?: number;
  postTokens?: number;
  messagesSummarized?: number;
  compactLevel?: number;
  compactStage?: string;
  compactStageLabel?: string;
  title?: string;
  detail?: string;
  phase?: string;
  state?: string;
  severity?: string;
  startedAt?: string;
  endedAt?: string | null;
  durationMs?: number | null;
  toolCallCount?: number;
  toolErrorCount?: number;
  ragSearchCount?: number;
  editedFileCount?: number;
  exploredFileCount?: number;
  commandCount?: number;
  subagentCount?: number;
  compactCount?: number;
  thinkingCount?: number;
  otherToolCount?: number;
  keySteps?: unknown[];
  subagentState?: {
    childTools: SubagentChildTool[];
    currentToolIndex: number;
    isComplete: boolean;
    isFailed?: boolean;
  };
  [key: string]: unknown;
}

export interface CompactProgress {
  level: number;
  stage: string;
  label: string;
  state: "started" | "running" | "failed" | "completed";
  pre_tokens?: number;
  reason?: string;
  /** Correlates the in-flight progress with the terminal compact_boundary message. */
  compaction_id?: string;
}

export interface ClaudeWorkStatus {
  text: string;
  tokens: number;
  can_interrupt: boolean;
  compactProgress?: CompactProgress | null;
}

export interface RetryProgress {
  attempt: number;
  maxAttempts: number;
  delayMs?: number;
  reason?: string;
  provider?: string;
  model?: string;
}

export interface SatiWorkStatus {
  text: string;
  tokens: number;
  can_interrupt: boolean;
  compactProgress?: CompactProgress | null;
  retryProgress?: RetryProgress | null;
}

export interface SatiSettings {
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
  projectSortOrder: string;
  lastUpdated?: string;
  [key: string]: unknown;
}

export interface SatiPermissionSuggestion {
  toolName: string;
  entry: string;
  isAllowed: boolean;
}

export interface PermissionGrantResult {
  success: boolean;
  alreadyAllowed?: boolean;
  updatedSettings?: SatiSettings;
  completion?: Promise<PermissionGrantResult>;
}

export type SessionPermissionGrantResult = PermissionGrantResult & {
  pending?: boolean;
};

export interface PendingPermissionRequest {
  requestId: string;
  toolName: string;
  input?: unknown;
  context?: unknown;
  sessionId?: string | null;
  receivedAt?: Date;
  /**
   * True when this request originated from a gateway elicitation channel
   * (e.g. `ask_user_question`) rather than the permission bus. The decision
   * needs to round-trip through `elicitation-response` instead of the
   */
  isElicitation?: boolean;
}

/**
 * 输出门禁 HITL 挂起审批（patent 域）：命中审批词的专利结论等待人工审批。
 * 消息本体已入库（不丢消息），通过/拒绝仅为流程控制 + 审计留痕。
 */
export interface PendingApproval {
  /** PatentOutputGate 挂起索引（会话内唯一）。 */
  pendingIndex: number;
  /** 消息文本预览（展示用）。 */
  textPreview: string;
  /** 触发审批的关键词。 */
  triggerKeyword: string;
  /** 挂起所属的 UI 会话 id（frame.sessionId，用于跨会话隔离与切换清理）。 */
  uiSessionId?: string;
  /** Agent 内部 sessionId（定位/审计用）。 */
  sessionId?: string;
  turnId?: string;
  createdAt?: number;
  receivedAt?: Date;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface ChatInterfaceProps {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: WsMessage) => void;
  subscribe?: (handler: (message: WsMessage) => void) => () => void;
  latestMessage: WsMessage | null;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onSessionActive?: (sessionId?: string | null) => void;
  onSessionInactive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  // Optimistic sidebar refresh fired the instant the user submits a
  // message — lets the sidebar reorder / show a placeholder row without
  // waiting on the server's debounced `projects_updated` round-trip.
  onSessionActivityBump?: (projectName: string, sessionId: string, optimisticTitle?: string) => void;
  processingSessions?: Set<string>;
  onReplaceTemporarySession?: (sessionId?: string | null) => void;
  onNavigateToSession?: (targetSessionId: string) => void;
  onShowSettings?: () => void;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  inlineThinking?: boolean;
  autoScrollToBottom?: boolean;
  sendByCtrlEnter?: boolean;
  externalMessageUpdate?: number;
  onTaskClick?: (...args: unknown[]) => void;
  onShowAllTasks?: (() => void) | null;
  // V2 only: when true, ignore session/messages and render the welcome layout:
  // centered headline + big composer in the middle of the pane.
  forceWelcome?: boolean;
  // Fired the moment the user submits their first message from welcome
  // mode so the parent can leave any legacy welcome-only state.
  onExitWelcome?: () => void;
  // Files workbench: render a quieter, narrow-panel empty state and keep the
  // composer docked to the bottom instead of using the large welcome hero.
  compact?: boolean;
}
