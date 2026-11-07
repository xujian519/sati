/**
 * 单技能导入表单：slug、copy/symlink 模式、校验面板、scope 与覆盖开关。
 * JSX 与 className 从原组件逐字搬出，仅把闭包变量换为 props。
 */
import { cn } from "../../../../../lib/utils.js";
import { Field } from "../../shared/Field";
import { ScopeSelector } from "../../shared/ScopeSelector";
import type { ImportMode, ImportScope, PickedFiles, Translator, ValidationResult } from "./types";
import { ValidationPanel } from "./ValidationPanel";

export function SingleImportFields({
  slug,
  slugValid,
  mode,
  picked,
  validation,
  validating,
  scope,
  force,
  projectAvailable,
  onSlugChange,
  onModeChange,
  onScopeChange,
  onForceChange,
  t,
}: {
  slug: string;
  slugValid: boolean;
  mode: ImportMode;
  picked: PickedFiles;
  validation: ValidationResult | null;
  validating: boolean;
  scope: ImportScope;
  force: boolean;
  projectAvailable: boolean;
  onSlugChange: (value: string) => void;
  onModeChange: (mode: ImportMode) => void;
  onScopeChange: (scope: ImportScope) => void;
  onForceChange: (force: boolean) => void;
  t: Translator;
}) {
  return (
    <>
      {/* ---- Single import mode (existing UI) ---- */}
      <Field
        label={t("skillsTab.importSlug", { defaultValue: "Slug (target folder name)" })}
        hint={
          t("skillsTab.importSlugHint", {
            defaultValue: "Defaults to the source folder name. Edit to override.",
          }) as string
        }
      >
        <input
          type="text"
          value={slug}
          onChange={e => onSlugChange(e.target.value)}
          placeholder="my-skill"
          className={cn(
            "h-8 w-full rounded-md border bg-white px-2 font-mono text-[12px] outline-hidden dark:bg-neutral-950",
            slugValid
              ? "border-neutral-200 focus:border-neutral-400 dark:border-neutral-800 dark:focus:border-neutral-600"
              : "border-red-300 dark:border-red-800",
          )}
        />
      </Field>

      <Field label={t("skillsTab.importMode", { defaultValue: "Import mode" })}>
        <div className="flex flex-col gap-1.5 text-[12px]">
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="radio"
              name="import-mode"
              checked={mode === "copy"}
              onChange={() => onModeChange("copy")}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">{t("skillsTab.importModeCopy", { defaultValue: "Copy" })}</span>
              <span className="ml-1 text-neutral-500 dark:text-neutral-400">
                {t("skillsTab.importModeCopyHint", {
                  defaultValue: "— independent copy, edits live in the skills folder.",
                })}
              </span>
            </span>
          </label>
          <label className={cn("flex items-start gap-2", picked ? "cursor-not-allowed opacity-50" : "cursor-pointer")}>
            <input
              type="radio"
              name="import-mode"
              checked={mode === "symlink"}
              disabled={picked !== null}
              onChange={() => onModeChange("symlink")}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">{t("skillsTab.importModeSymlink", { defaultValue: "Symlink" })}</span>
              <span className="ml-1 text-neutral-500 dark:text-neutral-400">
                {picked
                  ? t("skillsTab.symlinkUnavailable", {
                      defaultValue: "— unavailable for picker uploads (no source path on disk).",
                    })
                  : t("skillsTab.importModeSymlinkHint", {
                      defaultValue:
                        "— edits in the source folder propagate live; deleting the source breaks the skill.",
                    })}
              </span>
            </span>
          </label>
        </div>
      </Field>

      <ValidationPanel result={validation} validating={validating} t={t} />

      <div className="mt-4 flex items-center justify-between gap-3">
        <ScopeSelector scope={scope} onChange={onScopeChange} projectAvailable={projectAvailable} t={t} />
        <label className="flex cursor-pointer items-center gap-2 text-[12px]">
          <input type="checkbox" checked={force} onChange={e => onForceChange(e.target.checked)} />
          <span>{t("skillsTab.importForce", { defaultValue: "Overwrite if exists" })}</span>
        </label>
      </div>
    </>
  );
}
