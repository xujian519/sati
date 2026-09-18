/**
 * 批量导入面板：候选目录卡片（含 SKILL.md 的才可勾选）、逐项导入进度/结果图标，
 * 以及底部的 scope / 覆盖开关控件。
 *
 * 从 `ImportFromFolder` 逐 token 搬出（技术债 UI-APP-N01 切片 B）：JSX 与 class
 * 字符串一字未改，只把原先闭包捕获的父级变量换成 props；`skillCandidates` 与
 * `selectedCount` 在组件内本地推导（调用点已由 `batchMode === true` 保证
 * `candidates` 非空，父级的 `?.` / `?? []` 与 `selectedCount` 定义因此等价）。
 * 逐 token 证明见 `/tmp/uiappn01b2-move-proof.mjs`。
 */
import { CheckCircle2, Folder, Loader2, X, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../../lib/utils.js";
import { ScopeSelector } from "../shared/ScopeSelector";
import { formatBytes } from "../shared/format";
import type { BatchCandidate, BatchResult } from "./ImportFromFolder";

type BatchImportPanelProps = {
  /** 扫描出的全部候选子目录（父级 `batchMode` 为真时必然非空）。 */
  candidates: BatchCandidate[];
  /** 扫描的父目录绝对路径，仅用于标题展示。 */
  parentName: string;
  selectedFolders: ReadonlySet<string>;
  importing: boolean;
  results: ReadonlyMap<string, BatchResult>;
  done: boolean;
  scope: "user" | "project";
  onScopeChange: (scope: "user" | "project") => void;
  projectAvailable: boolean;
  force: boolean;
  onForceChange: (force: boolean) => void;
  onToggleFolder: (folderName: string) => void;
  onToggleAll: () => void;
  onClear: () => void;
  t: ReturnType<typeof useTranslation>["t"];
};

export function BatchImportPanel({
  candidates,
  parentName,
  selectedFolders,
  importing,
  results,
  done,
  scope,
  onScopeChange,
  projectAvailable,
  force,
  onForceChange,
  onToggleFolder,
  onToggleAll,
  onClear,
  t,
}: BatchImportPanelProps) {
  const skillCandidates = candidates.filter(c => c.hasSkillMd);
  const selectedCount = selectedFolders.size;

  return (
    <div className="mt-3 rounded-md border border-neutral-200 dark:border-neutral-800">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{parentName}</span>
        <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
          {t("skillsTab.foundSkills", {
            defaultValue: "Found {{count}} skills in {{total}} subfolders",
            count: skillCandidates.length,
            total: candidates.length,
          })}
        </span>
        <button
          type="button"
          onClick={onClear}
          disabled={importing}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          <X className="h-3 w-3" strokeWidth={1.75} />
        </button>
      </div>

      {skillCandidates.length === 0 ? (
        <div className="px-3 py-4 text-center text-[12px] text-neutral-500 dark:text-neutral-400">
          {t("skillsTab.noSkillsFound", { defaultValue: "No skills found in this folder." })}
        </div>
      ) : (
        <>
          {/* Select all */}
          {!done && (
            <div className="border-b border-neutral-100 px-3 py-1.5 dark:border-neutral-900">
              <label className="flex cursor-pointer items-center gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={skillCandidates.every(c => selectedFolders.has(c.folderName))}
                  onChange={onToggleAll}
                  disabled={importing}
                />
                <span className="font-medium">
                  {t("skillsTab.selectAll", {
                    defaultValue: "Select All ({{count}})",
                    count: skillCandidates.length,
                  })}
                </span>
              </label>
            </div>
          )}

          {/* Progress header */}
          {importing && (
            <div className="border-b border-neutral-100 px-3 py-1.5 text-[11px] text-neutral-500 dark:border-neutral-900 dark:text-neutral-400">
              {t("skillsTab.batchProgress", {
                defaultValue: "Importing {{current}}/{{total}}…",
                current: Array.from(results.values()).filter(r => r.status === "success" || r.status === "error")
                  .length,
                total: selectedCount,
              })}
            </div>
          )}
          {done && (
            <div className="border-b border-neutral-100 px-3 py-1.5 text-[11px] font-medium dark:border-neutral-900">
              {t("skillsTab.batchComplete", {
                defaultValue: "Batch import complete: {{success}} succeeded, {{failed}} failed",
                success: Array.from(results.values()).filter(r => r.status === "success").length,
                failed: Array.from(results.values()).filter(r => r.status === "error").length,
              })}
            </div>
          )}

          {/* Candidate list */}
          <div className="max-h-[240px] overflow-y-auto">
            {candidates.map(candidate => {
              const result = results.get(candidate.folderName);
              const isSkill = candidate.hasSkillMd;
              const isSelected = selectedFolders.has(candidate.folderName);

              return (
                <div
                  key={candidate.folderName}
                  className={cn(
                    "flex items-start gap-2 border-b border-neutral-50 px-3 py-2 last:border-b-0 dark:border-neutral-900/50",
                    !isSkill && "opacity-40",
                  )}
                >
                  {isSkill && !done ? (
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggleFolder(candidate.folderName)}
                      disabled={importing}
                      className="mt-0.5 shrink-0"
                    />
                  ) : result ? (
                    <span className="mt-0.5 shrink-0">
                      {result.status === "success" && (
                        <CheckCircle2
                          className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-500"
                          strokeWidth={1.75}
                        />
                      )}
                      {result.status === "error" && (
                        <XCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-500" strokeWidth={1.75} />
                      )}
                      {result.status === "importing" && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-400" strokeWidth={1.75} />
                      )}
                      {result.status === "pending" && <div className="h-3.5 w-3.5" />}
                    </span>
                  ) : !isSkill ? (
                    <div className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  ) : null}

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <Folder
                        className={cn(
                          "h-3 w-3 shrink-0",
                          isSkill ? "text-amber-500" : "text-neutral-300 dark:text-neutral-700",
                        )}
                        strokeWidth={1.75}
                      />
                      <span
                        className={cn(
                          "truncate text-[12px]",
                          isSkill ? "font-medium" : "text-neutral-400 dark:text-neutral-600",
                        )}
                      >
                        {candidate.folderName}
                      </span>
                      {!isSkill && (
                        <span className="shrink-0 text-[11px] text-neutral-400 dark:text-neutral-600">
                          ({t("skillsTab.noSkillMd", { defaultValue: "No SKILL.md" })})
                        </span>
                      )}
                    </div>
                    {isSkill && (candidate.name || candidate.description) && (
                      <div className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                        {candidate.name && <span className="font-medium">{candidate.name}</span>}
                        {candidate.name && candidate.description && <span> — </span>}
                        {candidate.description && <span>{candidate.description}</span>}
                      </div>
                    )}
                    {isSkill && (
                      <div className="mt-0.5 text-[11px] text-neutral-400 dark:text-neutral-500">
                        {candidate.fileCount} {t("skillsTab.files", { defaultValue: "files" })} ·{" "}
                        {formatBytes(candidate.totalSize)}
                      </div>
                    )}
                    {result?.status === "error" && result.error && (
                      <div className="mt-0.5 truncate text-[11px] text-red-600 dark:text-red-400">{result.error}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Batch controls */}
      {skillCandidates.length > 0 && !done && (
        <div className="border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
          <div className="flex items-center justify-between gap-3">
            <ScopeSelector scope={scope} onChange={onScopeChange} projectAvailable={projectAvailable} t={t} />
            <label className="flex cursor-pointer items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={force}
                onChange={e => onForceChange(e.target.checked)}
                disabled={importing}
              />
              <span>{t("skillsTab.importForce", { defaultValue: "Overwrite if exists" })}</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
