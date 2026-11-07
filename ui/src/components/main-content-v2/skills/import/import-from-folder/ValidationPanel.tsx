/**
 * 校验结果面板：硬失败 / 警告 / 通过三态与文件统计。JSX 从原组件逐字搬出。
 */
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { formatBytes } from "../../shared/format";
import type { Translator, ValidationResult } from "./types";

export function ValidationPanel({
  result,
  validating,
  t,
}: {
  result: ValidationResult | null;
  validating: boolean;
  t: Translator;
}) {
  if (!result && !validating) return null;
  return (
    <div className="mt-4 rounded-md border border-neutral-200 dark:border-neutral-800">
      <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 text-[12px] font-medium dark:border-neutral-800">
        <ShieldCheck className="h-3.5 w-3.5 text-neutral-500" strokeWidth={1.75} />
        <span>{t("skillsTab.complianceCheck", { defaultValue: "Compliance check" })}</span>
        {validating ? (
          <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-neutral-400" strokeWidth={1.75} />
        ) : result?.ok ? (
          <CheckCircle2 className="ml-auto h-3.5 w-3.5 text-emerald-600 dark:text-emerald-500" strokeWidth={1.75} />
        ) : (
          <XCircle className="ml-auto h-3.5 w-3.5 text-red-600 dark:text-red-500" strokeWidth={1.75} />
        )}
      </div>
      <div className="space-y-1.5 px-3 py-2 text-[12px]">
        {result?.stats ? (
          <div className="flex items-center gap-3 text-neutral-500 dark:text-neutral-400">
            <span>
              {result.stats.fileCount} {t("skillsTab.files", { defaultValue: "files" })}
            </span>
            <span>·</span>
            <span>{formatBytes(result.stats.totalBytes)}</span>
            {result.frontmatter && (result.frontmatter as { name?: string }).name ? (
              <>
                <span>·</span>
                <span className="truncate">
                  name: <span className="font-mono">{(result.frontmatter as { name: string }).name}</span>
                </span>
              </>
            ) : null}
          </div>
        ) : null}
        {result?.hardFails && result.hardFails.length > 0 ? (
          <ul className="space-y-1">
            {result.hardFails.map((iss, i) => (
              <li key={`f${i}`} className="flex items-start gap-1.5 text-red-700 dark:text-red-400">
                <XCircle className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={2} />
                <span>{iss.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {result?.warnings && result.warnings.length > 0 ? (
          <ul className="space-y-1">
            {result.warnings.map((iss, i) => (
              <li key={`w${i}`} className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={2} />
                <span>{iss.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {result?.ok && (!result.warnings || result.warnings.length === 0) ? (
          <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-3 w-3" strokeWidth={2} />
            <span>{t("skillsTab.complianceClean", { defaultValue: "All checks passed." })}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
