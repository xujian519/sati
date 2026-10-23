import { useCallback, useEffect, type RefObject } from "react";
import { UI_TIMEOUTS } from "../../../constants/timeouts";
import { type ContentReference } from "../../../types/contentReference";
import { getEffectiveThinkingMode } from "../constants/thinkingModeAvailability";
import { thinkingModeToConfig, type ThinkingModeId } from "../constants/thinkingModes";
import type { SlashCommand } from "./useSlashCommands";
import { createFakeSubmitEvent, type ComposerSubmitHandler, type MinimalSubmitEvent } from "./composerSubmit";
import type { QueuedBusySendSnapshot, UseChatComposerStateArgs } from "./useChatComposerState";
import { submitSession } from "./sessionSubmitHandler";
import { readToolsSettings } from "./sessionSubmitUtils";

/**
 * 提交生命周期：`handleSubmit` 本体、`handleSubmitRef` 的回填、空闲时补发排队的提交、
 * 中途插话（steer）与它的可用性判定，外加"编辑最后一条消息 / 重新生成最后一轮"这两个
 * 同样由提交入口消费的动作。
 *
 * 从 `useChatComposerState.ts` 搬出（#159 N01 缝 4b），**被搬代码逐字未改**
 * （逐 token 比对见 `/tmp/n01e-move-proof.mjs`）。
 *
 * **调用点**：`handleSubmit` 的斜杠拦截分支要用斜杠命令层的 `executeCommand` /
 * `skipSlashDetectionOnceRef` / `resetCommandMenuState`，故本层必须排在斜杠层之后；它同时
 * 提供输入层需要的 `handleSubmit`，故排在输入层之前。两个随层搬走的 effect（回填 ref、
 * 空闲 flush）因此比原先更靠前：它们彼此的**相对顺序**（先回填、后 flush）保持不变，
 * 那正是"空闲补发能拿到最新 handleSubmit"的前提；唯一变化的相邻关系是它们现在排在父级
 * `inputValueRef` 同步 effect 之前——而 flush 路径读的是排队快照里的 input，不读那个 ref。
 *
 * **排队状态留在父级**（`queuedBusySend*` refs 与 `isBusySendQueued*`）：
 * `cancelBusySendQueue` 被更早的权限层与更晚的输入层共同使用，而本层必须等在斜杠层之后，
 * 把状态搬进来就会再把环绕回去。故按"状态在父级、逻辑在 hook"的口径接收它们。
 */

type SessionSubmitOptions = Pick<
  UseChatComposerStateArgs,
  | "selectedProject"
  | "selectedSession"
  | "currentSessionId"
  | "isLoading"
  | "canAbortSession"
  | "runMode"
  | "permissionMode"
  | "basePermissionMode"
  | "model"
  | "thinkingModeAvailability"
  | "sendMessage"
  | "addMessage"
  | "setIsLoading"
  | "setCanAbortSession"
  | "setIsAborting"
  | "setClaudeStatus"
  | "setIsUserScrolledUp"
  | "onSessionActive"
  | "onSessionProcessing"
  | "onSessionActivityBump"
  | "pendingViewSessionRef"
  | "referenceOnlyPrompt"
  | "scrollToBottom"
> & {
  /** 父级的默认值由 `useChatComposerState` 提供，故此处为必填。 */
  referenceOnlyPrompt: string;
  /** 父级状态与 ref（不属于 props 契约）。 */
  thinkingMode: ThinkingModeId;
  pendingNewSessionThinkingModeRef: RefObject<ThinkingModeId | null>;
  activeDraftStorageKeyRef: RefObject<string | null>;
  /** 斜杠命令层。 */
  executeCommand: (command: SlashCommand, rawInput?: string) => Promise<void>;
  skipSlashDetectionOnceRef: RefObject<boolean>;
  /** 斜杠命令菜单：提交路径在若干分支里复位它，并按名字匹配命令表。 */
  commandMenu: { slashCommands: SlashCommand[]; resetCommandMenuState: () => void };
  /** 输入层：提交路径会收起输入框。 */
  setIsTextareaExpanded: (expanded: boolean) => void;
  input: string;
  inputValueRef: RefObject<string>;
  attachedImages: File[];
  documentReferences: ContentReference[];
  resetAttachmentState: () => void;
  applyInputValue: (value: string) => void;
  resolveConcreteSessionId: () => string | null;
  cancelBusySendQueue: () => void;
  editLastTurnTargetRef: RefObject<{ sessionId: string } | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** 排队状态（父级持有，见文件头）。 */
  queuedBusySendRef: RefObject<boolean>;
  queuedBusySendConfirmedRef: RefObject<boolean>;
  queuedBusySendSnapshotRef: RefObject<QueuedBusySendSnapshot | null>;
  isBusySendQueued: boolean;
  setIsBusySendQueued: (value: boolean) => void;
  setIsBusySendConfirmed: (value: boolean) => void;
  /** 由本层回填；斜杠层的延迟提交与空闲 flush 都经由它拿到最新提交函数。 */
  handleSubmitRef: RefObject<ComposerSubmitHandler | null>;
};

type SessionSubmitApi = {
  handleSubmit: ComposerSubmitHandler;
  steerBusySendQueue: () => void;
  canSteerBusySend: boolean;
  beginEditLastTurn: (sessionId: string, content: string) => void;
  regenerateLastTurn: (sessionId: string, originalText: string) => void;
};

export function useSessionSubmit({
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
}: SessionSubmitOptions): SessionSubmitApi {
  // Mid-turn steering（协议 1.6）：把排队中的纯文本改为插话投递——不中断
  // 当前 turn，引擎在下一次模型调用边界注入。带附件/引用时不提供该动作。
  const steerBusySendQueue = useCallback(() => {
    const snapshot = queuedBusySendSnapshotRef.current;
    const text = snapshot?.input?.trim() ?? "";
    const hasAttachments =
      (snapshot?.attachedImages?.length ?? 0) > 0 || (snapshot?.documentReferences?.length ?? 0) > 0;
    if (!text || hasAttachments) return;
    const targetSessionId = resolveConcreteSessionId();
    if (!targetSessionId) return;
    sendMessage({
      type: "steer-session",
      sessionId: targetSessionId,
      text,
    });
    cancelBusySendQueue();
    applyInputValue("");
    resetAttachmentState();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    // 下列 ref 现在是本 hook 的入参（不再是局部 useRef），exhaustive-deps 要求列入；身份稳定。
  }, [
    applyInputValue,
    cancelBusySendQueue,
    queuedBusySendSnapshotRef,
    resetAttachmentState,
    resolveConcreteSessionId,
    sendMessage,
    textareaRef,
  ]);

  // 插话仅支持纯文本：排队快照带附件/引用或输入为空时不显示插话按钮。
  const canSteerBusySend =
    isBusySendQueued && input.trim().length > 0 && attachedImages.length === 0 && documentReferences.length === 0;

  // 协议 1.7：进入「编辑最后一条消息」模式——预填 composer，下一次 submit
  // 由 handleSubmit 拦截改发 edit-last-turn 帧。会话切换时丢弃未提交的编辑模式。
  const beginEditLastTurn = useCallback(
    (sessionId: string, content: string) => {
      if (!sessionId) return;
      editLastTurnTargetRef.current = { sessionId };
      applyInputValue(content);
      setIsUserScrolledUp(false);
      setTimeout(() => scrollToBottom(), UI_TIMEOUTS.CHAT_SEND_SCROLL_SETTLE_MS);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    },
    [applyInputValue, editLastTurnTargetRef, scrollToBottom, setIsUserScrolledUp, textareaRef],
  );

  // 协议 1.7：重新生成最后一轮——服务端取最后一条 accepted_input 原文，
  // 遮蔽旧 turn 后续跑新 turn。乐观插入 user 气泡（原文）+ Processing 状态，
  // 与正常提交的即时反馈保持一致。
  const regenerateLastTurn = useCallback(
    (sessionId: string, originalText: string) => {
      if (!selectedProject || isLoading || !sessionId || !originalText.trim()) return;
      const projectPath = selectedProject.fullPath || selectedProject.path || "";
      const toolsSettings = readToolsSettings();
      const effectiveThinkingMode = getEffectiveThinkingMode(thinkingMode, thinkingModeAvailability);
      sendMessage({
        type: "regenerate-last-turn",
        sessionId,
        options: {
          sessionId,
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
      addMessage(
        {
          type: "user",
          content: originalText,
          timestamp: new Date(),
        },
        sessionId,
      );
      setIsLoading(true);
      setCanAbortSession(true);
      setClaudeStatus({ text: "Processing", tokens: 0, can_interrupt: true });
      setIsUserScrolledUp(false);
      setTimeout(() => scrollToBottom(), UI_TIMEOUTS.CHAT_SEND_SCROLL_SETTLE_MS);
      onSessionActive?.(sessionId);
      onSessionProcessing?.(sessionId);
    },
    [
      addMessage,
      basePermissionMode,
      isLoading,
      model,
      onSessionActive,
      onSessionProcessing,
      permissionMode,
      runMode,
      scrollToBottom,
      selectedProject,
      sendMessage,
      setCanAbortSession,
      setClaudeStatus,
      setIsLoading,
      setIsUserScrolledUp,
      thinkingMode,
      thinkingModeAvailability,
    ],
  );

  const handleSubmit = useCallback(
    (event: MinimalSubmitEvent) =>
      submitSession(event, {
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
      }),
    [
      applyInputValue,
      resetAttachmentState,
      resolveConcreteSessionId,
      selectedSession,
      attachedImages,
      documentReferences,
      model,
      currentSessionId,
      executeCommand,
      isLoading,
      isBusySendQueued,
      canAbortSession,
      onSessionActive,
      onSessionActivityBump,
      onSessionProcessing,
      pendingViewSessionRef,
      runMode,
      permissionMode,
      basePermissionMode,
      resetCommandMenuState,
      // `skipSlashDetectionOnceRef` 由斜杠命令层写入、此处读取；ref 身份稳定，列入依赖只为满足 exhaustive-deps。
      skipSlashDetectionOnceRef,
      scrollToBottom,
      selectedProject,
      sendMessage,
      setCanAbortSession,
      setIsAborting,
      addMessage,
      setClaudeStatus,
      setIsLoading,
      setIsUserScrolledUp,
      slashCommands,
      thinkingMode,
      thinkingModeAvailability,
      referenceOnlyPrompt,
      activeDraftStorageKeyRef,
      editLastTurnTargetRef,
      inputValueRef,
      pendingNewSessionThinkingModeRef,
      queuedBusySendConfirmedRef,
      queuedBusySendRef,
      queuedBusySendSnapshotRef,
      setIsBusySendConfirmed,
      setIsBusySendQueued,
      setIsTextareaExpanded,
      textareaRef,
    ],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit, handleSubmitRef]);

  useEffect(() => {
    if (!isLoading) {
      if (queuedBusySendRef.current && handleSubmitRef.current) {
        handleSubmitRef.current(createFakeSubmitEvent());
      } else {
        queuedBusySendRef.current = false;
        queuedBusySendConfirmedRef.current = false;
        queuedBusySendSnapshotRef.current = null;
        setIsBusySendQueued(false);
        setIsBusySendConfirmed(false);
      }
    }
    // 下列 ref/setter 现在是本 hook 的入参；身份稳定，列入只为满足 exhaustive-deps。
  }, [
    handleSubmitRef,
    isLoading,
    queuedBusySendConfirmedRef,
    queuedBusySendRef,
    queuedBusySendSnapshotRef,
    setIsBusySendConfirmed,
    setIsBusySendQueued,
  ]);

  return { handleSubmit, steerBusySendQueue, canSteerBusySend, beginEditLastTurn, regenerateLastTurn };
}
