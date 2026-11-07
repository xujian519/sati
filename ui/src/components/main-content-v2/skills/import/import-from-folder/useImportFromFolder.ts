/**
 * 「从文件夹导入技能」的组合 hook：持有输入/模式/scope 等单技能状态，串联
 * 防抖校验、批量导入与提交流程，向入口组件暴露渲染所需的全部数据与回调。
 * 行为与拆分前的组件内实现逐行等价（状态、effect 顺序、处理器分支均未改）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { NewModalCreated } from "../../shared/types";
import { readFolderSelection } from "./folderFiles";
import type { ImportMode, ImportScope, PickedFiles, Translator } from "./types";
import { useBatchImport } from "./useBatchImport";
import { useSingleSubmit } from "./useSingleSubmit";
import { useSkillValidation } from "./useSkillValidation";

export function useImportFromFolder({
  projectAvailable,
  projectPath,
  onImported,
  t,
}: {
  projectAvailable: boolean;
  projectPath: string | null;
  onImported: (created: NewModalCreated) => void;
  t: Translator;
}) {
  // Two input modes:
  //  - picked:    user clicked "Pick folder…" and the browser handed us
  //               File objects with webkitRelativePath. Always uses the
  //               multipart upload endpoint; symlink mode is unavailable
  //               because we don't have an absolute filesystem path.
  //  - typed:     user typed an absolute path; uses the JSON /import
  //               endpoint and supports both copy + symlink modes.
  const [sourcePath, setSourcePath] = useState("");
  const [picked, setPicked] = useState<PickedFiles>(null);
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [scope, setScope] = useState<ImportScope>(projectAvailable ? "project" : "user");
  const [mode, setMode] = useState<ImportMode>("copy");
  const [force, setForce] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!projectAvailable && scope === "project") setScope("user");
  }, [projectAvailable, scope]);

  // Slug auto-fill: from picked-folder name OR typed-path basename.
  useEffect(() => {
    if (slugTouched) return;
    if (picked) {
      setSlug(picked.rootName);
      return;
    }
    const cleaned = sourcePath.trim().replace(/\/+$/, "");
    setSlug(cleaned ? cleaned.split("/").filter(Boolean).pop() || "" : "");
  }, [picked, sourcePath, slugTouched]);

  // Force "copy" when in picked mode (no source path on disk → can't symlink).
  useEffect(() => {
    if (picked && mode === "symlink") setMode("copy");
  }, [picked, mode]);

  const { validation, validating, setValidation } = useSkillValidation({ picked, sourcePath, setErrorText });

  const {
    batchCandidates,
    batchParentName,
    selectedFolders,
    batchImporting,
    batchResults,
    batchDone,
    scanning,
    selectedCount,
    applyCandidates,
    clearBatch,
    handleScan,
    handleToggleFolder,
    handleToggleAll,
    submitBatch,
  } = useBatchImport({
    projectAvailable,
    projectPath,
    scope,
    mode,
    force,
    sourcePath,
    onImported,
    setPicked,
    setErrorText,
  });
  const batchMode = batchCandidates !== null;
  const slugValid = !slug || /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(slug);
  const hasInput = picked !== null || sourcePath.trim().length > 0;

  const { importing, canSubmit, submit } = useSingleSubmit({
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
  });

  const handlePickFolder = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFolderSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const fileList = event.target.files;
      if (!fileList || fileList.length === 0) return;

      const files = Array.from(fileList);
      const selection = await readFolderSelection(files);

      if (selection.kind === "single") {
        // Single skill — existing flow
        setPicked(selection.picked);
        setSourcePath("");
        setSlugTouched(false);
      } else {
        // No root SKILL.md — subdirectories become batch candidates
        applyCandidates(selection.candidates, selection.parentName);
        setSourcePath("");
        setPicked(null);
      }

      if (event.target) event.target.value = "";
    },
    [applyCandidates],
  );

  const clearPicked = useCallback(() => {
    setPicked(null);
    setValidation(null);
    setSlugTouched(false);
  }, [setValidation]);

  const handleSourcePathChange = useCallback(
    (value: string) => {
      setSourcePath(value);
      if (picked) setPicked(null);
      if (batchMode) clearBatch();
    },
    [picked, batchMode, clearBatch],
  );

  const handleSlugChange = useCallback((value: string) => {
    setSlug(value);
    setSlugTouched(true);
  }, []);

  return {
    sourcePath,
    picked,
    slug,
    slugValid,
    scope,
    mode,
    force,
    errorText,
    validation,
    validating,
    importing,
    canSubmit,
    fileInputRef,
    batchCandidates,
    batchParentName,
    selectedFolders,
    batchImporting,
    batchResults,
    batchDone,
    scanning,
    selectedCount,
    handlePickFolder,
    handleFolderSelected,
    handleSourcePathChange,
    handleSlugChange,
    setScope,
    setMode,
    setForce,
    clearPicked,
    clearBatch,
    handleScan,
    handleToggleFolder,
    handleToggleAll,
    submitBatch,
    submit,
  };
}
