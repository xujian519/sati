/**
 * 判例全文检索（case-law）类型契约。
 *
 * 数据源为外接 knowledge.db（documents/chunks/docs_fts 表）：
 * - documents：判例元数据（doc_type=case 无效复审决定 / judgment 专利判决，含决定号/案号/法院）
 * - chunks：全文分块（docs_fts 的 rowid 即 chunks.id，contentless FTS 需 JOIN chunks 取正文）
 */

/** 判例文档类型：case=无效复审决定，judgment=专利判决。 */
export type CaseLawDocType = "case" | "judgment";

/** 判例元数据（documents 表行）。 */
export type CaseLawRecord = {
  documentId: string;
  docType: string;
  title: string;
  /** 无效决定号（如 566693；仅 case 通常有值）。 */
  decisionNumber?: string;
  /** 案号（如 008073341；仅 case 通常有值）。 */
  caseNumber?: string;
  /** 审理法院（仅 judgment 通常有值）。 */
  court?: string;
  source?: string;
  module?: string;
  charCount: number;
};

/** 判例检索命中（含命中 chunk 片段与命中方式）。 */
export type CaseLawHit = CaseLawRecord & {
  chunkIndex: number;
  /** 命中 chunk 正文片段（工具层负责截断）。 */
  snippet: string;
  /** FTS5 BM25 分数（负值，越大越相关；仅 fts 路径有值）。 */
  ftsRank?: number | null;
  /** 命中方式：fts=FTS5 BM25 命中，like=LIKE 降级命中。 */
  via: "fts" | "like";
};

/** 判例全文分块（按 documents.id 取回；不经过检索，无 via/ftsRank 语义）。 */
export type CaseLawChunk = {
  documentId: string;
  chunkIndex: number;
  /** 分块正文。 */
  content: string;
};

export type CaseLawSearchOptions = {
  /** 返回判例条数上限（默认 5，最大 10）。 */
  limit?: number;
  /** 按文档类型过滤（case=无效决定，judgment=判决）。 */
  docType?: CaseLawDocType;
  /** 按审理法院过滤（子串匹配；judgment 生效）。 */
  court?: string;
  /** 排除指定来源的文档（如 "wiki" 排除审查标准卡片，仅保留 raw 判例全文）。 */
  excludeSource?: string;
};
