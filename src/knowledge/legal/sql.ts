/**
 * src/knowledge/legal — 法律检索 SQL 常量与动态构建。
 *
 * 从 legal-search.ts 拆出（A5 轮次 3）：列选择常量 + level/category 过滤动态
 * SQL 构建，消除 searchFts / searchFtsKeywords 的重复 SQL（此前各自复制一段
 * 23 行语句，仅 MATCH 参数不同）。
 */

/** 基础列（无 fts_rank；law + category 联查）。 */
export const LAW_SEARCH_COLUMNS = `l.id, l.level, l.name, l.filename, l.publish, l.expired, l.category_id, l.subtitle, l.valid_from, l.content, c.name AS category_name`;

/** FTS 路径列（追加 bm25 分数）。 */
export const LAW_SEARCH_COLUMNS_FTS = `${LAW_SEARCH_COLUMNS}, bm25(law_fts) AS fts_rank`;

export type LawSearchFilter = { level?: string; category?: string };

function buildFilterClauses(filter: LawSearchFilter): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.level) {
    clauses.push("AND l.level = ?");
    params.push(filter.level);
  }
  if (filter.category) {
    clauses.push("AND c.name = ?");
    params.push(filter.category);
  }
  return { sql: clauses.join(" "), params };
}

/**
 * 动态 SQL 构建（带 level/category 过滤；无过滤走热路径 prepared statements）。
 *
 * 占位符顺序约定：
 * - fts：MATCH ? 在最前，过滤条件随后，LIMIT ? 在最后（调用方传
 *   `[matchExpr, ...params, limit]`）；
 * - like：name/content 两个 ? 在最前，过滤条件随后，LIMIT ? 在最后（调用方传
 *   `[pattern, pattern, ...params, limit]`）。
 */
export function buildLawSearchSql(kind: "fts" | "like", filter: LawSearchFilter): { sql: string; params: string[] } {
  const { sql: filterSql, params: filterParams } = buildFilterClauses(filter);
  if (kind === "fts") {
    return {
      sql: `SELECT ${LAW_SEARCH_COLUMNS_FTS}
        FROM law_fts
        JOIN law l ON l.name = law_fts.name
        JOIN category c ON c.id = l.category_id
        WHERE law_fts MATCH ?
          AND (l.expired = 0 OR l.expired IS NULL)
          ${filterSql}
        ORDER BY l.publish DESC, bm25(law_fts) LIMIT ?`,
      params: filterParams,
    };
  }
  return {
    sql: `SELECT ${LAW_SEARCH_COLUMNS}
      FROM law l
      JOIN category c ON c.id = l.category_id
      WHERE (l.name LIKE ? ESCAPE '\\' OR l.content LIKE ? ESCAPE '\\')
        AND (l.expired = 0 OR l.expired IS NULL)
        ${filterSql}
      ORDER BY l.publish DESC, l."order" LIMIT ?`,
    params: filterParams,
  };
}
