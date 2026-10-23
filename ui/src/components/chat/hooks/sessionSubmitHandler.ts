import type { RefObject } from "react";
import { authenticatedFetch } from "../../../utils/api";
import { UI_TIMEOUTS } from "../../../constants/timeouts";
import { logError } from "../../../utils/logging";
import {
  contentReferenceImage,
  formatContentReferencePromptBlock,
  type ContentReference,
} from "../../../types/contentReference";
import { getEffectiveThinkingMode, type ThinkingModeAvailability } from "../constants/thinkingModeAvailability";
import { thinkingModeToConfig, type ThinkingModeId } from "../constants/thinkingModes";
import {
  createTemporarySessionId,
  getNotificationSessionSummary,
  isTemporarySessionId,
  startSessionCommand,
} from "../utils/sessionLauncher";
import { safeLocalStorage } from "../utils/chatStorage";
import type { ChatImage, ChatMessage, PermissionMode } from "../types/types";
import type { Project, ProjectSession } from "../../../types/app";
import type { WsMessage } from "../../../contexts/WebSocketContext";
import type { SlashCommand } from "./useSlashCommands";
import type { MinimalSubmitEvent } from "./composerSubmit";
import type { QueuedBusySendSnapshot } from "./useChatComposerState";
import {
  buildAttachmentPathNote,
  contentReferenceToAttachment,
  readToolsSettings,
  type UploadedAttachmentFile,
} from "./sessionSubmitUtils";

/**
 * 提交事务的纯实现：乐观气泡、附件上传、忙碌排队、编辑/重生成与斜杠拦截。
 *
 * 从 `useSessionSubmit` 的 `handleSubmit` 整体搬出（#646 B2.4），搬迁段逐字未改；
 * hook 只保留 ref 回填与空闲补发两个 effect，以及插话/编辑/重生成三个回调。
 * 所有 React 侧状态经 `SessionSubmitContext` 以值/ref 传入，函数体不调用 hook。
 */

export type SessionSubmitContext = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  isLoading: boolean;
  canAbortSession: boolean;
  thinkingMode: ThinkingModeId;
  pendingNewSessionThinkingModeRef: RefObject<ThinkingModeId | null>;
  activeDraftStorageKeyRef: RefObject<string | null>;
  runMode?: string;
  permissionMode: PermissionMode | string;
  basePermissionMode?: PermissionMode | string;
  model: string;
  thinkingModeAvailability: ThinkingModeAvailability;
  sendMessage: (message: WsMessage) => void;
  addMessage: (msg: ChatMessage, targetSessionId?: string | null) => void;
  setIsLoading: (loading: boolean) => void;
  setCanAbortSession: (canAbort: boolean) => void;
  setIsAborting: (aborting: boolean) => void;
  setClaudeStatus: (status: { text: string; tokens: number; can_interrupt: boolean } | null) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  onSessionActive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionActivityBump?: (projectName: string, sessionId: string, optimisticTitle?: string) => void;
  pendingViewSessionRef: RefObject<{ sessionId: string | null; startedAt: number } | null>;
  referenceOnlyPrompt: string;
  scrollToBottom: () => void;
  executeCommand: (command: SlashCommand, rawInput?: string) => Promise<void>;
  skipSlashDetectionOnceRef: RefObject<boolean>;
  slashCommands: SlashCommand[];
  resetCommandMenuState: () => void;
  setIsTextareaExpanded: (expanded: boolean) => void;
  inputValueRef: RefObject<string>;
  attachedImages: File[];
  documentReferences: ContentReference[];
  resetAttachmentState: () => void;
  applyInputValue: (value: string) => void;
  resolveConcreteSessionId: () => string | null;
  editLastTurnTargetRef: RefObject<{ sessionId: string } | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  queuedBusySendRef: RefObject<boolean>;
  queuedBusySendConfirmedRef: RefObject<boolean>;
  queuedBusySendSnapshotRef: RefObject<QueuedBusySendSnapshot | null>;
  isBusySendQueued: boolean;
  setIsBusySendQueued: (value: boolean) => void;
  setIsBusySendConfirmed: (value: boolean) => void;
};

export async function submitSession(
  event: MinimalSubmitEvent,
  {
    selectedProject,
    selectedSession,
    currentSessionId,
    isLoading,
    canAbortSession,
    thinkingMode,
    pendingNewSessionThinkingModeRef,
    activeDraftStorageKeyRef,
    runMode,
    permissionMode,
    basePermissionMode,
    model,
    thinkingModeAvailability,
    sendMessage,
    addMessage,
    setIsLoading,
    setCanAbortSession,
    setIsAborting,
    setClaudeStatus,
    setIsUserScrolledUp,
    onSessionActive,
    onSessionProcessing,
    onSessionActivityBump,
    pendingViewSessionRef,
    referenceOnlyPrompt,
    scrollToBottom,
    executeCommand,
    skipSlashDetectionOnceRef,
    slashCommands,
    resetCommandMenuState,
    setIsTextareaExpanded,
    inputValueRef,
    attachedImages,
    documentReferences,
    resetAttachmentState,
    applyInputValue,
    resolveConcreteSessionId,
    editLastTurnTargetRef,
    textareaRef,
    queuedBusySendRef,
    queuedBusySendConfirmedRef,
    queuedBusySendSnapshotRef,
    isBusySendQueued,
    setIsBusySendQueued,
    setIsBusySendConfirmed,
  }: SessionSubmitContext,
): Promise<void> {
  event.preventDefault();
  const queuedSnapshot = queuedBusySendSnapshotRef.current;
  const currentInput = queuedSnapshot?.input ?? inputValueRef.current;
  const submitAttachedImages = queuedSnapshot?.attachedImages ?? attachedImages;
  const submitDocumentReferences = queuedSnapshot?.documentReferences ?? documentReferences;
  const hasDocumentReferences = submitDocumentReferences.length > 0;
  const hasAttachments = submitAttachedImages.length > 0 || hasDocumentReferences;
  if ((!currentInput.trim() && !hasAttachments) || !selectedProject) {
    return;
  }

  if (isLoading && !isBusySendQueued) {
    queuedBusySendRef.current = true;
    queuedBusySendConfirmedRef.current = false;
    queuedBusySendSnapshotRef.current = {
      input: currentInput,
      attachedImages: [...attachedImages],
      documentReferences: [...documentReferences],
    };
    setIsBusySendQueued(true);
    setIsBusySendConfirmed(false);
    return;
  }

  if (isLoading && isBusySendQueued) {
    queuedBusySendSnapshotRef.current = {
      input: currentInput,
      attachedImages: submitAttachedImages,
      documentReferences: submitDocumentReferences,
    };

    const targetSessionId = resolveConcreteSessionId();

    if (!canAbortSession || !targetSessionId) {
      return;
    }

    queuedBusySendSnapshotRef.current = {
      ...queuedBusySendSnapshotRef.current,
      forceStart: true,
    };
    queuedBusySendConfirmedRef.current = true;
    setIsBusySendConfirmed(true);
    sendMessage({
      type: "abort-session",
      sessionId: targetSessionId,
      provider: "sati",
    });
    setCanAbortSession(false);
    setIsAborting(true);
    return;
  }

  queuedBusySendRef.current = false;
  queuedBusySendConfirmedRef.current = false;
  queuedBusySendSnapshotRef.current = null;
  setIsBusySendQueued(false);
  setIsBusySendConfirmed(false);

  // 协议 1.7：编辑模式拦截——改发 edit-last-turn 帧（服务端遮蔽旧 turn
  // 后同帧续跑新文本），不做 slash 拦截（编辑文本允许以 / 开头按原文发送）。
  const editLastTurnTarget = editLastTurnTargetRef.current;
  if (editLastTurnTarget) {
    const editText = currentInput.trim();
    if (!editText || !selectedProject) {
      editLastTurnTargetRef.current = null;
      return;
    }
    const projectPath = selectedProject.fullPath || selectedProject.path || "";
    const toolsSettings = readToolsSettings();
    const effectiveThinkingMode = getEffectiveThinkingMode(thinkingMode, thinkingModeAvailability);
    sendMessage({
      type: "edit-last-turn",
      sessionId: editLastTurnTarget.sessionId,
      text: editText,
      options: {
        sessionId: editLastTurnTarget.sessionId,
        projectPath,
        cwd: projectPath,
        toolsSettings,
        runMode,
        permissionMode,
        ...(basePermissionMode ? { basePermissionMode } : {}),
        ...(model ? { model } : {}),
        thinking: thinkingModeToConfig(effectiveThinkingMode),
      },
    });
    editLastTurnTargetRef.current = null;
    addMessage(
      {
        type: "user",
        content: editText,
        timestamp: new Date(),
      },
      editLastTurnTarget.sessionId,
    );
    setIsLoading(true);
    setCanAbortSession(true);
    setClaudeStatus({ text: "Processing", tokens: 0, can_interrupt: true });
    setIsUserScrolledUp(false);
    setTimeout(() => scrollToBottom(), UI_TIMEOUTS.CHAT_SEND_SCROLL_SETTLE_MS);
    onSessionActive?.(editLastTurnTarget.sessionId);
    onSessionProcessing?.(editLastTurnTarget.sessionId);
    applyInputValue("");
    resetAttachmentState();
    resetCommandMenuState();
    setIsTextareaExpanded(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    return;
  }

  // Intercept slash commands: if input starts with /commandName, execute as command with args.
  // Skip when handleCustomCommand just pushed a passthrough back into the
  // input box — we already executed it once and want this submit to flow
  // through as a normal user message.
  const trimmedInput = currentInput.trim();
  if (skipSlashDetectionOnceRef.current) {
    skipSlashDetectionOnceRef.current = false;
  } else if (trimmedInput.startsWith("/")) {
    const commandName = trimmedInput.match(/^(\S+)/)?.[1] ?? trimmedInput;
    const matchedCommand = slashCommands.find((cmd: SlashCommand) => cmd.name === commandName);
    if (matchedCommand) {
      executeCommand(matchedCommand, trimmedInput);
      applyInputValue("");
      resetAttachmentState();
      resetCommandMenuState();
      setIsTextareaExpanded(false);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
      return;
    }
  }

  await dispatchSessionMessage({
    currentInput,
    hasDocumentReferences,
    submitAttachedImages,
    submitDocumentReferences,
    queuedSnapshot,
    selectedProject,
    selectedSession,
    currentSessionId,
    thinkingMode,
    pendingNewSessionThinkingModeRef,
    activeDraftStorageKeyRef,
    onSessionActivityBump,
    addMessage,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setIsUserScrolledUp,
    onSessionActive,
    onSessionProcessing,
    pendingViewSessionRef,
    referenceOnlyPrompt,
    scrollToBottom,
    sendMessage,
    runMode,
    permissionMode,
    basePermissionMode,
    model,
    thinkingModeAvailability,
    applyInputValue,
    resetCommandMenuState,
    resetAttachmentState,
    setIsTextareaExpanded,
    textareaRef,
  });
}

/**
 * 提交事务的落地段：乐观气泡、附件上传与会话命令派发。
 *
 * 从 `submitSession` 拆出（#646 B2.4），响应体逐字未改；拆分点位于斜杠拦截之后，
 * 使编排（排队/编辑/拦截）与派发（上传/气泡/startSessionCommand）各自可读。
 */
async function dispatchSessionMessage({
  currentInput,
  hasDocumentReferences,
  submitAttachedImages,
  submitDocumentReferences,
  queuedSnapshot,
  selectedProject,
  selectedSession,
  currentSessionId,
  thinkingMode,
  pendingNewSessionThinkingModeRef,
  activeDraftStorageKeyRef,
  onSessionActivityBump,
  addMessage,
  setIsLoading,
  setCanAbortSession,
  setClaudeStatus,
  setIsUserScrolledUp,
  onSessionActive,
  onSessionProcessing,
  pendingViewSessionRef,
  referenceOnlyPrompt,
  scrollToBottom,
  sendMessage,
  runMode,
  permissionMode,
  basePermissionMode,
  model,
  thinkingModeAvailability,
  applyInputValue,
  resetCommandMenuState,
  resetAttachmentState,
  setIsTextareaExpanded,
  textareaRef,
}: {
  currentInput: string;
  hasDocumentReferences: boolean;
  submitAttachedImages: File[];
  submitDocumentReferences: ContentReference[];
  queuedSnapshot: QueuedBusySendSnapshot | null | undefined;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  thinkingMode: ThinkingModeId;
  pendingNewSessionThinkingModeRef: RefObject<ThinkingModeId | null>;
  activeDraftStorageKeyRef: RefObject<string | null>;
  onSessionActivityBump?: (projectName: string, sessionId: string, optimisticTitle?: string) => void;
  addMessage: (msg: ChatMessage, targetSessionId?: string | null) => void;
  setIsLoading: (loading: boolean) => void;
  setCanAbortSession: (canAbort: boolean) => void;
  setClaudeStatus: (status: { text: string; tokens: number; can_interrupt: boolean } | null) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  onSessionActive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  pendingViewSessionRef: RefObject<{ sessionId: string | null; startedAt: number } | null>;
  referenceOnlyPrompt: string;
  scrollToBottom: () => void;
  sendMessage: (message: WsMessage) => void;
  runMode?: string;
  permissionMode: PermissionMode | string;
  basePermissionMode?: PermissionMode | string;
  model: string;
  thinkingModeAvailability: ThinkingModeAvailability;
  applyInputValue: (value: string) => void;
  resetCommandMenuState: () => void;
  resetAttachmentState: () => void;
  setIsTextareaExpanded: (expanded: boolean) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}): Promise<void> {
  const userVisibleInput =
    currentInput.trim() || (hasDocumentReferences ? referenceOnlyPrompt : "Please review the attached file(s).");
  let messageContent = userVisibleInput;

  // Pin the target session before any await so attachment upload cannot
  // race with a sidebar session switch and leak the optimistic bubble.
  const pendingSessionIdAtSubmit = pendingViewSessionRef.current?.sessionId ?? null;
  const canResumeCurrentSession =
    Boolean(currentSessionId) && (Boolean(selectedSession?.id) || pendingSessionIdAtSubmit === currentSessionId);
  const submitTargetSessionId = selectedSession?.id || (canResumeCurrentSession ? currentSessionId : null);
  const submitSelectedSession = selectedSession;
  if (!submitTargetSessionId || isTemporarySessionId(submitTargetSessionId)) {
    pendingNewSessionThinkingModeRef.current = thinkingMode;
  }

  // Optimistic sidebar refresh — fire BEFORE the attachment upload so
  // the sidebar reorders/spawns the row the instant the user clicks
  // send, not after the network round-trip. We resolve a stable
  // session id here (real id when resuming; otherwise a temporary
  // `new-session-*` placeholder that will be replaced by
  // `preserveLoadedSessions` once the server's `projects_updated`
  // arrives with the real id).
  const optimisticSessionId = submitTargetSessionId || createTemporarySessionId();
  if (selectedProject?.name) {
    onSessionActivityBump?.(selectedProject.name, optimisticSessionId, userVisibleInput);
  }

  let uploadedImages: unknown[] = [];
  let uploadedFiles: UploadedAttachmentFile[] = [];
  if (submitAttachedImages.length > 0) {
    const formData = new FormData();
    submitAttachedImages.forEach(file => {
      formData.append("attachments", file);
    });

    try {
      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(selectedProject.name)}/upload-attachments`,
        {
          method: "POST",
          headers: {},
          body: formData,
        },
      );

      if (!response.ok) {
        throw new Error("Failed to upload attachments");
      }

      const result = await response.json();
      uploadedImages = Array.isArray(result.images) ? result.images : [];
      uploadedFiles = Array.isArray(result.files) ? result.files : [];
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logError("Attachment upload failed:", error);
      addMessage(
        {
          type: "error",
          content: `Failed to upload attachments: ${message}`,
          timestamp: new Date(),
        },
        submitTargetSessionId,
      );
      return;
    }
  }

  const referenceImages = submitDocumentReferences
    .map(contentReferenceImage)
    .filter((image): image is NonNullable<typeof image> => Boolean(image));
  uploadedImages = [...uploadedImages, ...referenceImages];
  const documentReferenceAttachments = submitDocumentReferences.map(contentReferenceToAttachment);
  messageContent = `${messageContent}${buildAttachmentPathNote(uploadedFiles)}${formatContentReferencePromptBlock(submitDocumentReferences)}`;

  const effectiveSessionId = submitTargetSessionId;
  const sessionToActivate = effectiveSessionId || optimisticSessionId;

  const userMessage: ChatMessage = {
    type: "user",
    content: userVisibleInput,
    images: uploadedImages as ChatImage[],
    attachments: [...uploadedFiles, ...documentReferenceAttachments],
    timestamp: new Date(),
  };

  addMessage(userMessage, submitTargetSessionId);
  setIsLoading(true); // Processing banner starts
  setCanAbortSession(true);
  setClaudeStatus({
    text: "Processing",
    tokens: 0,
    can_interrupt: true,
  });

  setIsUserScrolledUp(false);
  setTimeout(() => scrollToBottom(), UI_TIMEOUTS.CHAT_SEND_SCROLL_SETTLE_MS);

  if (!effectiveSessionId && !submitSelectedSession?.id) {
    if (typeof window !== "undefined") {
      // Reset stale pending IDs from previous interrupted runs before creating a new one.
      sessionStorage.removeItem("pendingSessionId");
    }
    pendingViewSessionRef.current = { sessionId: null, startedAt: Date.now() };
  }
  onSessionActive?.(sessionToActivate);
  if (effectiveSessionId && !isTemporarySessionId(effectiveSessionId)) {
    onSessionProcessing?.(effectiveSessionId);
  }

  // Sati-only: a single localStorage entry (`sati-settings`)
  // tracks tool consent + skip-permissions for every chat. The legacy
  // per-provider keys (`cursor-tools-settings`, `codex-settings`,
  // `gemini-settings`) are no longer read or written.
  const toolsSettings = readToolsSettings();
  const sessionSummary = getNotificationSessionSummary(submitSelectedSession, userVisibleInput);
  const effectiveThinkingMode = getEffectiveThinkingMode(thinkingMode, thinkingModeAvailability);

  startSessionCommand({
    sendMessage,
    selectedProject,
    command: messageContent,
    userVisibleInput,
    sessionId: effectiveSessionId,
    temporarySessionId: sessionToActivate,
    toolsSettings,
    runMode,
    permissionMode,
    basePermissionMode,
    model,
    thinking: thinkingModeToConfig(effectiveThinkingMode),
    sessionSummary,
    images: uploadedImages,
    attachments: [...uploadedFiles, ...documentReferenceAttachments],
    forceStart: queuedSnapshot?.forceStart === true,
  });

  applyInputValue("");
  resetCommandMenuState();
  resetAttachmentState();
  setIsTextareaExpanded(false);

  if (textareaRef.current) {
    textareaRef.current.style.height = "auto";
  }

  if (activeDraftStorageKeyRef.current) {
    safeLocalStorage.removeItem(activeDraftStorageKeyRef.current);
  }
}
