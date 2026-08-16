/**
 * src/knowledge/shared/kg — 图谱 schema 探测与 prepared statements 组装。
 *
 * 从 kg-store.ts 拆出（A4 轮次 2）：表/列/FTS 探测 + 全部 prepared statements
 * 组装独立成纯探测模块，KgStore 构造器变薄。探测契约保留：
 * - fail-closed：kg_nodes/nodes 均不存在时抛错；
 * - FTS prepare 失败（旧 Node 无 FTS5/trigram）降级 null，不崩构造。
 */

import type { DatabaseSync, StatementSync } from "node:sqlite";

/** 生效 schema：unified=knowledge.db（kg_nodes），legacy=patent_kg.db（nodes）。 */
export type KgSchema = "unified" | "legacy";

/** 热路径 prepared statements（prepare 一次反复复用，避免每次执行重新编译 SQL）。 */
export type KgStoreStatements = {
  stmtGetNode: StatementSync;
  stmtLikeSearch: StatementSync;
  stmtFtsSearch: StatementSync | null;
  stmtNeighbors: StatementSync;
  stmtNeighborsByRelation: StatementSync;
  stmtListByType: StatementSync;
};

/** 探测结果：schema + FTS 表 + statements 集合。 */
export type KgStoreIntrospection = {
  schema: KgSchema;
  ftsTable: string | null;
  statements: KgStoreStatements;
};

/** 表是否存在于库中（sqlite_master 探测）。 */
function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) as
    | { name: string }
    | undefined;
  return row !== undefined;
}

export function introspectKgStore(db: DatabaseSync, dbPath: string): KgStoreIntrospection {
  // 表结构探测：knowledge.db 统一 schema（kg_nodes/kg_edges/kg_nodes_fts，trigram）
  // 优先；patent_kg.db 旧 schema（nodes/edges/nodes_fts*）兼容保留。
  const hasUnified = tableExists(db, "kg_nodes");
  const hasLegacy = tableExists(db, "nodes");
  if (!hasUnified && !hasLegacy) {
    throw new Error(`KgStore: 未找到知识图谱表（kg_nodes/nodes 均不存在），dbPath=${dbPath}`);
  }
  const schema: KgSchema = hasUnified ? "unified" : "legacy";
  const nodeTable = hasUnified ? "kg_nodes" : "nodes";

  const ftsRow = db
    .prepare(
      hasUnified
        ? "SELECT name FROM sqlite_master WHERE type='table' AND name = 'kg_nodes_fts' LIMIT 1"
        : "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('nodes_fts_trigram', 'nodes_fts') ORDER BY CASE name WHEN 'nodes_fts_trigram' THEN 0 ELSE 1 END LIMIT 1",
    )
    .get() as { name: string } | undefined;
  const ftsTable = ftsRow?.name ?? null;

  // unified: law_refs 为 TEXT JSON 数组（无 version）；legacy: law_refs_count 整数 + version。
  const nodeColumns = hasUnified
    ? "id, node_type, name, title, content, law_refs, source, full_ref, chapter, article_number"
    : "id, node_type, name, title, content, law_refs_count, source, full_ref, chapter, article_number, version";

  const stmtGetNode = db.prepare(`SELECT ${nodeColumns} FROM ${nodeTable} WHERE id = ?`);

  const stmtLikeSearch = db.prepare(
    `SELECT id FROM ${nodeTable}
     WHERE name LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
     LIMIT ?`,
  );
  // 知识库可能未建 FTS（或运行时 SQLite 未编译 FTS5/trigram——如桌面端捆绑
  // 旧 Node），prepare MATCH 会抛错：捕获后降级 LIKE（等价 legal-search 的
  // 能力探测语义），避免构造函数崩溃导致整个 KgStore 不可用。
  let stmtFtsSearch: StatementSync | null = null;
  if (ftsTable !== null) {
    try {
      // unified：kg_nodes_fts 为 contentless（列仅 name/title/content，内容不存储），
      // rowid 即 kg_nodes.rowid，须 JOIN 回源取 id/name/title。
      stmtFtsSearch = db.prepare(
        hasUnified
          ? "SELECT k.id, k.name, k.title FROM kg_nodes_fts f JOIN kg_nodes k ON k.rowid = f.rowid WHERE kg_nodes_fts MATCH ? LIMIT ?"
          : `SELECT id, name, title FROM ${ftsTable} WHERE ${ftsTable} MATCH ? LIMIT ?`,
      );
    } catch {
      stmtFtsSearch = null;
    }
  }
  const stmtNeighbors = db.prepare(
    hasUnified
      ? "SELECT target_id AS target, relation FROM kg_edges WHERE source_id = ? LIMIT ?"
      : "SELECT target, relation FROM edges WHERE source = ? LIMIT ?",
  );
  const stmtNeighborsByRelation = db.prepare(
    hasUnified
      ? "SELECT target_id AS target, relation FROM kg_edges WHERE source_id = ? AND relation = ? LIMIT ?"
      : "SELECT target, relation FROM edges WHERE source = ? AND relation = ? LIMIT ?",
  );
  const stmtListByType = db.prepare(`SELECT id FROM ${nodeTable} WHERE node_type = ? LIMIT ?`);

  return {
    schema,
    ftsTable,
    statements: {
      stmtGetNode,
      stmtLikeSearch,
      stmtFtsSearch,
      stmtNeighbors,
      stmtNeighborsByRelation,
      stmtListByType,
    },
  };
}
