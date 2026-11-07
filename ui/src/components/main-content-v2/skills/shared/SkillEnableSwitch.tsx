import { cn } from "../../../../lib/utils.js";

/** 技能启用开关（列表行右侧）；纯展示，状态由父级提供。 */
export function SkillEnableSwitch({
  enabled,
  label,
  onToggle,
}: {
  enabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      title={label}
      onClick={event => {
        event.stopPropagation();
        onToggle();
      }}
      className={cn(
        "absolute top-1/2 right-8 flex h-4 w-7 -translate-y-1/2 items-center rounded-full p-0.5 transition-colors",
        enabled ? "bg-emerald-500 dark:bg-emerald-600" : "bg-neutral-300 dark:bg-neutral-700",
      )}
    >
      <span
        className={cn(
          "h-3 w-3 rounded-full bg-white shadow transition-transform",
          enabled ? "translate-x-3" : "translate-x-0",
        )}
      />
    </button>
  );
}
