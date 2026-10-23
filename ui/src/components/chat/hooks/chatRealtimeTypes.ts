import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  ClaudeWorkStatus,
  CompactProgress,
  PendingApproval,
  PendingPermissionRequest,
  SatiWorkStatus,
} from "../types/types";
import type { Project, ProjectSession, SessionProvider } from "../../../types/app";
import type { SessionStore } from "../../../stores/useSessionStore";

export type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

export type LatestChatMessage = {
  type?: string;
  kind?: string;
  data?: unknown;
  message?: unknown;
  delta?: string;
  sessionId?: string;
  session_id?: string;
  requestId?: string;
  toolName?: string;
  input?: unknown;
  context?: unknown;
  origin?: unknown;
  error?: string;
  tool?: unknown;
  toolId?: string;
  result?: unknown;
  exitCode?: number;
  isProcessing?: boolean | null;
  actualSessionId?: string;
  event?: string;
  status?: unknown;
  isNewSession?: boolean;
  activeTurnMessages?: LatestChatMessage[];
  activitySnapshot?: LatestChatMessage[];
  compactProgress?: CompactProgress;
  compact_progress?: CompactProgress;
  resultText?: string;
  isError?: boolean;
  success?: boolean;
  reason?: string;
  provider?: string;
  content?: string;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  newSessionId?: string;
  aborted?: boolean;
  [key: string]: unknown;
};

export type ChatRealtimeMessageHandler = (latestMessage: LatestChatMessage, fallbackSessionId?: string | null) => void;

export type ChatRealtimeFrame = {
  msg: LatestChatMessage;
  sid: string;
  msgRunId?: string;
  streamKey: string;
  isForActiveView: boolean;
};

export interface UseChatRealtimeHandlersArgs {
  provider: SessionProvider;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setCurrentSessionId: (sessionId: string | null) => void;
  setIsLoading: (loading: boolean) => void;
  setCanAbortSession: (canAbort: boolean) => void;
  setIsAborting: (aborting: boolean) => void;
  setClaudeStatus: (status: ClaudeWorkStatus | null) => void;
  setSatiStatus: (status: SatiWorkStatus | null) => void;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  setPendingApprovals: Dispatch<SetStateAction<PendingApproval[]>>;
  pendingViewSessionRef: MutableRefObject<PendingViewSession | null>;
  onSessionInactive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  onReplaceTemporarySession?: (sessionId?: string | null) => void;
  onNavigateToSession?: (sessionId: string) => void;
  onWebSocketReconnect?: () => void;
  // 协议 1.7：edit-last-turn / regenerate-last-turn 失败时 complete 帧携带
  // rewriteError（complete 帧本身不可渲染，由宿主转为 toast/错误提示）。
  onRewriteError?: (reason: string) => void;
  sessionStore: SessionStore;
  sendMessage?: (message: Record<string, unknown>) => void;
}

export type ChatRealtimeHandlerDeps = UseChatRealtimeHandlersArgs & {
  thinkingBySessionRef: MutableRefObject<Map<string, boolean>>;
  activeTurnReplaySignatureRef: MutableRefObject<Map<string, string>>;
  clearSessionStatusRetry: (sessionId: string) => void;
  scheduleSessionStatusRetry: (sessionId: string) => void;
};
