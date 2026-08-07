/**
 * 判例全文检索模块（case-law）。
 *
 * 数据源：外接 knowledge.db（documents/chunks/docs_fts），经 SATI_CASE_DB 或默认目录接入。
 * 提供 CaseLawSearchEngine（FTS5 BM25 优先 + LIKE 降级）、CaseLawMemoryProvider
 * （判例自动注入 <memory-context>）、FTS+语义融合函数与类型契约。
 */

export { CaseLawSearchEngine, type CaseLawSemanticSource } from "./case-law-search.js";
export { CaseLawMemoryProvider, type CaseLawMemoryProviderOptions } from "./case-law-memory-provider.js";
export { fuseCaseLawHits } from "./rrf.js";
export type { CaseLawChunk, CaseLawDocType, CaseLawHit, CaseLawRecord, CaseLawSearchOptions } from "./types.js";
