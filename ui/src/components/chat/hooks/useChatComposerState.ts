import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, FormEvent, KeyboardEvent, MouseEvent, SetStateAction, TouchEvent } from "react";
import { useDropzone } from "react-dropzone";
import { isThinkingModeId, type ThinkingModeId } from "../constants/thinkingModes";
import { type ThinkingModeAvailability } from "../constants/thinkingModeAvailability";
import { getDraftInputStorageKey, safeLocalStorage } from "../utils/chatStorage";
import { isTemporarySessionId } from "../utils/sessionLauncher";
import { normalizeContentReference, type ContentReference } from "../../../types/contentReference";
import type { ChatMessage, PendingApproval, PendingPermissionRequest, PermissionMode } from "../types/types";
import type { Project, ProjectSession } from "../../../types/app";
import type { WsMessage } from "../../../contexts/WebSocketContext";
import { MAX_ATTACHMENT_SIZE_BYTES, useAttachmentUpload } from "./useAttachmentUpload";
import { useComposerInput } from "./useComposerInput";
import { useComposerDraft } from "./useComposerDraft";
import { useSessionSubmit } from "./useSessionSubmit";
import { useSessionPermissions } from "./useSessionPermissions";
import { useFileMentions } from "./useFileMentions";
import { useSlashCommands } from "./useSlashCommands";
import { useSlashCommandExecute } from "./useSlashCommandExecute";

/** 草稿落盘防抖窗口（ms）：击键停止 500ms 后才写 localStorage。 */

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

interface MentionableFile {
  name: string;
  path: string;
}

export type QueuedBusySendSnapshot = {
  input: string;
  attachedImages: File[];
  documentReferences: ContentReference[];
  forceStart?: boolean;
};

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

export function useChatComposerState({
  selectedProject,
  selectedSession,
  currentSessionId,
  model,
  permissionMode,
  basePermissionMode,
  runMode,
  cycleRunMode,
  isLoading,
  canAbortSession,
  tokenBudget,
  thinkingModeAvailability,
  sendMessage,
  subscribe,
  sendByCtrlEnter,
  onSessionActive,
  onSessionProcessing,
  onSessionActivityBump,
  onInputFocusChange,
  onFileOpen,
  onShowSettings,
  pendingViewSessionRef,
  scrollToBottom,
  addMessage,
  clearMessages,
  rewindMessages,
  setIsLoading,
  setCanAbortSession,
  setIsAborting,
  setClaudeStatus,
  setSatiStatus,
  setIsUserScrolledUp,
  pendingPermissionRequests,
  setPendingPermissionRequests,
  setPendingApprovals,
  referenceOnlyPrompt = "Please answer based on the document selection I quoted.",
}: UseChatComposerStateArgs) {
  const draftStorageKey = selectedProject ? getDraftInputStorageKey(selectedProject.name, selectedSession?.id) : null;
  const [input, setInput] = useState(() => {
    if (typeof window !== "undefined" && draftStorageKey) {
      return safeLocalStorage.getItem(draftStorageKey) || "";
    }
    return "";
  });
  // 附件层要通知的"忙碌队列快照"同步器定义在附件状态**之后**（它要读附件状态），
  // 故用 ref 后绑定；转发函数身份稳定，`handleImageFiles` 的依赖因此不再每次附件变化而变。
  const syncQueuedBusySendSnapshotRef = useRef<((updates?: Partial<QueuedBusySendSnapshot>) => void) | null>(null);
  const forwardBusySendSnapshot = useCallback(
    (updates: { attachedImages?: File[]; documentReferences?: ContentReference[] }) => {
      syncQueuedBusySendSnapshotRef.current?.(updates);
    },
    [],
  );

  const {
    attachedImages,
    setAttachedImages,
    documentReferences,
    setDocumentReferences,
    uploadingImages,
    setUploadingImages,
    imageErrors,
    setImageErrors,
    resetAttachmentState,
    handleImageFiles,
    handlePaste,
  } = useAttachmentUpload({ syncQueuedBusySendSnapshot: forwardBusySendSnapshot });
  // 展开态留在父级：两条 autosize effect 在输入层 hook 调用**之前**，其依赖数组会在渲染期求值。
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [isBusySendQueued, setIsBusySendQueued] = useState(false);
  const [isBusySendConfirmed, setIsBusySendConfirmed] = useState(false);
  const [thinkingMode, setThinkingModeState] = useState<ThinkingModeId>("default");

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const pendingNewSessionThinkingModeRef = useRef<ThinkingModeId | null>(null);
  const handleSubmitRef = useRef<
    | ((
        event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      ) => Promise<void>)
    | null
  >(null);
  const inputValueRef = useRef(input);
  const activeDraftStorageKeyRef = useRef(draftStorageKey);
  const queuedBusySendRef = useRef(false);
  const queuedBusySendConfirmedRef = useRef(false);
  const queuedBusySendSnapshotRef = useRef<QueuedBusySendSnapshot | null>(null);
  // 协议 1.7：编辑最后一条 user 消息模式——armed 后下一次 submit 改发
  // edit-last-turn 帧（服务端遮蔽旧 turn 后重发新文本），一次性消费。
  const editLastTurnTargetRef = useRef<{ sessionId: string } | null>(null);

  const cancelBusySendQueue = useCallback(() => {
    queuedBusySendRef.current = false;
    queuedBusySendConfirmedRef.current = false;
    queuedBusySendSnapshotRef.current = null;
    setIsBusySendQueued(false);
    setIsBusySendConfirmed(false);
  }, []);

  // input state 与 inputValueRef 必须成对同步——所有直接写输入框的路径统一走此入口。
  const applyInputValue = useCallback((value: string) => {
    setInput(value);
    inputValueRef.current = value;
  }, []);

  // 附件/引用状态清理四件套（提交、slash 命令、清空输入共用）。
  // 从四个候选来源解析首个「真实」（非临时）会话 id；无则返回 null。
  const resolveConcreteSessionId = useCallback((): string | null => {
    const pendingSessionId = typeof window !== "undefined" ? sessionStorage.getItem("pendingSessionId") : null;
    const candidateSessionIds = [
      currentSessionId,
      pendingViewSessionRef.current?.sessionId || null,
      pendingSessionId,
      selectedSession?.id || null,
    ];
    return candidateSessionIds.find(sessionId => Boolean(sessionId) && !isTemporarySessionId(sessionId)) ?? null;
  }, [currentSessionId, pendingViewSessionRef, selectedSession?.id]);

  useEffect(() => {
    editLastTurnTargetRef.current = null;
  }, [currentSessionId, selectedSession?.id]);

  const syncQueuedBusySendSnapshot = useCallback(
    (updates: Partial<QueuedBusySendSnapshot> = {}) => {
      if (!queuedBusySendRef.current) return;
      const previous = queuedBusySendSnapshotRef.current;
      queuedBusySendSnapshotRef.current = {
        input: updates.input ?? previous?.input ?? inputValueRef.current,
        attachedImages: updates.attachedImages ?? previous?.attachedImages ?? attachedImages,
        documentReferences: updates.documentReferences ?? previous?.documentReferences ?? documentReferences,
        ...(previous?.forceStart ? { forceStart: true } : {}),
        ...(updates.forceStart ? { forceStart: true } : {}),
      };
    },
    [attachedImages, documentReferences],
  );

  // 附件层通过上面的 ref 后绑定到这里（见 useAttachmentUpload 的文件头说明）。
  useEffect(() => {
    syncQueuedBusySendSnapshotRef.current = syncQueuedBusySendSnapshot;
  }, [syncQueuedBusySendSnapshot]);

  useEffect(() => {
    const handleAddDocumentReference = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const reference = normalizeContentReference(detail);
      if (!reference) return;
      setDocumentReferences(previous => {
        if (previous.some(item => item.id === reference.id)) return previous;
        const next = [...previous, reference];
        syncQueuedBusySendSnapshot({ documentReferences: next });
        return next;
      });
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    };

    window.addEventListener("sati:add-chat-reference", handleAddDocumentReference);
    return () => {
      window.removeEventListener("sati:add-chat-reference", handleAddDocumentReference);
    };
    // `setDocumentReferences` 来自附件层 hook（`useState` setter，身份稳定）；列入只为满足 exhaustive-deps。
  }, [setDocumentReferences, syncQueuedBusySendSnapshot]);

  const {
    handleAbortSession,
    handleGrantToolPermission,
    handleGrantSessionToolPermission,
    handlePermissionDecision,
    handleApprovalDecision,
  } = useSessionPermissions({
    currentSessionId,
    selectedSession,
    canAbortSession,
    sendMessage,
    subscribe,
    pendingViewSessionRef,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    setPendingApprovals,
    setCanAbortSession,
    setIsAborting,
    setClaudeStatus,
    setSatiStatus,
    cancelBusySendQueue,
  });

  const activeThinkingSessionId = selectedSession?.id || currentSessionId || null;
  const setThinkingMode = useCallback(
    (nextMode: ThinkingModeId | string) => {
      const normalizedMode = isThinkingModeId(nextMode) ? nextMode : "default";
      setThinkingModeState(normalizedMode);
      if (activeThinkingSessionId && !isTemporarySessionId(activeThinkingSessionId)) {
        safeLocalStorage.setItem(`thinkingMode-${activeThinkingSessionId}`, normalizedMode);
      }
    },
    [activeThinkingSessionId],
  );

  useEffect(() => {
    if (!activeThinkingSessionId || isTemporarySessionId(activeThinkingSessionId)) {
      setThinkingModeState("default");
      return;
    }
    const stored = safeLocalStorage.getItem(`thinkingMode-${activeThinkingSessionId}`);
    if (isThinkingModeId(stored)) {
      setThinkingModeState(stored);
      return;
    }
    if (pendingNewSessionThinkingModeRef.current) {
      const pendingMode = pendingNewSessionThinkingModeRef.current;
      pendingNewSessionThinkingModeRef.current = null;
      safeLocalStorage.setItem(`thinkingMode-${activeThinkingSessionId}`, pendingMode);
      setThinkingModeState(pendingMode);
      return;
    }
    setThinkingModeState("default");
  }, [activeThinkingSessionId]);

  const { executeCommand, skipSlashDetectionOnceRef } = useSlashCommandExecute({
    selectedProject,
    currentSessionId,
    model,
    tokenBudget,
    input,
    addMessage,
    clearMessages,
    rewindMessages,
    onFileOpen,
    onShowSettings,
    applyInputValue,
    handleSubmitRef,
  });

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    dismissCommandMenu,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    input,
    setInput,
    textareaRef,
    inputValueRef,
  });

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    mentionScopeKey: draftStorageKey,
    input,
    setInput,
    textareaRef,
  });

  const { handleSubmit, steerBusySendQueue, canSteerBusySend, beginEditLastTurn, regenerateLastTurn } =
    useSessionSubmit({
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
      commandMenu: { slashCommands, resetCommandMenuState },
      setIsTextareaExpanded,
      input,
      inputValueRef,
      attachedImages,
      documentReferences,
      resetAttachmentState,
      applyInputValue,
      resolveConcreteSessionId,
      cancelBusySendQueue,
      editLastTurnTargetRef,
      textareaRef,
      queuedBusySendRef,
      queuedBusySendConfirmedRef,
      queuedBusySendSnapshotRef,
      isBusySendQueued,
      setIsBusySendQueued,
      setIsBusySendConfirmed,
      handleSubmitRef,
    });

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    maxSize: MAX_ATTACHMENT_SIZE_BYTES,
    multiple: true,
    onDrop: handleImageFiles,
    noClick: true,
    noKeyboard: true,
  });

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  useComposerDraft({
    draftStorageKey,
    activeDraftStorageKeyRef,
    input,
    inputValueRef,
    setInput,
    setAttachedImages,
    setDocumentReferences,
    setUploadingImages,
    setImageErrors,
  });

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    // Re-run when input changes so restored drafts get the same autosize behavior as typed text.
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    const lineHeight = parseInt(window.getComputedStyle(textareaRef.current).lineHeight);
    const expanded = textareaRef.current.scrollHeight > lineHeight * 2;
    setIsTextareaExpanded(expanded);
  }, [input]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = "auto";
    setIsTextareaExpanded(false);
  }, [input]);

  const {
    isInputFocused,
    handleInputFocusChange,
    syncInputOverlayScroll,
    handleInputChange,
    insertAtCursor,
    handleKeyDown,
    handleTextareaClick,
    handleTextareaInput,
    handleClearInput,
  } = useComposerInput({
    input,
    inputValueRef,
    textareaRef,
    inputHighlightRef,
    setIsTextareaExpanded,
    applyInputValue,
    syncQueuedBusySendSnapshot,
    cancelBusySendQueue,
    setDocumentReferences,
    onInputFocusChange,
    cycleRunMode,
    handleSubmit,
    sendByCtrlEnter,
    commandMenu: { showCommandMenu, resetCommandMenuState, handleCommandInputChange, handleCommandMenuKeyDown },
    fileMentions: { showFileDropdown, setCursorPosition, handleFileMentionsKeyDown },
  });

  return {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    thinkingMode,
    setThinkingMode,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    dismissCommandMenu,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles: filteredFiles as MentionableFile[],
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    setAttachedImages: (value: SetStateAction<File[]>) => {
      setAttachedImages(previous => {
        const next = typeof value === "function" ? (value as (previous: File[]) => File[])(previous) : value;
        syncQueuedBusySendSnapshot({ attachedImages: next });
        return next;
      });
    },
    documentReferences,
    removeDocumentReference: (id: string) => {
      setDocumentReferences(previous => {
        const next = previous.filter(reference => reference.id !== id);
        syncQueuedBusySendSnapshot({ documentReferences: next });
        return next;
      });
    },
    uploadingImages,
    imageErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker: open,
    handleSubmit,
    handleInputChange,
    insertAtCursor,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleGrantSessionToolPermission,
    handleApprovalDecision,
    handleInputFocusChange,
    isInputFocused,
    isBusySendQueued,
    isBusySendConfirmed,
    cancelBusySendQueue,
    steerBusySendQueue,
    canSteerBusySend,
    beginEditLastTurn,
    regenerateLastTurn,
  };
}
