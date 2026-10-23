import { useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { MAX_ATTACHMENT_SIZE_BYTES } from "./useAttachmentUpload";
import { buildComposerResult } from "./composerResult";
import { useComposerAutosize } from "./useComposerAutosize";
import { useComposerDraft } from "./useComposerDraft";
import { useComposerInput } from "./useComposerInput";
import { useFileMentions } from "./useFileMentions";
import { useSessionSubmit } from "./useSessionSubmit";
import { useSlashCommandExecute } from "./useSlashCommandExecute";
import { useSlashCommands } from "./useSlashCommands";
import type { useComposerFoundation } from "./useComposerFoundation";
import type { UseChatComposerStateArgs } from "./useChatComposerState";

/**
 * composer 的交互层：斜杠命令、文件提及、提交、拖放、草稿、autosize 与输入键位。
 *
 * 从 `useChatComposerState.ts` 搬出（#646 B2.5），**hook/effect 的相对顺序逐字保留**：
 * 本层紧接基础层调用，内部顺序与搬迁前 309–486 行一致；返回值由 `buildComposerResult`
 * 按原键序装配。
 */

export function useComposerInteractions(
  args: UseChatComposerStateArgs,
  foundation: ReturnType<typeof useComposerFoundation>,
) {
  const {
    draftStorageKey,
    input,
    setInput,
    attachedImages,
    setAttachedImages,
    documentReferences,
    setDocumentReferences,
    setUploadingImages,
    setImageErrors,
    resetAttachmentState,
    handleImageFiles,
    handlePaste,
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
  } = foundation;

  const {
    selectedProject,
    selectedSession,
    currentSessionId,
    model,
    sendMessage,
    onSessionActive,
    onSessionProcessing,
    onSessionActivityBump,
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
    setIsUserScrolledUp,
    referenceOnlyPrompt = "Please answer based on the document selection I quoted.",
  } = args;

  const { executeCommand, skipSlashDetectionOnceRef } = useSlashCommandExecute({
    selectedProject,
    currentSessionId,
    model,
    tokenBudget: args.tokenBudget,
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
      isLoading: args.isLoading,
      canAbortSession: args.canAbortSession,
      thinkingMode,
      pendingNewSessionThinkingModeRef,
      activeDraftStorageKeyRef,
      runMode: args.runMode,
      permissionMode: args.permissionMode,
      basePermissionMode: args.basePermissionMode,
      model,
      thinkingModeAvailability: args.thinkingModeAvailability,
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
  }, [input, inputValueRef]);

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

  useComposerAutosize({ textareaRef, input, setIsTextareaExpanded });

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
    onInputFocusChange: args.onInputFocusChange,
    cycleRunMode: args.cycleRunMode,
    handleSubmit,
    sendByCtrlEnter: args.sendByCtrlEnter,
    commandMenu: { showCommandMenu, resetCommandMenuState, handleCommandInputChange, handleCommandMenuKeyDown },
    fileMentions: { showFileDropdown, setCursorPosition, handleFileMentionsKeyDown },
  });

  return buildComposerResult({
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded: foundation.isTextareaExpanded,
    thinkingMode,
    setThinkingMode,
    attachments: {
      attachedImages,
      setAttachedImages,
      documentReferences,
      setDocumentReferences,
      uploadingImages: foundation.uploadingImages,
      imageErrors: foundation.imageErrors,
      handlePaste,
      syncQueuedBusySendSnapshot,
      dropzone: { getRootProps, getInputProps, isDragActive, open },
    },
    commands: {
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
    },
    mentions: {
      showFileDropdown,
      filteredFiles,
      selectedFileIndex,
      renderInputWithMentions,
      selectFile,
    },
    inputHandlers: {
      handleSubmit,
      handleInputChange,
      insertAtCursor,
      handleKeyDown,
      handleTextareaClick,
      handleTextareaInput,
      syncInputOverlayScroll,
      handleClearInput,
      isInputFocused,
      handleInputFocusChange,
    },
    permissions: {
      handleAbortSession,
      handlePermissionDecision,
      handleGrantToolPermission,
      handleGrantSessionToolPermission,
      handleApprovalDecision,
    },
    busySend: {
      isBusySendQueued,
      isBusySendConfirmed,
      cancelBusySendQueue,
      steerBusySendQueue,
      canSteerBusySend,
      beginEditLastTurn,
      regenerateLastTurn,
    },
  });
}
