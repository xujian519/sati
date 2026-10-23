import { ArrowUp, Check, Loader2 } from "lucide-react";
import { cn } from "../../lib/utils.js";

type ComposerSubmitButtonProps = {
  disabled: boolean;
  isSubmitPending: boolean;
  hasUploadingImages: boolean;
  isBusySendConfirmed: boolean;
  isBusySendQueued: boolean;
  sendTitle: string;
};

export default function ComposerSubmitButton({
  disabled,
  isSubmitPending,
  hasUploadingImages,
  isBusySendConfirmed,
  isBusySendQueued,
  sendTitle,
}: ComposerSubmitButtonProps) {
  return (
    <button
      type="submit"
      disabled={disabled}
      aria-busy={isSubmitPending || hasUploadingImages || isBusySendConfirmed}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-lg text-white transition-all duration-200",
        "bg-gradient-to-b from-brand-500 to-brand-600",
        "shadow-[0_2px_8px_-2px_rgba(79,156,255,0.4),inset_0_1px_0_rgba(255,255,255,0.15)]",
        "hover:from-brand-600 hover:to-brand-700 hover:shadow-[0_4px_12px_-2px_rgba(79,156,255,0.5),inset_0_1px_0_rgba(255,255,255,0.15)]",
        "disabled:opacity-40 disabled:shadow-none",
        "dark:from-brand-500 dark:to-brand-600",
        isBusySendQueued &&
          "from-amber-500 to-amber-600 shadow-[0_2px_8px_-2px_rgba(245,158,11,0.4)] hover:from-amber-600 hover:to-amber-700 dark:from-amber-400 dark:to-amber-500 dark:text-neutral-950 dark:hover:from-amber-300 dark:hover:to-amber-400",
        isBusySendConfirmed && "cursor-wait",
        (isSubmitPending || hasUploadingImages) && "cursor-wait",
      )}
      title={sendTitle}
    >
      {isSubmitPending || hasUploadingImages || isBusySendConfirmed ? (
        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.25} />
      ) : isBusySendQueued ? (
        <Check className="h-4 w-4" strokeWidth={2.25} />
      ) : (
        <ArrowUp className="h-4 w-4" strokeWidth={2} />
      )}
    </button>
  );
}
