/**
 * 专利代理人考试评测集类型定义。
 *
 * JSON fixture 由 Mady 仓库 cmd/export-benchmark 导出，本文件中的字段与其
 * 一一对应（camelCase）。数据源：2007-2019 全国专利代理人资格考试《专利代理
 * 实务》真题 + 结构化模拟题 + 真实 CNIPA 无效宣告请求审查决定书。
 */

/** 单条评测用例。 */
export interface PatentExamCase {
  /** 全局唯一 ID，如 "patent_exam_001" / "patent_exam_2009_a2_02" / "invalidation_decision_001"。 */
  id: string;
  /** 业务域，当前数据集全部为 "patent"。 */
  domain: string;
  /** 题目输入（含背景、权利要求书、对比文件等）。 */
  input: string;
  /** 参考答案（真题官方要点 / 参考质量答案）。 */
  expected: string;
  /** 输出中必须出现的法条引文，如 "第二十二条第二款"。 */
  requiredCitations?: string[];
  /** 时间分片标记（如 "pre_2020" / "post_2020"），用于时间分割评估。 */
  era?: string;
  /** 知识截止时间（RFC3339），运行时应限制只使用此时间前的检索数据。 */
  knowledgeCutoff?: string;
  /** 难度标记："easy" | "medium" | "hard"。 */
  difficulty?: string;
}

/** 单个 suite 的 fixture 文件结构。 */
export interface PatentExamFixture {
  suite: string;
  description?: string;
  source: string;
  generatedAt: string;
  caseCount: number;
  cases: PatentExamCase[];
}

/** fixtures/index.json 结构：全部 suite 与用例汇总。 */
export interface BenchmarkIndex {
  generatedAt: string;
  source: string;
  totalCases: number;
  suites: { suite: string; caseCount: number }[];
}

/**
 * 专利代理机构的真实业务类型。由 scripts/patent-benchmark-business.ts 将
 * 原始（考试口径）用例归类到这些业务之下。
 */
export type BusinessTask =
  | "patentability_analysis" // 可专利性分析：新颖性/创造性/客体等授权要件评估
  | "drafting" // 申请文件撰写：权利要求书/说明书
  | "file_review" // 申请文件审查：充分公开/支持/清楚/单一性/修改超范围
  | "oa_response" // 审查意见答复：分析成立性 + 修改方案 + 答复意见
  | "infringement_analysis" // 侵权判定：全面覆盖/等同/抗辩
  | "invalidation" // 无效宣告：请求方案/专利权人答辩/决定分析
  | "prior_art_search" // 现有技术检索（当前数据集未覆盖，预留）
  | "disclosure_analysis"; // 技术交底书分析/专利挖掘（当前数据集未覆盖，预留）

/** 委托方身份，决定无效宣告等业务的立场与文书口径。 */
export type ClientRole =
  | "专利申请客户"
  | "发明人客户"
  | "无效请求人客户"
  | "专利权人客户"
  | "企业客户"
  | "企业客户（决定分析）";

/** 业务化用例：在原始用例之上附加业务口径字段。 */
export interface BusinessPatentExamCase extends PatentExamCase {
  /** 所属业务类型。 */
  businessTask: BusinessTask;
  /** 委托方身份。 */
  clientRole: ClientRole;
  /** 本用例要求交付的成果物。 */
  deliverable: string;
  /** 原始 suite（Mady 导出目录中的 suite 名），保留溯源。 */
  sourceSuite: string;
}

/** 业务化 suite 的 fixture 文件结构。 */
export interface BusinessPatentExamFixture extends Omit<PatentExamFixture, "cases"> {
  cases: BusinessPatentExamCase[];
}
