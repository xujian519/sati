import { cn } from "../../lib/utils.js";
import type { SessionIndicatorStatus } from "./sidebarV2Model";

const SPINNER_DOTS = Array.from({ length: 8 }, (_, index) => index);

export default function SidebarSessionStatusIndicator({
  status,
  label,
}: {
  status: SessionIndicatorStatus;
  label: string;
}) {
  if (status === "processing") {
    return (
      <span aria-label={label} title={label} className="relative block h-3 w-3 animate-spin">
        {SPINNER_DOTS.map(dot => (
          <span
            key={dot}
            className="absolute top-1/2 left-1/2 h-1 w-1 rounded-full bg-neutral-500 dark:bg-neutral-300"
            style={{
              transform: `translate(-50%, -50%) rotate(${dot * 45}deg) translateY(-4px)`,
              opacity: 0.35 + dot * 0.08,
            }}
          />
        ))}
      </span>
    );
  }

  return (
    <span
      aria-label={label}
      title={label}
      className={cn(
        "block h-1.5 w-1.5 rounded-full transition-colors",
        status === "unread"
          ? "bg-brand-500 shadow-[0_0_6px_rgba(79,156,255,0.5)] dark:bg-brand-400 dark:shadow-[0_0_6px_rgba(96,165,250,0.6)]"
          : "bg-neutral-300 dark:bg-neutral-600",
      )}
    />
  );
}
