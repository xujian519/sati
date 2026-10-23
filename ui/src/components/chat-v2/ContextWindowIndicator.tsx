import { CircleGauge } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { cn } from "../../lib/utils.js";
import { CONTEXT_TONE_TRIGGER_STYLES, type ContextStatus } from "./contextStatus";

type ContextWindowIndicatorProps = {
  isContextPopoverOpen: boolean;
  setIsContextPopoverOpen: Dispatch<SetStateAction<boolean>>;
  contextStatus: ContextStatus;
  contextStatusTitle: string;
};

export default function ContextWindowIndicator({
  isContextPopoverOpen,
  setIsContextPopoverOpen,
  contextStatus,
  contextStatusTitle,
}: ContextWindowIndicatorProps) {
  return (
    <div
      className="relative"
      onBlur={event => {
        const nextTarget = event.relatedTarget as Node | null;
        if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
          setIsContextPopoverOpen(false);
        }
      }}
    >
      <button
        type="button"
        onClick={() => setIsContextPopoverOpen(open => !open)}
        className={cn(
          "pd-composer-icon-button inline-flex h-7 min-w-[44px] items-center justify-center gap-1 rounded-md px-1.5 text-[11px] tabular-nums transition",
          CONTEXT_TONE_TRIGGER_STYLES[contextStatus.tone],
        )}
        title={contextStatusTitle}
        aria-label={contextStatusTitle}
        aria-expanded={isContextPopoverOpen}
      >
        <CircleGauge className="h-4 w-4" strokeWidth={1.75} />
        <span className="pd-composer-context-label">{contextStatus.known ? contextStatus.percentLabel : "--"}</span>
      </button>
    </div>
  );
}
