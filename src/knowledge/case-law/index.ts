/**
 * 判例全文检索模块（case-law）。
 *
 * 数据源：外接 knowledge.db（documents/chunks/docs_fts），经 SATI_CASE_DB 或默认目录接入。
 * 提供 CaseLawSearchEngine（FTS5 BM25 优先 + LIKE 降级）与类型契约。
 */

export { CaseLawSearchEngine } from "./case-law-search.js";
export type { CaseLawChunk, CaseLawDocType, CaseLawHit, CaseLawRecord, CaseLawSearchOptions } from "./types.js";
