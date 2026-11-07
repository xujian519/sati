/**
 * 批量导入模式的状态与动作：扫描父目录、勾选候选、逐个导入并回填结果。
 * 从原组件内的 batch 状态块与 `handleScan` / `handleToggle*` / `submitBatch` 逐行搬出。
 */
import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { api } from "../../shared/api";
import type { NewModalCreated } from "../../shared/types";
import { importCandidate } from "./batchImportRequest";
import type { BatchCandidate, BatchResult, ImportMode, ImportScope, PickedFiles } from "./types";

export function useBatchImport({
  projectAvailable,
  projectPath,
  scope,
  mode,
  force,
  sourcePath,
  onImported,
  setPicked,
  setErrorText,
}: {
  projectAvailable: boolean;
  projectPath: string | null;
  scope: ImportScope;
  mode: ImportMode;
  force: boolean;
  sourcePath: string;
  onImported: (created: NewModalCreated) => void;
  setPicked: Dispatch<SetStateAction<PickedFiles>>;
  setErrorText: Dispatch<SetStateAction<string | null>>;
}) {
  const [batchCandidates, setBatchCandidates] = useState<BatchCandidate[] | null>(null);
  const [batchParentName, setBatchParentName] = useState("");
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const [batchImporting, setBatchImporting] = useState(false);
  const [batchResults, setBatchResults] = useState<Map<string, BatchResult>>(new Map());
  const [batchDone, setBatchDone] = useState(false);
  const [scanning, setScanning] = useState(false);

  const selectedCount = selectedFolders.size;

  /** 两个入口（选文件夹 / 扫描）共用的候选落位逻辑。 */
  const applyCandidates = useCallback((candidates: BatchCandidate[], parentName: string) => {
    setBatchCandidates(candidates);
    setBatchParentName(parentName);
    const skillNames = candidates.filter(c => c.hasSkillMd).map(c => c.folderName);
    setSelectedFolders(new Set(skillNames));
    setBatchResults(new Map());
    setBatchDone(false);
    setBatchImporting(false);
  }, []);

  const clearBatch = useCallback(() => {
    setBatchCandidates(null);
    setBatchParentName("");
    setSelectedFolders(new Set());
    setBatchResults(new Map());
    setBatchDone(false);
    setBatchImporting(false);
  }, []);

  const handleScan = useCallback(async () => {
    if (!sourcePath.trim()) return;
    setScanning(true);
    try {
      const r = await api<{
        parentPath: string;
        folders: Array<{
          folderName: string;
          hasSkillMd: boolean;
          name: string | null;
          description: string | null;
          sourcePath: string;
          fileCount: number;
          totalSize: number;
        }>;
      }>("/api/skills/scan", { parentPath: sourcePath.trim() });
      const candidates: BatchCandidate[] = r.folders.map(f => ({
        ...f,
        files: [],
      }));
      applyCandidates(candidates, sourcePath.trim().split("/").filter(Boolean).pop() || sourcePath.trim());
      setPicked(null);
    } catch (e) {
      setErrorText((e as Error).message);
    } finally {
      setScanning(false);
    }
  }, [sourcePath, applyCandidates, setPicked, setErrorText]);

  const handleToggleFolder = useCallback((folderName: string) => {
    setSelectedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderName)) next.delete(folderName);
      else next.add(folderName);
      return next;
    });
  }, []);

  const handleToggleAll = useCallback(() => {
    if (!batchCandidates) return;
    const skills = batchCandidates.filter(c => c.hasSkillMd);
    const allSelected = skills.every(c => selectedFolders.has(c.folderName));
    if (allSelected) {
      setSelectedFolders(new Set());
    } else {
      setSelectedFolders(new Set(skills.map(c => c.folderName)));
    }
  }, [batchCandidates, selectedFolders]);

  const submitBatch = useCallback(async () => {
    if (!batchCandidates || selectedCount === 0) return;
    setBatchImporting(true);
    setBatchDone(false);
    const selected = batchCandidates.filter(c => c.hasSkillMd && selectedFolders.has(c.folderName));

    const results = new Map<string, BatchResult>();
    for (const c of selected) {
      results.set(c.folderName, { folderName: c.folderName, status: "pending" });
    }
    setBatchResults(new Map(results));

    let successCount = 0;
    for (const candidate of selected) {
      results.set(candidate.folderName, { folderName: candidate.folderName, status: "importing" });
      setBatchResults(new Map(results));

      try {
        const effectiveScope = projectAvailable ? scope : "user";
        await importCandidate(candidate, {
          parentName: batchParentName,
          scope: effectiveScope,
          projectPath,
          mode,
          force,
        });
        results.set(candidate.folderName, { folderName: candidate.folderName, status: "success" });
        successCount++;
      } catch (e) {
        results.set(candidate.folderName, {
          folderName: candidate.folderName,
          status: "error",
          error: (e as Error).message,
        });
      }
      setBatchResults(new Map(results));
    }

    setBatchImporting(false);
    setBatchDone(true);

    if (successCount > 0) {
      onImported({
        slug: selected[0].folderName,
        name: selected[0].name || selected[0].folderName,
        scope: projectAvailable ? scope : "user",
      });
    }
  }, [
    batchCandidates,
    selectedCount,
    selectedFolders,
    projectAvailable,
    scope,
    projectPath,
    mode,
    force,
    batchParentName,
    onImported,
  ]);

  return {
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
  };
}
