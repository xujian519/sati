import type { Dispatch, KeyboardEvent, SetStateAction } from "react";
import { type ThinkingModeAvailability } from "../constants/thinkingModeAvailability";
import type { ChatMessage, PendingApproval, PendingPermissionRequest, PermissionMode } from "../types/types";
import type { Project, ProjectSession } from "../../../types/app";
import type { WsMessage } from "../../../contexts/WebSocketContext";
import { useComposerFoundation } from "./useComposerFoundation";
import { useComposerInteractions } from "./useComposerInteractions";

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

export interface UseChatComposerStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  model: string;
  permissionMode: PermissionMode | string;
  basePermissionMode?: PermissionMode | string;
  runMode?: string;
  cycleRunMode: () => void;
  isLoading: boolean;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  thinkingModeAvailability: ThinkingModeAvailability;
  sendMessage: (message: WsMessage) => void;
  subscribe?: (handler: (message: WsMessage) => void) => () => void;
  sendByCtrlEnter?: boolean;
  onSessionActive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionActivityBump?: (projectName: string, sessionId: string, optimisticTitle?: string) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  pendingViewSessionRef: { current: PendingViewSession | null };
  scrollToBottom: () => void;
  addMessage: (msg: ChatMessage, targetSessionId?: string | null) => void;
  clearMessages: () => void;
  rewindMessages: (count: number) => void;
  setIsLoading: (loading: boolean) => void;
  setCanAbortSession: (canAbort: boolean) => void;
  setIsAborting: (aborting: boolean) => void;
  setClaudeStatus: (status: { text: string; tokens: number; can_interrupt: boolean } | null) => void;
  setSatiStatus: (status: { text: string; tokens: number; can_interrupt: boolean } | null) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  setPendingApprovals: Dispatch<SetStateAction<PendingApproval[]>>;
  referenceOnlyPrompt?: string;
}

export type { QueuedBusySendSnapshot } from "./composerBusySnapshot";

export function shouldCycleRunModeOnKeyDown(
  event: Pick<KeyboardEvent<HTMLTextAreaElement>, "key" | "shiftKey">,
  {
    showFileDropdown,
    showCommandMenu,
  }: {
    showFileDropdown: boolean;
    showCommandMenu: boolean;
  },
): boolean {
  return event.key === "Tab" && event.shiftKey && !showFileDropdown && !showCommandMenu;
}

/**
 * composer 的唯一对外 hook：基础层（state/附件/权限/思维模式）+ 交互层（命令/提及/提交/输入）。
 *
 * #646 B2.5 拆分为两个子 hook，**调用顺序与搬迁前一致**（基础层在前、交互层在后），
 * 故 hook/effect 的相对顺序不变；返回值仍由 `buildComposerResult` 按原键序装配。
 */
export function useChatComposerState(args: UseChatComposerStateArgs) {
  const foundation = useComposerFoundation(args);
  return useComposerInteractions(args, foundation);
}
