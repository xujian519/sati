import { useTranslation } from "react-i18next";
import type { NewModalCreated } from "../shared/types";
import { BatchImportPanel } from "./BatchImportPanel";
import { ImportFooter } from "./import-from-folder/ImportFooter";
import { SingleImportFields } from "./import-from-folder/SingleImportFields";
import { SourceField } from "./import-from-folder/SourceField";
import { useImportFromFolder } from "./import-from-folder/useImportFromFolder";

/**
 * 从文件夹导入技能：两（三）种输入模式——picked（浏览器给的 File 对象，走 multipart）、
 * typed（绝对路径，走 JSON /import，支持 copy/symlink）、batch（扫描父目录下的多个技能）。
 *
 * 从 `SkillsV2.tsx` 整体搬出（#159 UI-APP-N01 切片 A）；#806 再把 688 行的组件函数
 * 拆成 `useImportFromFolder`（组合 hook）+ 展示子组件。对外导出与 props 保持不变。
 */

export type {
  BatchCandidate,
  BatchResult,
  BatchResultStatus,
  PickedFiles,
  ValidationResult,
} from "./import-from-folder/types";

export function ImportFromFolder({
  projectAvailable,
  projectPath,
  onImported,
  t,
}: {
  projectAvailable: boolean;
  projectPath: string | null;
  onImported: (created: NewModalCreated) => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const {
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
  } = useImportFromFolder({ projectAvailable, projectPath, onImported, t });

  const batchMode = batchCandidates !== null;

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {/* Source: pick or paste */}
        <SourceField
          batchMode={batchMode}
          sourcePath={sourcePath}
          picked={picked}
          scanning={scanning}
          fileInputRef={fileInputRef}
          onPickFolder={handlePickFolder}
          onScan={handleScan}
          onSourcePathChange={handleSourcePathChange}
          onFolderSelected={handleFolderSelected}
          onClearPicked={clearPicked}
          t={t}
        />

        {/* ---- Batch mode: candidate list ---- */}
        {batchMode ? (
          <BatchImportPanel
            candidates={batchCandidates}
            parentName={batchParentName}
            selectedFolders={selectedFolders}
            importing={batchImporting}
            results={batchResults}
            done={batchDone}
            scope={scope}
            onScopeChange={setScope}
            projectAvailable={projectAvailable}
            force={force}
            onForceChange={setForce}
            onToggleFolder={handleToggleFolder}
            onToggleAll={handleToggleAll}
            onClear={clearBatch}
            t={t}
          />
        ) : (
          <SingleImportFields
            slug={slug}
            slugValid={slugValid}
            mode={mode}
            picked={picked}
            validation={validation}
            validating={validating}
            scope={scope}
            force={force}
            projectAvailable={projectAvailable}
            onSlugChange={handleSlugChange}
            onModeChange={setMode}
            onScopeChange={setScope}
            onForceChange={setForce}
            t={t}
          />
        )}

        {errorText ? (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {errorText}
          </div>
        ) : null}
      </div>

      <ImportFooter
        batchMode={batchMode}
        batchDone={batchDone}
        selectedCount={selectedCount}
        batchImporting={batchImporting}
        onBatchSubmit={submitBatch}
        onBatchDone={() => {
          clearBatch();
          onImported({ slug: "", name: "", scope });
        }}
        canSubmit={canSubmit}
        importing={importing}
        onSubmit={submit}
        t={t}
      />
    </div>
  );
}
