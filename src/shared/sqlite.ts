/**
 * SQLite 动态 SQL prepare 缓存（#24 审查去重：legal/case-law/team-db 四处
 * 逐字相同的 prepareCached 收敛于此）。
 *
 * 同形状 SQL 复用 StatementSync：prepared statement 编译含词法分析 + 查询
 * 规划，热路径反复 prepare 浪费。缓存由调用方持有（生命周期跟随其 db 连接），
 * 本函数只查/建/存，不负责清空——调用方 close() 时须同步 clear，否则
 * db.close 后 StatementSync 悬空。
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";

export function prepareCached(cache: Map<string, StatementSync>, db: DatabaseSync, sql: string): StatementSync {
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}
