/**
 * 浏览器 `File` 列表 → 导入计划的纯函数：根目录直接有 SKILL.md 时为单个技能导入，
 * 否则把一级子目录当作批量候选（含 SKILL.md 的排前面）。逻辑从原 `handleFolderSelected`
 * 逐行搬出，仅去掉 React 状态写入。
 */
import { parseFrontmatterFields, stripRootPrefix } from "../frontmatter";
import type { BatchCandidate, PickedFiles } from "./types";

export type FolderSelection =
  | { kind: "single"; picked: NonNullable<PickedFiles> }
  | { kind: "batch"; candidates: BatchCandidate[]; parentName: string };

export async function readFolderSelection(files: File[]): Promise<FolderSelection> {
  const firstPath = files[0]?.webkitRelativePath || "";
  const rootName = firstPath.split("/")[0] || "";

  // Check if root directory directly has SKILL.md (single skill import)
  const rootSkillFile = files.find(f => {
    const rel = f.webkitRelativePath || f.name;
    return stripRootPrefix(rel, rootName) === "SKILL.md";
  });

  if (rootSkillFile) {
    // Single skill — existing flow
    const manifest: { relativePath: string; size: number }[] = files.map(f => {
      const rel = f.webkitRelativePath || f.name;
      return { relativePath: stripRootPrefix(rel, rootName), size: f.size };
    });
    const skillMd = await rootSkillFile.text();
    return { kind: "single", picked: { rootName, files, manifest, skillMd } };
  }

  // No root SKILL.md — check subdirectories for batch mode
  const subDirMap = new Map<string, File[]>();
  for (const f of files) {
    const rel = f.webkitRelativePath || f.name;
    const stripped = stripRootPrefix(rel, rootName);
    const firstSeg = stripped.split("/")[0];
    if (!firstSeg || !stripped.includes("/")) continue;
    if (!subDirMap.has(firstSeg)) subDirMap.set(firstSeg, []);
    subDirMap.get(firstSeg)!.push(f);
  }

  const candidates: BatchCandidate[] = [];
  for (const [folderName, folderFiles] of subDirMap) {
    const skillFile = folderFiles.find(f => {
      const rel = f.webkitRelativePath || f.name;
      const prefix = rootName ? rootName + "/" + folderName : folderName;
      return stripRootPrefix(rel, prefix) === "SKILL.md";
    });

    let name: string | null = null;
    let description: string | null = null;
    if (skillFile) {
      const content = await skillFile.text();
      const parsed = parseFrontmatterFields(content);
      name = parsed.name;
      description = parsed.description;
    }

    candidates.push({
      folderName,
      hasSkillMd: !!skillFile,
      name,
      description,
      fileCount: folderFiles.length,
      totalSize: folderFiles.reduce((acc, f) => acc + f.size, 0),
      files: folderFiles,
    });
  }

  candidates.sort((a, b) => {
    if (a.hasSkillMd !== b.hasSkillMd) return a.hasSkillMd ? -1 : 1;
    return a.folderName.localeCompare(b.folderName);
  });

  return { kind: "batch", candidates, parentName: rootName };
}
