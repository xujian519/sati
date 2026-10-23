import type { ClipboardEvent, Dispatch, RefObject, SetStateAction } from "react";
import type { useDropzone } from "react-dropzone";
import type { ThinkingModeId } from "../constants/thinkingModes";
import type { ContentReference } from "../../../types/contentReference";
import type { QueuedBusySendSnapshot } from "./composerBusySnapshot";
import type { useComposerInput } from "./useComposerInput";
import type { useFileMentions } from "./useFileMentions";
import type { useSessionPermissions } from "./useSessionPermissions";
import type { useSessionSubmit } from "./useSessionSubmit";
import type { useSlashCommands } from "./useSlashCommands";

/**
 * composer 对外返回值的装配层：只负责把各 hook 的产出按原键序组装成同一个对象。
 *
 * 从 `useChatComposerState.ts` 搬出（#646 B2.5），**键序与取值逐字未改**；
 * 目的仅是让主 hook 聚焦于编排，返回值形状不变。
 */

interface MentionableFile {
  name: string;
  path: string;
}

type ComposerResultArgs = {
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  inputHighlightRef: RefObject<HTMLDivElement | null>;
  isTextareaExpanded: boolean;
  thinkingMode: ThinkingModeId;
  setThinkingMode: (mode: ThinkingModeId | string) => void;
  attachments: {
    attachedImages: File[];
    setAttachedImages: Dispatch<SetStateAction<File[]>>;
    documentReferences: ContentReference[];
    setDocumentReferences: Dispatch<SetStateAction<ContentReference[]>>;
    uploadingImages: Map<string, number>;
    imageErrors: Map<string, string>;
    handlePaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
    syncQueuedBusySendSnapshot: (updates?: Partial<QueuedBusySendSnapshot>) => void;
    dropzone: Pick<ReturnType<typeof useDropzone>, "getRootProps" | "getInputProps" | "isDragActive" | "open">;
  };
  commands: Pick<
    ReturnType<typeof useSlashCommands>,
    | "slashCommandsCount"
    | "filteredCommands"
    | "frequentCommands"
    | "commandQuery"
    | "showCommandMenu"
    | "selectedCommandIndex"
    | "resetCommandMenuState"
    | "dismissCommandMenu"
    | "handleCommandSelect"
    | "handleToggleCommandMenu"
  >;
  mentions: Pick<
    ReturnType<typeof useFileMentions>,
    "showFileDropdown" | "filteredFiles" | "selectedFileIndex" | "renderInputWithMentions" | "selectFile"
  >;
  inputHandlers: Pick<
    ReturnType<typeof useComposerInput>,
    | "handleInputChange"
    | "insertAtCursor"
    | "handleKeyDown"
    | "handleTextareaClick"
    | "handleTextareaInput"
    | "syncInputOverlayScroll"
    | "handleClearInput"
    | "isInputFocused"
    | "handleInputFocusChange"
  > & {
    handleSubmit: ReturnType<typeof useSessionSubmit>["handleSubmit"];
  };
  permissions: Pick<
    ReturnType<typeof useSessionPermissions>,
    | "handleAbortSession"
    | "handlePermissionDecision"
    | "handleGrantToolPermission"
    | "handleGrantSessionToolPermission"
    | "handleApprovalDecision"
  >;
  busySend: Pick<
    ReturnType<typeof useSessionSubmit>,
    "steerBusySendQueue" | "canSteerBusySend" | "beginEditLastTurn" | "regenerateLastTurn"
  > & {
    isBusySendQueued: boolean;
    isBusySendConfirmed: boolean;
    cancelBusySendQueue: () => void;
  };
};

export function buildComposerResult({
  input,
  setInput,
  textareaRef,
  inputHighlightRef,
  isTextareaExpanded,
  thinkingMode,
  setThinkingMode,
  attachments,
  commands,
  mentions,
  inputHandlers,
  permissions,
  busySend,
}: ComposerResultArgs) {
  const {
    attachedImages,
    setAttachedImages,
    documentReferences,
    setDocumentReferences,
    uploadingImages,
    imageErrors,
    handlePaste,
    syncQueuedBusySendSnapshot,
    dropzone,
  } = attachments;
  const {
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
  } = inputHandlers;

  return {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    thinkingMode,
    setThinkingMode,
    slashCommandsCount: commands.slashCommandsCount,
    filteredCommands: commands.filteredCommands,
    frequentCommands: commands.frequentCommands,
    commandQuery: commands.commandQuery,
    showCommandMenu: commands.showCommandMenu,
    selectedCommandIndex: commands.selectedCommandIndex,
    resetCommandMenuState: commands.resetCommandMenuState,
    dismissCommandMenu: commands.dismissCommandMenu,
    handleCommandSelect: commands.handleCommandSelect,
    handleToggleCommandMenu: commands.handleToggleCommandMenu,
    showFileDropdown: mentions.showFileDropdown,
    filteredFiles: mentions.filteredFiles as MentionableFile[],
    selectedFileIndex: mentions.selectedFileIndex,
    renderInputWithMentions: mentions.renderInputWithMentions,
    selectFile: mentions.selectFile,
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
    getRootProps: dropzone.getRootProps,
    getInputProps: dropzone.getInputProps,
    isDragActive: dropzone.isDragActive,
    openImagePicker: dropzone.open,
    handleSubmit,
    handleInputChange,
    insertAtCursor,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession: permissions.handleAbortSession,
    handlePermissionDecision: permissions.handlePermissionDecision,
    handleGrantToolPermission: permissions.handleGrantToolPermission,
    handleGrantSessionToolPermission: permissions.handleGrantSessionToolPermission,
    handleApprovalDecision: permissions.handleApprovalDecision,
    handleInputFocusChange,
    isInputFocused,
    isBusySendQueued: busySend.isBusySendQueued,
    isBusySendConfirmed: busySend.isBusySendConfirmed,
    cancelBusySendQueue: busySend.cancelBusySendQueue,
    steerBusySendQueue: busySend.steerBusySendQueue,
    canSteerBusySend: busySend.canSteerBusySend,
    beginEditLastTurn: busySend.beginEditLastTurn,
    regenerateLastTurn: busySend.regenerateLastTurn,
  };
}
