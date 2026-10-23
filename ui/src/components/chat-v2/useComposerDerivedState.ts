import type { TFunction } from "i18next";
import { Brain } from "lucide-react";
import type { ChatRunMode, PendingPermissionRequest, PermissionMode } from "../chat/types/types";
import { MAX_ATTACHMENTS_ERROR_KEY } from "../chat/hooks/useAttachmentUpload";
import { thinkingModes, type ThinkingModeId } from "../chat/constants/thinkingModes";
import { getEffectiveThinkingMode, type ThinkingModeAvailability } from "../chat/constants/thinkingModeAvailability";
import type { ContentReference } from "../../types/contentReference";
import { BLOCKING_PERMISSION_TOOLS, PERMISSION_MODE_OPTIONS, RUN_MODE_OPTIONS } from "./composerOptions";
import { getContextStatus } from "./contextStatus";

type ComposerDerivedStateArgs = {
  input: string;
  attachedImages: File[];
  documentReferences: ContentReference[];
  uploadingImages: Map<string, number>;
  imageErrors: Map<string, string>;
  pendingPermissionRequests: PendingPermissionRequest[];
  isSubmitPending: boolean;
  isLoading: boolean;
  canAbortSession: boolean;
  isBusySendConfirmed: boolean;
  isBusySendQueued: boolean;
  tokenBudget?: Record<string, unknown> | null;
  thinkingMode: ThinkingModeId;
  thinkingModeAvailability: ThinkingModeAvailability;
  permissionMode: PermissionMode;
  runMode: ChatRunMode;
  t: TFunction<"chat">;
};

function resolveSendTitle(args: {
  isSubmitPending: boolean;
  hasUploadingImages: boolean;
  isBusySendConfirmed: boolean;
  isBusySendQueued: boolean;
  isLoading: boolean;
  t: TFunction<"chat">;
}): string {
  const { t } = args;
  if (args.isSubmitPending || args.hasUploadingImages) {
    return t("input.sending", { defaultValue: "Sending..." }) as string;
  }
  if (args.isBusySendConfirmed) {
    return t("input.queuedSendConfirmed", { defaultValue: "Stopping current turn — sending next message" }) as string;
  }
  if (args.isBusySendQueued) {
    return t("input.queuedSendConfirm", {
      defaultValue: "Queued — click send again to stop this turn and send now",
    }) as string;
  }
  if (args.isLoading) {
    return t("input.queueSend", { defaultValue: "Queue message" }) as string;
  }
  return t("input.send", { defaultValue: "Send" }) as string;
}

export function useComposerDerivedState({
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
}: ComposerDerivedStateArgs) {
  const hasBlockingPermissionPanel = pendingPermissionRequests.some(request =>
    BLOCKING_PERMISSION_TOOLS.has(request.toolName),
  );

  const hasDraftContent = input.trim().length > 0 || attachedImages.length > 0 || documentReferences.length > 0;
  const hasUploadingImages = uploadingImages.size > 0;
  const attachmentLimitError = imageErrors.get(MAX_ATTACHMENTS_ERROR_KEY);
  const disabled = !hasDraftContent || isSubmitPending || hasUploadingImages;
  const showAbortButton = isLoading && canAbortSession && !hasDraftContent;
  const sendTitle = resolveSendTitle({
    isSubmitPending,
    hasUploadingImages,
    isBusySendConfirmed,
    isBusySendQueued,
    isLoading,
    t,
  });
  const contextStatus = getContextStatus(tokenBudget);
  const effectiveThinkingMode = getEffectiveThinkingMode(thinkingMode, thinkingModeAvailability);
  const selectedThinkingMode = thinkingModes.find(option => option.id === effectiveThinkingMode) || thinkingModes[0];
  const SelectedThinkingIcon = selectedThinkingMode.icon || Brain;
  const selectedPermissionOption =
    PERMISSION_MODE_OPTIONS.find(option => option.mode === permissionMode) || PERMISSION_MODE_OPTIONS[0];
  const selectedRunModeOption = RUN_MODE_OPTIONS.find(option => option.mode === runMode) || RUN_MODE_OPTIONS[0];
  const SelectedRunModeIcon = selectedRunModeOption.Icon;
  const selectedRunModeLabel = t(selectedRunModeOption.labelKey, {
    defaultValue: selectedRunModeOption.defaultLabel,
  }) as string;
  const SelectedPermissionIcon = selectedPermissionOption.Icon;
  const selectedPermissionLabel = t(selectedPermissionOption.labelKey, {
    defaultValue: selectedPermissionOption.defaultLabel,
  }) as string;
  const contextStatusTitle = contextStatus.known
    ? contextStatus.state === "blocking"
      ? (t("input.contextStatusBlocking", {
          percentLabel: contextStatus.percentLabel,
          used: contextStatus.usedLabel,
          total: contextStatus.totalLabel,
          defaultValue: `${contextStatus.percentLabel} used. ${contextStatus.usedLabel} tokens used out of ${contextStatus.totalLabel}. Auto compact ran, but the context is still over the limit.`,
        }) as string)
      : (t("input.contextStatus", {
          percentLabel: contextStatus.percentLabel,
          used: contextStatus.usedLabel,
          total: contextStatus.totalLabel,
          defaultValue: `${contextStatus.percentLabel} used. ${contextStatus.usedLabel} tokens used out of ${contextStatus.totalLabel}. Auto compact runs near the limit.`,
        }) as string)
    : (t("input.contextStatusUnknown", {
        defaultValue: "Context usage unknown. It will appear after the next model response.",
      }) as string);
  const contextWindowTitle = t("input.contextStatusTitle", { defaultValue: "Context window" }) as string;

  return {
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
  };
}
