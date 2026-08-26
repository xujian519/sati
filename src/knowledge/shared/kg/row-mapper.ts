/**
 * src/knowledge/shared/kg — 图谱行映射纯函数。
 *
 * 从 kg-store.ts 拆出（轮次 1 纯搬移）：行类型 + 行 → KgNode 映射 + law_refs
 * 计数解析，零 DB 依赖，可独立单测。
 */

import type { KgNode } from "../../patent/types.js";

/** 单条 FTS5 命中（nodes_fts 返回原始行）。 */
export type FtsHit = {
  id: string;
  name: string | null;
  title: string | null;
};

/** 节点行（列集随 schema 变化：unified 有 law_refs JSON，legacy 有 law_refs_count + version）。 */
export type NodeRow = {
  id: string;
  node_type: string | null;
  name: string | null;
  title: string | null;
  content: string | null;
  /** unified schema：law_refs JSON 文本数组。 */
  law_refs?: string | null;
  /** legacy schema：law_refs_count 整数。 */
  law_refs_count?: number | null;
  source: string | null;
  full_ref: string | null;
  chapter: string | null;
  article_number: string | null;
  version?: string | null;
};

/** 行 → KgNode 映射（unified: law_refs JSON 解析；legacy: law_refs_count + version）。 */
export function toNode(row: NodeRow): KgNode {
  return {
    id: row.id,
    nodeType: row.node_type ?? "",
    name: row.name ?? undefined,
    title: row.title ?? undefined,
    content: row.content ?? undefined,
    lawRefsCount: row.law_refs_count ?? (row.law_refs !== undefined ? parseLawRefsCount(row.law_refs) : undefined),
    source: row.source ?? undefined,
    fullRef: row.full_ref ?? undefined,
    chapter: row.chapter ?? undefined,
    articleNumber: row.article_number ?? undefined,
    version: row.version ?? undefined,
  };
}

/** knowledge.db kg_nodes.law_refs 为 TEXT JSON 数组；解析失败返回 undefined。 */
export function parseLawRefsCount(lawRefs: string | null): number | undefined {
  if (!lawRefs) return undefined;
  try {
    const parsed: unknown = JSON.parse(lawRefs);
    return Array.isArray(parsed) ? parsed.length : undefined;
  } catch {
    // law_refs 非合法 JSON 数组 → 返回 undefined（按无法解析处理）。
    return undefined;
  }
}
