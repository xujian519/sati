import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import type { ChangeEvent, ClipboardEvent, FormEvent, KeyboardEvent, MouseEvent, ReactNode, RefObject } from "react";
import { AtSign, Loader2, Paperclip, Square } from "lucide-react";
import type { ChatRunMode, PendingApproval, PendingPermissionRequest, PermissionMode } from "../chat/types/types";
import type { ThinkingModeId } from "../chat/constants/thinkingModes";
import type { ThinkingModeAvailability } from "../chat/constants/thinkingModeAvailability";
import PermissionRequestsBanner from "../chat/view/subcomponents/PermissionRequestsBanner";
import ApprovalRequestsBanner from "../chat/view/subcomponents/ApprovalRequestsBanner";
import ImageAttachment from "../chat/view/subcomponents/ImageAttachment";
import CommandMenu from "../chat/view/subcomponents/CommandMenu";
import { cn } from "../../lib/utils.js";
import type { ContentReference } from "../../types/contentReference";
import DocumentReferenceChip from "./DocumentReferenceChip";
import ComposerBusySendNotice from "./ComposerBusySendNotice";
import ComposerPermissionSelector from "./ComposerPermissionSelector";
import ComposerRunModeSelector from "./ComposerRunModeSelector";
import ComposerSubmitButton from "./ComposerSubmitButton";
import ComposerThinkingSelector from "./ComposerThinkingSelector";
import { ContextStatusPopover } from "./ContextStatusPopover";
import ContextWindowIndicator from "./ContextWindowIndicator";
import { useComposerDerivedState } from "./useComposerDerivedState";

interface MentionableFile {
  name: string;
  path: string;
}

interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ComposerV2Props = {
  input: string;
  placeholder: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  inputHighlightRef: RefObject<HTMLDivElement | null>;
  renderInputWithMentions: (text: string) => ReactNode;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onAbortSession: () => void;
  openImagePicker: () => void;
  attachedImages: File[];
  onRemoveImage: (index: number) => void;
  documentReferences: ContentReference[];
  onRemoveDocumentReference: (id: string) => void;
  onOpenDocumentReference?: (filePath: string) => void;
  uploadingImages: Map<string, number>;
  imageErrors: Map<string, string>;

  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;

  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];

  onToggleCommandMenu: () => void;
  onInsertMention: () => void;
  onInsertSlash: () => void;
  getRootProps: (...args: unknown[]) => Record<string, unknown>;
  getInputProps: (...args: unknown[]) => Record<string, unknown>;
  isDragActive: boolean;

  isLoading: boolean;
  canAbortSession: boolean;
  isAbortPending?: boolean;
  isBusySendQueued?: boolean;
  isBusySendConfirmed?: boolean;
  onCancelBusySendQueue?: () => void;
  canSteerBusySend?: boolean;
  onSteerBusySendQueue?: () => void;
  isSubmitPending?: boolean;
  tokenBudget?: Record<string, unknown> | null;
  thinkingMode: ThinkingModeId;
  thinkingModeAvailability: ThinkingModeAvailability;
  onThinkingModeChange: (mode: ThinkingModeId) => void;

  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: {
      allow?: boolean;
      message?: string;
      rememberEntry?: string | null;
      updatedInput?: unknown;
    },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  pendingApprovals: PendingApproval[];
  handleApprovalDecision: (approval: PendingApproval, verdict: "adopted" | "rejected", feedback?: string) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  runMode: ChatRunMode;
  onRunModeChange: (mode: ChatRunMode) => void;
  planModeAvailable?: boolean;
  onPlanExecutionApproved?: () => void;

  sendByCtrlEnter?: boolean;

  chromeless?: boolean;
};

export default function ComposerV2({
  input,
  placeholder,
  textareaRef,
  inputHighlightRef,
  renderInputWithMentions,
  onInputChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaScrollSync,
  onTextareaInput,
  onInputFocusChange,
  onSubmit,
  onAbortSession,
  openImagePicker,
  attachedImages,
  onRemoveImage,
  documentReferences,
  onRemoveDocumentReference,
  onOpenDocumentReference,
  uploadingImages,
  imageErrors,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  onToggleCommandMenu: _onToggleCommandMenu,
  onInsertMention,
  getRootProps,
  getInputProps,
  isDragActive,
  isLoading,
  canAbortSession,
  isAbortPending = false,
  isBusySendQueued = false,
  isBusySendConfirmed = false,
  onCancelBusySendQueue,
  canSteerBusySend = false,
  onSteerBusySendQueue,
  isSubmitPending = false,
  tokenBudget,
  thinkingMode,
  thinkingModeAvailability,
  onThinkingModeChange,
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  pendingApprovals,
  handleApprovalDecision,
  permissionMode,
  onPermissionModeChange,
  runMode,
  onRunModeChange,
  planModeAvailable = true,
  onPlanExecutionApproved,
  chromeless = false,
}: ComposerV2Props) {
  const { t } = useTranslation("chat");
  const [isContextPopoverOpen, setIsContextPopoverOpen] = useState(false);
  const [isThinkingModeMenuOpen, setIsThinkingModeMenuOpen] = useState(false);
  const [isRunModeMenuOpen, setIsRunModeMenuOpen] = useState(false);
  const [isPermissionMenuOpen, setIsPermissionMenuOpen] = useState(false);
  const permissionSelectorDisabled = runMode === "plan";

  useEffect(() => {
    if (permissionSelectorDisabled) {
      setIsPermissionMenuOpen(false);
    }
  }, [permissionSelectorDisabled]);

  const {
    hasBlockingPermissionPanel,
    attachmentLimitError,
    disabled,
    showAbortButton,
    sendTitle,
    contextStatus,
    effectiveThinkingMode,
    selectedThinkingMode,
    SelectedThinkingIcon,
    SelectedRunModeIcon,
    selectedRunModeLabel,
    SelectedPermissionIcon,
    selectedPermissionLabel,
    contextStatusTitle,
    contextWindowTitle,
  } = useComposerDerivedState({
    input,
    attachedImages,
    documentReferences,
    uploadingImages,
    imageErrors,
    pendingPermissionRequests,
    isSubmitPending,
    isLoading,
    canAbortSession,
    isBusySendConfirmed,
    isBusySendQueued,
    tokenBudget,
    thinkingMode,
    thinkingModeAvailability,
    permissionMode,
    runMode,
    t,
  });

  return (
    <div
      className={cn(
        "min-w-0 shrink-0",
        chromeless
          ? ""
          : "bg-gradient-to-t from-white via-white/95 to-white/0 px-6 pt-3 pb-6 dark:from-neutral-950 dark:via-neutral-950/95 dark:to-transparent",
      )}
    >
      <div className={cn("min-w-0", chromeless ? "" : "mx-auto max-w-[720px]")}>
        {pendingPermissionRequests.length > 0 ? (
          <div className="mb-3">
            <PermissionRequestsBanner
              pendingPermissionRequests={pendingPermissionRequests}
              handlePermissionDecision={handlePermissionDecision}
              handleGrantToolPermission={handleGrantToolPermission}
              onPlanExecutionApproved={onPlanExecutionApproved}
            />
          </div>
        ) : null}

        {pendingApprovals.length > 0 ? (
          <div className="mb-3">
            <ApprovalRequestsBanner
              pendingApprovals={pendingApprovals}
              handleApprovalDecision={handleApprovalDecision}
            />
          </div>
        ) : null}

        {!hasBlockingPermissionPanel ? (
          <form
            onSubmit={onSubmit as (event: FormEvent<HTMLFormElement>) => void}
            className="pd-composer-container relative"
          >
            {attachedImages.length > 0 || documentReferences.length > 0 ? (
              <div className="pd-composer-attachment-panel mb-2 overflow-hidden rounded-xl border border-neutral-200/80 bg-neutral-50/70 p-2 dark:border-neutral-700/60 dark:bg-neutral-800/40">
                <div className="flex flex-wrap gap-2">
                  {documentReferences.map(reference => (
                    <DocumentReferenceChip
                      key={reference.id}
                      reference={reference}
                      className="pd-composer-reference-chip sm:max-w-[520px]"
                      removeLabel={t("documentReferences.remove", { defaultValue: "Remove reference" }) as string}
                      openLabel={
                        t("documentReferences.open", {
                          defaultValue: `Open ${reference.source.fileName}`,
                        }) as string
                      }
                      onOpen={
                        onOpenDocumentReference
                          ? () => onOpenDocumentReference(reference.source.relativePath)
                          : undefined
                      }
                      onRemove={() => onRemoveDocumentReference(reference.id)}
                    />
                  ))}
                  {attachedImages.map((file, index) => (
                    <ImageAttachment
                      key={index}
                      file={file}
                      onRemove={() => onRemoveImage(index)}
                      uploadProgress={uploadingImages.get(file.name)}
                      error={imageErrors.get(file.name)}
                    />
                  ))}
                </div>
                {attachmentLimitError ? (
                  <div className="mt-2 text-xs text-amber-600 dark:text-amber-300">{attachmentLimitError}</div>
                ) : null}
              </div>
            ) : null}

            {showFileDropdown && filteredFiles.length > 0 ? (
              <div className="absolute right-0 bottom-full left-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
                {filteredFiles.map((file, index) => (
                  <div
                    key={file.path}
                    className={cn(
                      "cursor-pointer border-b border-neutral-100 px-3 py-2 text-[13px] last:border-b-0 dark:border-neutral-800",
                      index === selectedFileIndex
                        ? "bg-neutral-100 dark:bg-neutral-800"
                        : "hover:bg-neutral-50 dark:hover:bg-neutral-800/60",
                    )}
                    onMouseDown={event => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={event => {
                      event.preventDefault();
                      event.stopPropagation();
                      onSelectFile(file);
                    }}
                  >
                    <div className="font-medium">{file.name}</div>
                    <div className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">{file.path}</div>
                  </div>
                ))}
              </div>
            ) : null}

            <div
              {...getRootProps()}
              className={cn(
                "group rounded-2xl border bg-white p-2",
                "border-neutral-200/90 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_4px_16px_-4px_rgba(15,23,42,0.08)]",
                "dark:border-neutral-700/60 dark:bg-neutral-900 dark:shadow-[0_1px_2px_rgba(0,0,0,0.3),0_8px_24px_-4px_rgba(0,0,0,0.4)]",
                isDragActive &&
                  "border-dashed border-brand-400 bg-brand-50/30 dark:border-brand-500 dark:bg-brand-900/10",
              )}
            >
              <input {...getInputProps()} />

              <CommandMenu
                commands={filteredCommands}
                selectedIndex={selectedCommandIndex}
                onSelect={onCommandSelect}
                onClose={onCloseCommandMenu}
                isOpen={isCommandMenuOpen}
                frequentCommands={frequentCommands}
                position={(() => {
                  const ta = textareaRef?.current;
                  if (!ta) return { top: 0, left: 0, bottom: 90 };
                  const rect = ta.getBoundingClientRect();
                  return { top: rect.top - 8, left: rect.left, bottom: window.innerHeight - rect.top + 8 };
                })()}
              />

              <div className="relative">
                <div
                  ref={inputHighlightRef}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 overflow-hidden"
                >
                  <div className="block w-full px-2 pt-1.5 text-[14px] leading-6 break-words whitespace-pre-wrap text-transparent">
                    {renderInputWithMentions(input)}
                  </div>
                </div>
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={onInputChange}
                  onClick={onTextareaClick}
                  onKeyDown={onTextareaKeyDown}
                  onPaste={onTextareaPaste}
                  onScroll={event => onTextareaScrollSync(event.target as HTMLTextAreaElement)}
                  onFocus={() => onInputFocusChange?.(true)}
                  onBlur={() => onInputFocusChange?.(false)}
                  onInput={onTextareaInput}
                  placeholder={placeholder}
                  rows={2}
                  className="relative z-10 block max-h-[40vh] min-h-[52px] w-full resize-none bg-transparent px-3 pt-2 text-[14.5px] leading-[22px] text-neutral-900 placeholder-neutral-400 outline-hidden dark:text-neutral-100 dark:placeholder-neutral-500"
                />
              </div>

              <div className="pd-composer-control-row flex flex-wrap items-center gap-x-1 gap-y-1 px-1 pt-1.5 pb-0.5">
                <div className="pd-composer-toolbar-left flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
                  <ComposerRunModeSelector
                    isRunModeMenuOpen={isRunModeMenuOpen}
                    setIsRunModeMenuOpen={setIsRunModeMenuOpen}
                    runMode={runMode}
                    onRunModeChange={onRunModeChange}
                    planModeAvailable={planModeAvailable}
                    selectedRunModeLabel={selectedRunModeLabel}
                    SelectedRunModeIcon={SelectedRunModeIcon}
                    t={t}
                  />
                  <button
                    type="button"
                    onClick={openImagePicker}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                    title={t("input.attachFiles", { defaultValue: "Attach photos or files" }) as string}
                  >
                    <Paperclip className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    onClick={onInsertMention}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                    title={t("input.mentionFile", { defaultValue: "Mention a file" }) as string}
                  >
                    <AtSign className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                  <ComposerPermissionSelector
                    isPermissionMenuOpen={isPermissionMenuOpen}
                    setIsPermissionMenuOpen={setIsPermissionMenuOpen}
                    permissionSelectorDisabled={permissionSelectorDisabled}
                    permissionMode={permissionMode}
                    onPermissionModeChange={onPermissionModeChange}
                    selectedPermissionLabel={selectedPermissionLabel}
                    SelectedPermissionIcon={SelectedPermissionIcon}
                    t={t}
                  />
                </div>

                <ComposerBusySendNotice
                  isBusySendQueued={isBusySendQueued}
                  isBusySendConfirmed={isBusySendConfirmed}
                  canSteerBusySend={canSteerBusySend}
                  onSteerBusySendQueue={onSteerBusySendQueue}
                  onCancelBusySendQueue={onCancelBusySendQueue}
                  t={t}
                />

                <div className="pd-composer-toolbar-right relative ml-auto flex shrink-0 items-center gap-1">
                  <ContextWindowIndicator
                    isContextPopoverOpen={isContextPopoverOpen}
                    setIsContextPopoverOpen={setIsContextPopoverOpen}
                    contextStatus={contextStatus}
                    contextStatusTitle={contextStatusTitle}
                  />
                  {/*
                    气泡挂在整条工具条（`relative`）而非按钮上：按钮 44px 宽时 `right-0`
                    会让 256px 的气泡左溢出被助手面板的 `overflow-hidden` 裁掉（窄面板下
                    文本被切一半）。挂到工具条右缘后气泡落在面板可印区内。
                  */}
                  {isContextPopoverOpen ? (
                    <ContextStatusPopover status={contextStatus} title={contextWindowTitle} t={t} />
                  ) : null}

                  <ComposerThinkingSelector
                    isThinkingModeMenuOpen={isThinkingModeMenuOpen}
                    setIsThinkingModeMenuOpen={setIsThinkingModeMenuOpen}
                    effectiveThinkingMode={effectiveThinkingMode}
                    selectedThinkingMode={selectedThinkingMode}
                    SelectedThinkingIcon={SelectedThinkingIcon}
                    thinkingMode={thinkingMode}
                    thinkingModeAvailability={thinkingModeAvailability}
                    onThinkingModeChange={onThinkingModeChange}
                    t={t}
                  />

                  {showAbortButton ? (
                    <button
                      type="button"
                      onClick={onAbortSession}
                      disabled={isAbortPending}
                      className={cn(
                        "inline-flex h-8 w-8 items-center justify-center rounded-lg text-white transition-all duration-200",
                        "bg-gradient-to-b from-red-500 to-red-600",
                        "shadow-[0_2px_8px_-2px_rgba(239,68,68,0.4),inset_0_1px_0_rgba(255,255,255,0.15)]",
                        "hover:from-red-600 hover:to-red-700",
                        isAbortPending && "cursor-wait opacity-70 hover:from-red-500 hover:to-red-600",
                      )}
                      title={
                        isAbortPending
                          ? (t("input.stopping", { defaultValue: "Stopping..." }) as string)
                          : (t("input.stop", { defaultValue: "Stop" }) as string)
                      }
                    >
                      {isAbortPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.25} />
                      ) : (
                        <Square className="h-3.5 w-3.5" strokeWidth={2.5} fill="currentColor" />
                      )}
                    </button>
                  ) : null}
                  <ComposerSubmitButton
                    disabled={disabled}
                    isSubmitPending={isSubmitPending}
                    hasUploadingImages={uploadingImages.size > 0}
                    isBusySendConfirmed={isBusySendConfirmed}
                    isBusySendQueued={isBusySendQueued}
                    sendTitle={sendTitle}
                  />
                </div>
              </div>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}
