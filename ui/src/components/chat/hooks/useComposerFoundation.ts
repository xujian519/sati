import { useCallback, useEffect, useRef, useState } from "react";
import type { ThinkingModeId } from "../constants/thinkingModes";
import { getDraftInputStorageKey, safeLocalStorage } from "../utils/chatStorage";
import { isTemporarySessionId } from "../utils/sessionLauncher";
import type { ContentReference } from "../../../types/contentReference";
import { useAttachmentUpload } from "./useAttachmentUpload";
import type { ComposerSubmitHandler } from "./composerSubmit";
import { mergeQueuedBusySendSnapshot, type QueuedBusySendSnapshot } from "./composerBusySnapshot";
import { attachAddChatReferenceListener } from "./composerDocumentReferences";
import {
  normalizeThinkingMode,
  persistThinkingModeForSession,
  resolveThinkingModeForSession,
} from "./composerThinkingMode";
import { useSessionPermissions } from "./useSessionPermissions";
import type { UseChatComposerStateArgs } from "./useChatComposerState";

/**
 * composer 的基础层：草稿键、输入 state、附件、忙碌队列、引用监听、会话权限与思维模式。
 *
 * 从 `useChatComposerState.ts` 搬出（#646 B2.5），**hook/effect 的相对顺序逐字保留**：
 * 本层在父 hook 的原位置调用，内部调用序与搬迁前 131–307 行完全一致。
 * 纯逻辑（快照合并 / 思维模式持久化 / 引用监听）另见同目录小模块。
 */

export function useComposerFoundation({
  selectedProject,
  selectedSession,
  currentSessionId,
  canAbortSession,
  sendMessage,
  subscribe,
  pendingViewSessionRef,
  setCanAbortSession,
  setIsAborting,
  setClaudeStatus,
  setSatiStatus,
  pendingPermissionRequests,
  setPendingPermissionRequests,
  setPendingApprovals,
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
  const handleSubmitRef = useRef<ComposerSubmitHandler | null>(null);
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
      queuedBusySendSnapshotRef.current = mergeQueuedBusySendSnapshot(queuedBusySendSnapshotRef.current, updates, {
        input: inputValueRef.current,
        attachedImages,
        documentReferences,
      });
    },
    [attachedImages, documentReferences],
  );

  // 附件层通过上面的 ref 后绑定到这里（见 useAttachmentUpload 的文件头说明）。
  useEffect(() => {
    syncQueuedBusySendSnapshotRef.current = syncQueuedBusySendSnapshot;
  }, [syncQueuedBusySendSnapshot]);

  useEffect(
    () =>
      attachAddChatReferenceListener({
        setDocumentReferences,
        syncQueuedBusySendSnapshot,
        textareaRef,
      }),
    // `setDocumentReferences` 来自附件层 hook（`useState` setter，身份稳定）；`textareaRef` 是稳定 ref。
    [setDocumentReferences, syncQueuedBusySendSnapshot],
  );

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
      const normalizedMode = normalizeThinkingMode(nextMode);
      setThinkingModeState(normalizedMode);
      persistThinkingModeForSession(activeThinkingSessionId, normalizedMode);
    },
    [activeThinkingSessionId],
  );

  useEffect(() => {
    setThinkingModeState(resolveThinkingModeForSession(activeThinkingSessionId, pendingNewSessionThinkingModeRef));
  }, [activeThinkingSessionId]);

  return {
    draftStorageKey,
    input,
    setInput,
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
    isTextareaExpanded,
    setIsTextareaExpanded,
    isBusySendQueued,
    setIsBusySendQueued,
    isBusySendConfirmed,
    setIsBusySendConfirmed,
    thinkingMode,
    setThinkingMode,
    textareaRef,
    inputHighlightRef,
    pendingNewSessionThinkingModeRef,
    handleSubmitRef,
    inputValueRef,
    activeDraftStorageKeyRef,
    queuedBusySendRef,
    queuedBusySendConfirmedRef,
    queuedBusySendSnapshotRef,
    editLastTurnTargetRef,
    cancelBusySendQueue,
    applyInputValue,
    resolveConcreteSessionId,
    syncQueuedBusySendSnapshot,
    handleAbortSession,
    handleGrantToolPermission,
    handleGrantSessionToolPermission,
    handlePermissionDecision,
    handleApprovalDecision,
  };
}
