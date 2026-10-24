import type React from "react";
import type { Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { ChatInterfaceProps, ChatRunMode } from "../chat/types/types";
import type { useChatComposerState } from "../chat/hooks/useChatComposerState";
import type { useChatSessionState } from "../chat/hooks/useChatSessionState";
import type { useChatProviderControls } from "./chatInterfaceProviderControls";
import ComposerV2 from "./ComposerV2";

type Composer = ReturnType<typeof useChatComposerState>;
type ChatSession = ReturnType<typeof useChatSessionState>;
type Provider = ReturnType<typeof useChatProviderControls>;
type Translate = TFunction<"chat", undefined>;

export type ChatComposerSlotProps = {
  sessionIsReadOnly: boolean;
  t: Translate;
  isWelcomeMode: boolean;
  compact: boolean;
  onFileOpen: ChatInterfaceProps["onFileOpen"];
  sendByCtrlEnter: ChatInterfaceProps["sendByCtrlEnter"];
  wrappedSubmit: Composer["handleSubmit"];
  handleAbortWithPending: () => void;
  isAbortPending: boolean;
  handlePlanExecutionApproved: () => void;
  runMode: ChatRunMode;
  setRunMode: Dispatch<SetStateAction<ChatRunMode>>;
  composer: Composer;
  session: ChatSession;
  provider: Provider;
};

/**
 * composer 区（#646 B2.6）：只读提示 / ComposerV2 接线 / 外层 slot 容器。
 * 搬迁前是 ChatInterfaceV2 内联的 `composer` + `composerSlot` 两段 JSX，
 * DOM 结构与 class 保持不变；welcome 与常态共用同一实例。
 * 入参按状态来源分组（composer/session/provider），组件内解构后引用名与搬迁前一致。
 */
export default function ChatComposerSlot({
  sessionIsReadOnly,
  t,
  isWelcomeMode,
  compact,
  onFileOpen,
  sendByCtrlEnter,
  wrappedSubmit,
  handleAbortWithPending,
  isAbortPending,
  handlePlanExecutionApproved,
  runMode,
  setRunMode,
  composer,
  session,
  provider,
}: ChatComposerSlotProps) {
  const {
    input,
    textareaRef,
    inputHighlightRef,
    renderInputWithMentions,
    handleInputChange,
    handleTextareaClick,
    handleKeyDown,
    handlePaste,
    syncInputOverlayScroll,
    handleTextareaInput,
    handleInputFocusChange,
    openImagePicker,
    attachedImages,
    setAttachedImages,
    documentReferences,
    removeDocumentReference,
    uploadingImages,
    imageErrors,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    selectFile,
    filteredCommands,
    selectedCommandIndex,
    handleCommandSelect,
    dismissCommandMenu,
    showCommandMenu,
    commandQuery,
    frequentCommands,
    handleToggleCommandMenu,
    insertAtCursor,
    getRootProps,
    getInputProps,
    isDragActive,
    isBusySendQueued,
    isBusySendConfirmed,
    cancelBusySendQueue,
    canSteerBusySend,
    steerBusySendQueue,
    thinkingMode,
    setThinkingMode,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleApprovalDecision,
  } = composer;
  const { tokenBudget, isLoading, canAbortSession } = session;
  const {
    permissionMode,
    thinkingModeAvailability,
    pendingPermissionRequests,
    pendingApprovals,
    selectPermissionMode,
  } = provider;

  return (
    <div data-chat-composer-slot className="min-h-0 shrink-0">
      {sessionIsReadOnly ? (
        <div className="mx-auto w-full max-w-[720px] px-6 pt-3 pb-6">
          <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-[13px] text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
            {t("session.readonlyTranscript", {
              defaultValue: "This transcript is read-only.",
            })}
          </div>
        </div>
      ) : (
        <ComposerV2
          input={input}
          placeholder={
            t("composer.placeholder", {
              defaultValue: "Tell Sati what you want to get done…",
            }) as string
          }
          textareaRef={textareaRef}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          onInputFocusChange={handleInputFocusChange}
          onSubmit={wrappedSubmit}
          onAbortSession={handleAbortWithPending}
          openImagePicker={openImagePicker}
          attachedImages={attachedImages}
          onRemoveImage={index =>
            setAttachedImages(previous => previous.filter((_, currentIndex) => currentIndex !== index))
          }
          documentReferences={documentReferences}
          onRemoveDocumentReference={removeDocumentReference}
          onOpenDocumentReference={onFileOpen ? filePath => onFileOpen(filePath) : undefined}
          uploadingImages={uploadingImages}
          imageErrors={imageErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={dismissCommandMenu}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          onToggleCommandMenu={handleToggleCommandMenu}
          onInsertMention={() => insertAtCursor("@")}
          onInsertSlash={() => insertAtCursor("/")}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          isDragActive={isDragActive}
          isLoading={isLoading}
          canAbortSession={canAbortSession}
          isAbortPending={isAbortPending}
          isBusySendQueued={isBusySendQueued}
          isBusySendConfirmed={isBusySendConfirmed}
          onCancelBusySendQueue={cancelBusySendQueue}
          canSteerBusySend={canSteerBusySend}
          onSteerBusySendQueue={steerBusySendQueue}
          tokenBudget={tokenBudget}
          thinkingMode={thinkingMode}
          thinkingModeAvailability={thinkingModeAvailability}
          onThinkingModeChange={setThinkingMode}
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          pendingApprovals={pendingApprovals}
          handleApprovalDecision={handleApprovalDecision}
          permissionMode={permissionMode}
          onPermissionModeChange={selectPermissionMode}
          runMode={runMode}
          onRunModeChange={setRunMode}
          planModeAvailable={true}
          onPlanExecutionApproved={handlePlanExecutionApproved}
          sendByCtrlEnter={sendByCtrlEnter}
          chromeless={isWelcomeMode && !compact}
        />
      )}
    </div>
  );
}
