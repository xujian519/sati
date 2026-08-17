// dream-review 的审查判定/校验器（从 dream-review.ts 拆出，G6 聚类，逐字搬移）。
// validateExclusiveClusters 的正则表是 LLM 输出硬过滤（改一行即改行为）；
// selectUserNoteWindow 的预算语义保证超大笔记不饿死窗口。
import type { LlmDreamCluster, LlmGeneralProjectMetaMergeGroup } from "../skills/llm-extraction.js";
import type { MemoryFileRecord, ProjectMetaRecord } from "../types.js";
import { DREAM_USER_NOTE_CHAR_BUDGET, DREAM_USER_NOTE_MAX_FILES } from "./dream-types.js";
import { normalizeWhitespace } from "./dream-detail.js";

function validateExclusiveClusters(
  clusters: LlmDreamCluster[],
  allowedRelativePaths: ReadonlySet<string>,
  maxFiles: number,
): {
  clusters: LlmDreamCluster[];
  droppedWarnings: string[];
} {
  const used = new Set<string>();
  const accepted: LlmDreamCluster[] = [];
  const droppedWarnings: string[] = [];
  const sameProjectReasonPatterns = [
    /same current project/i,
    /same project/i,
    /same workspace/i,
    /belong to the same project/i,
    /all .*same project/i,
    /同一个项目/,
    /同一项目/,
    /都属于同一个项目/,
    /都属于同一项目/,
    /同属.*项目/,
    /属于当前项目/,
    /同一个工作区/,
  ];
  const semanticReasonPatterns = [
    /overlap/i,
    /overlapping/i,
    /duplicate/i,
    /duplicated/i,
    /redundant/i,
    /redundancy/i,
    /conflict/i,
    /conflicting/i,
    /inconsistent/i,
    /merge/i,
    /consolidat/i,
    /same rule/i,
    /same constraint/i,
    /same risk/i,
    /same blocker/i,
    /same goal/i,
    /same stage/i,
    /same definition/i,
    /same style/i,
    /same audience/i,
    /重复/,
    /冗余/,
    /冲突/,
    /重叠/,
    /可合并/,
    /可统一/,
    /内容重合/,
    /语义重合/,
    /事实重合/,
    /相同规则/,
    /相同约束/,
    /相同风险/,
    /相同阻塞/,
    /相同目标/,
    /相同阶段/,
    /相同定义/,
    /相同风格/,
    /相同受众/,
  ];
  const isGenericSameProjectReason = (reason: string): boolean => {
    const normalized = normalizeWhitespace(reason);
    if (!normalized) return false;
    return (
      sameProjectReasonPatterns.some(pattern => pattern.test(normalized)) &&
      !semanticReasonPatterns.some(pattern => pattern.test(normalized))
    );
  };
  for (const cluster of clusters) {
    const uniqueMembers = Array.from(
      new Set(
        cluster.memberRelativePaths
          .map(item => normalizeWhitespace(item))
          .filter(item => item && allowedRelativePaths.has(item)),
      ),
    );
    if (uniqueMembers.length < 2) {
      droppedWarnings.push(
        `Dropped cluster because it had fewer than 2 valid files: ${cluster.reason || uniqueMembers.join(", ")}`,
      );
      continue;
    }
    if (uniqueMembers.length > maxFiles) {
      droppedWarnings.push(
        `Dropped cluster because it exceeded the ${maxFiles}-file limit: ${uniqueMembers.join(", ")}`,
      );
      continue;
    }
    if (uniqueMembers.some(item => used.has(item))) {
      droppedWarnings.push(`Dropped overlapping cluster: ${uniqueMembers.join(", ")}`);
      continue;
    }
    if (isGenericSameProjectReason(cluster.reason)) {
      droppedWarnings.push(
        `Dropped low-quality cluster because the reason only referenced same-project membership without concrete overlap/conflict: ${uniqueMembers.join(", ")}`,
      );
      continue;
    }
    uniqueMembers.forEach(item => used.add(item));
    accepted.push({
      memberRelativePaths: uniqueMembers,
      reason: cluster.reason,
    });
  }
  return { clusters: accepted, droppedWarnings };
}

function selectUserNoteWindow(records: MemoryFileRecord[]): {
  selectedRecords: MemoryFileRecord[];
  selectedChars: number;
  keptRecords: MemoryFileRecord[];
} {
  const sorted = [...records].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
    return left.relativePath.localeCompare(right.relativePath);
  });
  const selected: MemoryFileRecord[] = [];
  let chars = 0;
  for (const record of sorted) {
    if (selected.length >= DREAM_USER_NOTE_MAX_FILES) break;
    const nextChars = chars + record.content.length;
    if (nextChars > DREAM_USER_NOTE_CHAR_BUDGET) {
      // A single oversized newest note must not starve the whole window:
      // skip it and keep filling with older notes that fit the budget.
      // (The oversized note stays in keptRecords and is not deleted.)
      continue;
    }
    selected.push(record);
    chars = nextChars;
  }
  const selectedIds = new Set(selected.map(record => record.relativePath));
  return {
    selectedRecords: selected,
    selectedChars: chars,
    keptRecords: sorted.filter(record => !selectedIds.has(record.relativePath)),
  };
}

function validateGeneralProjectMergeGroups(input: {
  metas: ProjectMetaRecord[];
  groups: LlmGeneralProjectMetaMergeGroup[];
}): { acceptedGroups: LlmGeneralProjectMetaMergeGroup[]; droppedWarnings: string[] } {
  const projectById = new Map(input.metas.map(meta => [meta.projectId, meta] as const));
  const usedProjectIds = new Set<string>();
  const acceptedGroups: LlmGeneralProjectMetaMergeGroup[] = [];
  const droppedWarnings: string[] = [];

  for (const [index, group] of input.groups.entries()) {
    const groupLabel = `group ${index + 1}`;
    const keeperProjectId = normalizeWhitespace(group.keeperProjectId);
    const duplicateProjectIds = Array.from(
      new Set(group.duplicateProjectIds.map(projectId => normalizeWhitespace(projectId)).filter(Boolean)),
    );
    if (!projectById.has(keeperProjectId)) {
      droppedWarnings.push(`Dropped ${groupLabel}: unknown keeper project id ${keeperProjectId || "(empty)"}.`);
      continue;
    }
    const unknownDuplicate = duplicateProjectIds.find(projectId => !projectById.has(projectId));
    if (unknownDuplicate) {
      droppedWarnings.push(`Dropped ${groupLabel}: unknown duplicate project id ${unknownDuplicate}.`);
      continue;
    }
    if (duplicateProjectIds.includes(keeperProjectId)) {
      droppedWarnings.push(`Dropped ${groupLabel}: keeper project id was also listed as a duplicate.`);
      continue;
    }
    if (duplicateProjectIds.length === 0) {
      droppedWarnings.push(`Dropped ${groupLabel}: no duplicate project ids were supplied.`);
      continue;
    }
    const allProjectIds = [keeperProjectId, ...duplicateProjectIds];
    const reusedProjectId = allProjectIds.find(projectId => usedProjectIds.has(projectId));
    if (reusedProjectId) {
      droppedWarnings.push(
        `Dropped ${groupLabel}: project id ${reusedProjectId} was already used in another merge group.`,
      );
      continue;
    }
    allProjectIds.forEach(projectId => usedProjectIds.add(projectId));
    acceptedGroups.push({
      keeperProjectId,
      duplicateProjectIds,
      reason: group.reason || "Model identified these project metas as duplicates.",
    });
  }

  return { acceptedGroups, droppedWarnings };
}

export { selectUserNoteWindow, validateExclusiveClusters, validateGeneralProjectMergeGroups };
