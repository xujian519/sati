import { useRef, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { Check, Copy, GitBranch } from "lucide-react";
import { copyTextToClipboard } from "../../../utils/clipboard";
import { UI_TIMEOUTS } from "../../../constants/timeouts";
import { cn } from "../../../lib/utils.js";

export function CopyMarkdownButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = async () => {
    const ok = await copyTextToClipboard(content);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), UI_TIMEOUTS.COPY_FEEDBACK_RESET_MS);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="rounded p-1 text-neutral-400 transition-colors hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
      aria-label={copied ? "Copied" : "Copy"}
      title={copied ? "Copied" : "Copy"}
    >
      {copied ? <Check className="h-3.5 w-3.5" strokeWidth={2} /> : <Copy className="h-3.5 w-3.5" strokeWidth={2} />}
    </button>
  );
}

export function HoverActionButton({
  icon,
  label,
  disabled = false,
  onClick,
  variant = "action-row",
}: {
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
  variant?: "user-hover" | "action-row";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        variant === "user-hover"
          ? "mb-1 rounded-md p-1.5 text-neutral-400 opacity-0 transition-all group-hover/user-msg:opacity-100 focus-visible:opacity-100"
          : "rounded p-1 text-neutral-400 transition-colors hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300",
        disabled
          ? "cursor-not-allowed opacity-30"
          : variant === "user-hover"
            ? "hover:bg-neutral-200/80 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
            : undefined,
      )}
      aria-label={label}
      title={label}
    >
      {icon}
    </button>
  );
}

export function ForkMessageButton({
  carriedMessageCount,
  disabled,
  disabledReason,
  onFork,
  t,
  variant = "user-hover",
}: {
  carriedMessageCount: number;
  disabled?: boolean;
  disabledReason?: string;
  onFork: () => void;
  t: TFunction;
  variant?: "user-hover" | "action-row";
}) {
  const title =
    disabledReason ??
    t("fork.fromHere", {
      count: carriedMessageCount,
      defaultValue: `Fork from here · carries ${carriedMessageCount} messages`,
    });

  return (
    <button
      type="button"
      onClick={onFork}
      disabled={disabled}
      className={cn(
        variant === "user-hover"
          ? "mb-1 rounded-md p-1.5 text-neutral-400 opacity-0 transition-all group-hover/user-msg:opacity-100 focus-visible:opacity-100"
          : "rounded p-1 text-neutral-400 transition-colors hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300",
        disabled
          ? "cursor-not-allowed opacity-30"
          : variant === "user-hover"
            ? "hover:bg-neutral-200/80 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
            : undefined,
      )}
      aria-label={title}
      title={title}
    >
      <GitBranch className="h-3.5 w-3.5" strokeWidth={2} />
    </button>
  );
}
