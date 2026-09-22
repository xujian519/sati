import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronUp, ShieldAlert, X } from "lucide-react";
import { useHookTrust } from "../hooks/useHookTrust";
import type { HookTrustEntry } from "../types/types";

/**
 * 项目级 hook 信任横幅（应用级：挂在主内容区之上，与聊天 composer 内的审批条无关）。
 *
 * 为什么需要它：未评审的项目插件 hook 默认**不装载**（门在 `src/` 的会话装配点）。
 * 没有这个入口，纯浏览器用户只会看到自己的项目 hook 静默失效。横幅逐条列出**声明原文**
 * （命令 / URL / 提示词），因为看不见内容的「授权」不算授权。
 *
 * 只呈现 `trusted` 之外的条目；全部已评审时不渲染任何东西（默认零占用）。
 */
export function HookTrustBanner({ projectPath }: { projectPath: string | null }): JSX.Element | null {
  const { t } = useTranslation("hookTrust");
  const { pendingEntries, error, busyPluginId, decide } = useHookTrust({ projectKey: projectPath });
  const [expanded, setExpanded] = useState(false);
  const [dismissedProject, setDismissedProject] = useState<string | null>(null);

  if (error !== null && pendingEntries.length === 0) return null;
  if (pendingEntries.length === 0) return null;
  if (projectPath !== null && dismissedProject === projectPath) return null;

  return (
    <section
      data-testid="hook-trust-banner"
      className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert className="size-4 shrink-0" aria-hidden="true" />
        <span className="font-medium">{t("title")}</span>
        <span className="text-amber-800 dark:text-amber-200">{t("subtitle", { count: pendingEntries.length })}</span>
        <button
          type="button"
          className="ml-1 inline-flex items-center gap-1 rounded border border-amber-400 px-2 py-0.5 hover:bg-amber-100 dark:border-amber-800 dark:hover:bg-amber-900/40"
          onClick={() => setExpanded(value => !value)}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronUp className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden="true" />
          )}
          {expanded ? t("collapse") : t("expand")}
        </button>
        <button
          type="button"
          className="ml-auto rounded px-2 py-0.5 text-amber-800 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-900/40"
          onClick={() => setDismissedProject(projectPath)}
        >
          {t("dismiss")}
        </button>
      </div>

      {expanded ? (
        <div className="mt-2 space-y-3">
          {pendingEntries.map(entry => (
            <HookTrustEntryCard
              key={entry.pluginId}
              entry={entry}
              busy={busyPluginId === entry.pluginId}
              onDecide={verdict => void decide(entry.pluginId, verdict)}
            />
          ))}
          <p className="text-xs text-amber-800 dark:text-amber-200">{t("footer")}</p>
        </div>
      ) : null}
    </section>
  );
}

function HookTrustEntryCard({
  entry,
  busy,
  onDecide,
}: {
  entry: HookTrustEntry;
  busy: boolean;
  onDecide: (verdict: "grant" | "revoke") => void;
}): JSX.Element {
  const { t } = useTranslation("hookTrust");
  return (
    <div
      data-testid={`hook-trust-entry-${entry.pluginId}`}
      className="rounded border border-amber-300 bg-white/70 p-2 dark:border-amber-900/60 dark:bg-neutral-900/60"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-medium">{entry.pluginName}</span>
        <span className="rounded bg-amber-200 px-1.5 py-0.5 text-xs dark:bg-amber-900/60">
          {t(`status.${entry.status}`)}
        </span>
        <span className="truncate font-mono text-xs text-amber-800 dark:text-amber-200" title={entry.pluginRoot}>
          {entry.pluginRoot}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            data-testid={`hook-trust-approve-${entry.pluginId}`}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-0.5 text-xs text-white hover:bg-emerald-700 disabled:opacity-50"
            onClick={() => onDecide("grant")}
          >
            <Check className="size-3.5" aria-hidden="true" />
            {t("approve")}
          </button>
          <button
            type="button"
            data-testid={`hook-trust-reject-${entry.pluginId}`}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded border border-amber-400 px-2 py-0.5 text-xs hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:hover:bg-amber-900/40"
            onClick={() => onDecide("revoke")}
          >
            <X className="size-3.5" aria-hidden="true" />
            {t("reject")}
          </button>
        </div>
      </div>

      <ul className="mt-1.5 space-y-0.5">
        {entry.hooks.length === 0 ? (
          <li className="text-xs text-amber-800 dark:text-amber-200">{t("noHooks")}</li>
        ) : (
          entry.hooks.map((hook, index) => (
            <li key={`${hook.event}-${hook.kind}-${index}`} className="break-all font-mono text-xs">
              {`${hook.event}${hook.matcher ? `[${hook.matcher}]` : ""} ${hook.kind}: ${hook.summary}`}
              {hook.condition ? ` (if: ${hook.condition})` : ""}
            </li>
          ))
        )}
      </ul>

      {entry.status === "blocked" && entry.detail ? (
        <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">{entry.detail}</p>
      ) : null}
    </div>
  );
}
