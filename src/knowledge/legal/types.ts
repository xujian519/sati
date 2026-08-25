/**
 * legal 知识库类型定义。
 * 数据结构对齐宝宸知识库 Laws-1.0.0 / Mady laws-full.db（law + category 表）。
 */

/** 法律层级（law.level 字段取值）。 */
export type LawLevel = "法律" | "行政法规" | "司法解释" | "地方性法规" | "宪法" | "案例" | "部门规章" | "其他";

/** 法律效力状态（版本沿革标注；无版本元数据时缺省）。 */
export type LawStatus = "现行有效" | "已被修订" | "已废止" | "待核验";

/** 法律记录（对应 laws-full.db law 表 + category 表联查结果）。 */
export type LawRecord = {
  /** 主键，格式 "{名称}_{发布日期}" */
  id: string;
  /** 法律层级 */
  level: string;
  /** 法律名称（不含日期） */
  name: string;
  /** 原始文件名 */
  filename?: string;
  /** 发布日期 YYYY-MM-DD */
  publish?: string;
  /** 是否已失效（0=现行有效, 1=已失效） */
  expired: number;
  /** 分类外键 */
  categoryId: number;
  /** 副标题（如民法典各编名） */
  subtitle?: string;
  /** 施行日期 YYYY-MM-DD */
  validFrom?: string;
  /** 全文内容 */
  content?: string;
  /** 分类名称（联查 category.name） */
  categoryName?: string;
  /** 条款号（归一化，如 "第1条" / "第120条之一"；条款级命中且 chunk.heading 可解析时存在） */
  article?: string;
  /** 母条号（归一化，"第1条"；"第N条之M" 时子条号另存 subArticle） */
  articleBase?: string;
  /** 子条号（阿拉伯数字，"第120条之一" → "1"） */
  subArticle?: string;
  /** 效力状态（版本沿革标注，如 "现行有效"/"已被修订"/"已废止"/"待核验"；无版本元数据时缺省） */
  status?: LawStatus;
  /** 被哪一版取代（法律名 + 发布/施行日期，如 "中华人民共和国专利法（2020年修正）"；同名多版本命中时标注） */
  supersededBy?: string;
  /** 地方性法规标记（level==='地方性法规' 时 true；提示命中属地法规、需人工复核，不做硬删除） */
  localRegulation?: boolean;
  /** 来源置信度（0~1，按法律层级确定性派生：国家级上位法高、地方性法规低；为后续置信度标注打样） */
  sourceConfidence?: number;
};

/** 法律搜索命中结果。 */
export type LawSearchResult = LawRecord & {
  /** 相关性排序分数（BM25 rank，值越小越相关） */
  score: number;
  /** 命中片段（FTS5 snippet） */
  snippet?: string;
};

/** 法律分类（对应 laws-full.db category 表）。 */
export type LawCategory = {
  id: number;
  name: string;
  folder: string;
  isSubFolder: number;
  group?: string;
};

/** 法律检索源统一契约（LegalSearchEngine=laws-full.db / KnowledgeLawSearch=knowledge.db）。 */
export type LegalSearchSource = {
  /** FTS5 是否实际可用。 */
  readonly ftsAvailable: boolean;
  /** 全文搜索（FTS5 BM25 优先，短查询/无 FTS 降级 LIKE）。 */
  search(keyword: string, options?: { limit?: number; level?: string; category?: string }): LawSearchResult[];
  /** 按名称模糊查找。 */
  findByName(name: string, limit?: number): LawRecord[];
  /** 按主键精确查询。 */
  getById(id: string): LawRecord | undefined;
  /** 批量按主键查询。 */
  getByIds(ids: string[]): LawRecord[];
  /** 列出分类。 */
  getCategories(): LawCategory[];
  /** 统计总数（诊断用）。 */
  count(): number;
  close(): void;
};
