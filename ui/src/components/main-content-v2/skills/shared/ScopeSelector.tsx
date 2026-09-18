import { useTranslation } from "react-i18next";
import { Globe } from "lucide-react";
import { cn } from "../../../../lib/utils.js";

/** 作用域选择器（user / project），Skills 面板多处共用。 */
export function ScopeSelector({
  scope,
  onChange,
  projectAvailable,
  t,
}: {
  scope: "user" | "project";
  onChange: (s: "user" | "project") => void;
  projectAvailable: boolean;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="text-neutral-500 dark:text-neutral-400">{t("skillsTab.scope", { defaultValue: "Scope" })}:</span>
      <div className="inline-flex overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800">
        <button
          type="button"
          onClick={() => onChange("user")}
          className={cn(
            "px-2.5 py-1 transition-colors",
            scope === "user"
              ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
              : "text-neutral-600 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-900",
          )}
        >
          <span className="inline-flex items-center gap-1">
            <Globe className="h-3 w-3" strokeWidth={1.75} />
            {t("skillsTab.scopeUser", { defaultValue: "User" })}
          </span>
        </button>
        <button
          type="button"
          disabled={!projectAvailable}
          onClick={() => onChange("project")}
          className={cn(
            "px-2.5 py-1 transition-colors",
            scope === "project"
              ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
              : "text-neutral-600 hover:bg-neutral-50 disabled:opacity-40 disabled:hover:bg-transparent dark:text-neutral-400 dark:hover:bg-neutral-900",
          )}
        >
          {t("skillsTab.scopeProject", { defaultValue: "Project" })}
        </button>
      </div>
    </div>
  );
}
