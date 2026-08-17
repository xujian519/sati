// dream-review 的 LLM 数据映射（从 dream-review.ts 拆出，G5 聚类，逐字搬移）。
// 输入/输出数据的形状映射，纯函数（toDreamRecordInput 依赖注入的 store）。
import type {
  LlmDreamClusterHeaderInput,
  LlmDreamFileProjectMetaInput,
  LlmDreamFileRecordInput,
} from "../skills/llm-extraction.js";
import type { MemoryCandidate, MemoryFileRecord, MemoryManifestEntry, ProjectMetaRecord } from "../types.js";
import type { FileMemoryStore } from "../file-memory.js";

function toDreamMetaInput(meta: ProjectMetaRecord): LlmDreamFileProjectMetaInput {
  return {
    projectId: meta.projectId,
    projectName: meta.projectName,
    description: meta.description,
    status: meta.status,
    updatedAt: meta.updatedAt,
    ...(meta.dreamUpdatedAt ? { dreamUpdatedAt: meta.dreamUpdatedAt } : {}),
    ...(meta.sourceKind ? { sourceKind: meta.sourceKind } : {}),
    ...(meta.sourceWorkspacePath ? { sourceWorkspacePath: meta.sourceWorkspacePath } : {}),
    ...(meta.sourceProjectId ? { sourceProjectId: meta.sourceProjectId } : {}),
  };
}

function toDreamRecordInput(store: FileMemoryStore, record: MemoryFileRecord): LlmDreamFileRecordInput {
  const candidate = store.toCandidate(record);
  return {
    entryId: record.relativePath,
    relativePath: record.relativePath,
    type: record.type === "feedback" ? "feedback" : "project",
    scope: "project",
    projectId: record.projectId,
    isTmp: false,
    name: record.name,
    description: record.description,
    updatedAt: record.updatedAt,
    ...(record.capturedAt ? { capturedAt: record.capturedAt } : {}),
    ...(record.sourceSessionKey ? { sourceSessionKey: record.sourceSessionKey } : {}),
    content: record.content,
    ...(candidate.type === "project"
      ? {
          project: {
            stage: candidate.stage ?? "",
            decisions: candidate.decisions ?? [],
            constraints: candidate.constraints ?? [],
            nextSteps: candidate.nextSteps ?? [],
            blockers: candidate.blockers ?? [],
            timeline: candidate.timeline ?? [],
            notes: candidate.notes ?? [],
          },
        }
      : {}),
    ...(candidate.type === "feedback"
      ? {
          feedback: {
            rule: candidate.rule ?? "",
            why: candidate.why ?? "",
            howToApply: candidate.howToApply ?? "",
            notes: candidate.notes ?? [],
          },
        }
      : {}),
  };
}

function toHeaderInput(entry: MemoryManifestEntry): LlmDreamClusterHeaderInput {
  return {
    relativePath: entry.relativePath,
    name: entry.name,
    description: entry.description,
    updatedAt: entry.updatedAt,
  };
}

function toRefinedCandidate(input: {
  kind: "project" | "feedback";
  name: string;
  description: string;
  markdown: string;
  sourceRecord: MemoryFileRecord;
}): MemoryCandidate {
  return {
    type: input.kind,
    scope: "project",
    name: input.name,
    description: input.description,
    body: `${input.markdown.trim()}\n`,
    ...(input.sourceRecord.capturedAt ? { capturedAt: input.sourceRecord.capturedAt } : {}),
    ...(input.sourceRecord.sourceSessionKey ? { sourceSessionKey: input.sourceRecord.sourceSessionKey } : {}),
  };
}

export { toDreamMetaInput, toDreamRecordInput, toHeaderInput, toRefinedCandidate };
