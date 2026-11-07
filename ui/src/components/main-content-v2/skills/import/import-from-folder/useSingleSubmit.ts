/**
 * 单个技能的提交动作：picked 模式走 multipart `/api/skills/import-upload`，
 * 手填路径模式走 JSON `/api/skills/import`；冲突提示沿用 `importEnableForce`。
 * 从原 `submit` 逐行搬出，`canSubmit` 的判定条件也保持不变。
 */
import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { authenticatedFetch } from "../../../../../utils/api";
import { api } from "../../shared/api";
import type { NewModalCreated, Skill } from "../../shared/types";
import type { ImportMode, ImportScope, PickedFiles, Translator, ValidationResult } from "./types";

export function useSingleSubmit({
  hasInput,
  slugValid,
  validating,
  validation,
  picked,
  sourcePath,
  slug,
  projectAvailable,
  scope,
  projectPath,
  mode,
  force,
  onImported,
  setValidation,
  setErrorText,
  t,
}: {
  hasInput: boolean;
  slugValid: boolean;
  validating: boolean;
  validation: ValidationResult | null;
  picked: PickedFiles;
  sourcePath: string;
  slug: string;
  projectAvailable: boolean;
  scope: ImportScope;
  projectPath: string | null;
  mode: ImportMode;
  force: boolean;
  onImported: (created: NewModalCreated) => void;
  setValidation: Dispatch<SetStateAction<ValidationResult | null>>;
  setErrorText: Dispatch<SetStateAction<string | null>>;
  t: Translator;
}) {
  const [importing, setImporting] = useState(false);
  const canSubmit = hasInput && slugValid && !importing && !validating && validation?.ok === true;

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setImporting(true);
    setErrorText(null);
    try {
      const effectiveScope = projectAvailable ? scope : "user";
      if (picked) {
        // Multipart upload path. We send the relativePath array as a
        // separate JSON field because multer drops folder paths from
        // multipart filenames.
        const formData = new FormData();
        for (let i = 0; i < picked.files.length; i++) {
          // The browser put webkitRelativePath on the File; multer only
          // surfaces basename. Append with a stable name and ferry paths
          // alongside.
          formData.append("files", picked.files[i]);
        }
        formData.append("paths", JSON.stringify(picked.manifest.map(m => m.relativePath)));
        if (slug) formData.append("slug", slug);
        formData.append("scope", effectiveScope);
        if (effectiveScope === "project" && projectPath) formData.append("projectPath", projectPath);
        if (force) formData.append("force", "true");

        const r = await authenticatedFetch("/api/skills/import-upload", {
          method: "POST",
          body: formData,
        });
        const data = (await r.json().catch(() => ({}))) as {
          error?: string;
          validation?: ValidationResult;
          slug: string;
          scope: ImportScope;
          skill: Skill | null;
        };
        if (!r.ok) {
          if (data.validation) setValidation(data.validation);
          throw new Error(data.error || `Upload failed (${r.status})`);
        }
        onImported({ slug: data.slug, name: data.skill?.name || data.slug, scope: data.scope });
      } else {
        // Path-based path. /api/skills/import runs the same validator
        // server-side, so a hardFail still blocks here.
        const r = await api<{
          ok: boolean;
          slug: string;
          scope: ImportScope;
          skillPath: string;
          skill: Skill | null;
          mode: string;
          validation?: ValidationResult;
        }>("/api/skills/import", {
          sourcePath,
          slug: slug || undefined,
          scope: effectiveScope,
          projectPath: effectiveScope === "project" ? projectPath : null,
          mode,
          force,
        });
        onImported({ slug: r.slug, name: r.skill?.name || r.slug, scope: r.scope });
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (/already exists/i.test(msg) && !force) {
        setErrorText(
          msg + " " + t("skillsTab.importEnableForce", { defaultValue: 'Enable "Overwrite" to replace it.' }),
        );
      } else {
        setErrorText(msg);
      }
    } finally {
      setImporting(false);
    }
  }, [
    canSubmit,
    picked,
    sourcePath,
    slug,
    projectAvailable,
    scope,
    projectPath,
    mode,
    force,
    onImported,
    setValidation,
    setErrorText,
    t,
  ]);

  return { importing, canSubmit, submit };
}
