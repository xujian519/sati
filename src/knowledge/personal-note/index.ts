/**
 * personal_note 语义召回模块。
 *
 * 让 `knowledge_note_save` 沉淀的项目笔记（OA 答复要点等）可被语义检索召回，
 * 补齐"产出反哺知识"的语义路（此前仅 FTS 关键词路覆盖）。
 *
 * 对外提供进程级单例工厂 getOrCreatePersonalNoteIndex：组装层
 * （buildKnowledgeResolvers，供 CaseLawMemoryProvider 自动注入）与工具侧
 * （patent_case_search，供显式检索）共享同一索引实例，避免重复 embed 与
 * JSONL 并发写。
 */

import type { EmbeddingClient } from "../../model/embedding/types.js";
import { PersonalNoteStore } from "./personal-note-store.js";
import { PersonalNoteVectorIndex } from "./personal-note-vector-index.js";

export { PersonalNoteStore, type PersonalNoteRow } from "./personal-note-store.js";
export { PersonalNoteVectorIndex, type PersonalNoteVectorIndexOptions } from "./personal-note-vector-index.js";

export type GetOrCreatePersonalNoteIndexOptions = {
  /** knowledge.db 路径（personal_note 数据源）。 */
  dbPath: string;
  /** 语义检索客户端（memory.embedding 解析产物）。 */
  client: EmbeddingClient;
  /** 向量持久化文件（默认建议 {embeddingDir}/personal-note.jsonl）。 */
  storePath: string;
  logger?: { warn?: (...args: unknown[]) => void };
};

// 进程级单例：按 `dbPath|storePath` 复用同一索引（含 store 只读连接与 JSONL
// 持久化句柄）。键同时含 storePath：不同数据源（SATI_CASE_DB 分离场景）即使
// 误传同一 storePath 也不会互相擦写同一 JSONL。
const instanceCache = new Map<string, PersonalNoteVectorIndex>();

/**
 * 获取或创建 personal_note 语义索引（按 dbPath|storePath 单例）。
 * 数据源打开失败时抛出，由调用方 catch 降级（语义路关闭，关键词路不受影响）。
 */
export function getOrCreatePersonalNoteIndex(options: GetOrCreatePersonalNoteIndexOptions): PersonalNoteVectorIndex {
  const cacheKey = `${options.dbPath}::${options.storePath}`;
  const existing = instanceCache.get(cacheKey);
  if (existing) return existing;
  const store = new PersonalNoteStore(options.dbPath);
  const index = new PersonalNoteVectorIndex({
    store,
    client: options.client,
    storePath: options.storePath,
    logger: options.logger,
  });
  instanceCache.set(cacheKey, index);
  return index;
}
