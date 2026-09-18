import {
  useCallback,
  useEffect,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
  type TouchEvent,
} from "react";
import { authenticatedFetch } from "../../../utils/api";
import { UI_TIMEOUTS } from "../../../constants/timeouts";
import { logError } from "../../../utils/logging";
import {
  CONTENT_REFERENCE_ATTACHMENT_KIND,
  contentReferenceImage,
  formatContentReferencePromptBlock,
  type ContentReference,
} from "../../../types/contentReference";
import { getEffectiveThinkingMode } from "../constants/thinkingModeAvailability";
import { thinkingModeToConfig, type ThinkingModeId } from "../constants/thinkingModes";
import {
  createTemporarySessionId,
  getNotificationSessionSummary,
  isTemporarySessionId,
  startSessionCommand,
} from "../utils/sessionLauncher";
import { safeLocalStorage } from "../utils/chatStorage";
import type { ChatAttachment, ChatImage, ChatMessage } from "../types/types";
import type { SlashCommand } from "./useSlashCommands";
import { createFakeSubmitEvent, type ComposerSubmitHandler } from "./composerSubmit";
import type { QueuedBusySendSnapshot, UseChatComposerStateArgs } from "./useChatComposerState";

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

type UploadedAttachmentFile = {
  name: string;
  path: string;
  size?: number;
  mimeType?: string;
};

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
    async (event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>) => {
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
    },
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

function buildAttachmentPathNote(files: UploadedAttachmentFile[]): string {
  if (!files.length) {
    return "";
  }

  const lines = files.map(file => `- ${file.name}: ${file.path}`);
  return `\n\n[Files attached by user and available for reading in the project:]\n${lines.join("\n")}`;
}

/**
 * 读取工具授权设置（`sati-settings`）；损坏时告警并回退全保守默认值。
 * 注意 fallback 有意不含 `projectSortOrder`（存量行为，消费方按缺省容错），
 * 故不标注 `SatiSettings` 返回类型。
 */
function readToolsSettings() {
  try {
    const savedSettings = safeLocalStorage.getItem("sati-settings");
    if (savedSettings) {
      return JSON.parse(savedSettings);
    }
  } catch (error) {
    logError("Error loading tools settings:", error);
  }

  return {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false,
  };
}

function contentReferenceToAttachment(reference: ContentReference): ChatAttachment {
  return {
    kind: CONTENT_REFERENCE_ATTACHMENT_KIND,
    name: reference.source.fileName,
    path: reference.source.relativePath,
    fileName: reference.source.fileName,
    filePath: reference.source.relativePath,
    contentReference:
      reference.selectionMode === "region"
        ? {
            ...reference,
            image: { ...reference.image, dataUrl: undefined },
          }
        : reference,
    createdAt: reference.createdAt,
    mimeType: "application/vnd.sati.content-reference+json",
  };
}
