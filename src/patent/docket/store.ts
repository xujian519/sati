/**
 * 案卷（docket）持久化与版本留档（P0-1）。
 *
 * - JsonFileDocketStore：复用 persist-utils 的 JsonFileStore（与
 *   JsonFileFlexiblePlanStore 同款原子写 + 安全 id 校验），每案卷一个 JSON 文件。
 * - archiveRevision：修订轮次的阶段产物归档——旧稿不动、每轮另存
 *   `revisions/round-N/`（对齐竞品 patent-disclosure-skill 的 merger 留档语义：
 *   迭代按轮次另存新文件，修订记录独立留档）。幂等：同轮重放直接覆盖。
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, JsonFileStore, SAFE_ID_PATTERN } from "../persist-utils.js";
import { DocketError, docketFromJSON, type DocketState } from "./state.js";

export interface DocketStore {
  saveDocket(state: DocketState): Promise<void>;
  loadDocket(caseId: string): Promise<DocketState | undefined>;
  listCaseIds(): Promise<string[]>;
}

/** JSON 文件存储——每案卷一个文件，位于同一目录下。 */
export class JsonFileDocketStore implements DocketStore {
  private readonly store: JsonFileStore<DocketState>;

  constructor(dir: string) {
    this.store = new JsonFileStore(dir, docketFromJSON, "caseId");
  }

  async saveDocket(state: DocketState): Promise<void> {
    await this.store.save(state.caseId, state);
  }

  async loadDocket(caseId: string): Promise<DocketState | undefined> {
    return this.store.load(caseId);
  }

  async listCaseIds(): Promise<string[]> {
    return this.store.listIds();
  }
}

export type ArchiveRevisionInput = {
  caseId: string;
  round: number;
  /** 本轮修订记录（recordRevision 刚写入的那一条）。 */
  revision: { round: number; at: string; answered: string[]; notes?: string };
  /** 阶段产物：name → 文本内容（name 仅做展示与文件命名清洗）。 */
  artifacts: Array<{ name: string; content: string }>;
  /** 案卷目录（dockets 根，归档写 `<docketsDir>/revisions/<caseId>/round-N/`）。 */
  docketsDir: string;
};

/** 清洗产物文件名：只保留安全字符集，空结果退回 artifact-N。 */
function safeArtifactName(name: string, index: number): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return cleaned === "" ? `artifact-${index}` : cleaned.slice(0, 120);
}

/**
 * 归档一轮修订：写 `<docketsDir>/revisions/<caseId>/round-N/`，
 * 含 revision.json（本轮元数据）与各产物文件。返回归档目录路径。
 * 不做删除动作（旧轮次与计划产物保持原样）。
 */
export async function archiveRevision(input: ArchiveRevisionInput): Promise<string> {
  if (!SAFE_ID_PATTERN.test(input.caseId)) {
    throw new DocketError(`archiveRevision: caseId ${JSON.stringify(input.caseId)} 含非法字符`);
  }
  if (!Number.isInteger(input.round) || input.round < 1) {
    throw new DocketError(`archiveRevision: round 非法（${String(input.round)}）`);
  }
  if (input.revision.round !== input.round) {
    throw new DocketError(`archiveRevision: revision.round(${input.revision.round}) 与归档轮次(${input.round}) 不一致`);
  }
  const dir = join(input.docketsDir, "revisions", input.caseId, `round-${input.round}`);
  await mkdir(dir, { recursive: true });
  const files: Array<{ name: string; content: string }> = [
    {
      name: "revision.json",
      content: JSON.stringify(
        { ...input.revision, archivedArtifacts: input.artifacts.map((a, i) => safeArtifactName(a.name, i)) },
        null,
        2,
      ),
    },
    ...input.artifacts.map((a, i) => ({ name: safeArtifactName(a.name, i), content: a.content })),
  ];
  // 同名清洗结果相撞时追加序号，避免静默互相覆盖（扩展名保留）。
  const used = new Set<string>();
  for (const file of files) {
    let name = file.name;
    if (used.has(name)) {
      const dot = name.lastIndexOf(".");
      const ext = dot > 0 ? name.slice(dot) : "";
      const stem = dot > 0 ? name.slice(0, dot) : name;
      name = `${stem}-${used.size}${ext}`;
    }
    used.add(name);
    await atomicWriteJson(join(dir, name), file.content);
  }
  return dir;
}
