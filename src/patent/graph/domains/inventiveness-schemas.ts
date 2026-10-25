/**
 * 创造性分析子图的 JSON Schema 常量（#725 / W-07）。
 *
 * 从 inventiveness.ts 拆出：Schema 与图拓扑解耦，可被其他模块（测试/文档）
 * 独立引用；节点装配在 inventiveness-nodes.ts，提示词在 inventiveness-prompts.ts。
 */

export const PARSE_SCHEMA = {
  type: "object",
  properties: {
    features: { type: "array", items: { type: "string" }, description: "技术特征" },
    field: { type: "string", description: "所属技术领域" },
    priority_date: { type: "string", description: "优先权日（如提供；优先于申请日作为时间基准）" },
    filing_date: { type: "string", description: "申请日（如提供）" },
    inventor_claimed_effect: { type: "string", description: "发明声称的技术效果" },
  },
  required: ["features", "field"],
} as const;

export const CLOSEST_SCHEMA = {
  type: "object",
  properties: {
    document: { type: "string", description: "最接近现有技术（对比文件）标识" },
    technical_field: { type: "string", description: "技术领域" },
    disclosed_features: { type: "array", items: { type: "string" }, description: "已公开特征" },
    rationale: { type: "string", description: "选择理由（领域/问题/公开特征最多）" },
  },
  required: ["document", "rationale"],
} as const;

export const DIFF_SCHEMA = {
  type: "object",
  properties: {
    distinguishing_features: { type: "array", items: { type: "string" }, description: "区别技术特征" },
    actual_technical_problem: { type: "string", description: "实际解决的技术问题（不得含解决手段）" },
    effect_of_diff: { type: "string", description: "区别特征带来的技术效果" },
  },
  required: ["distinguishing_features", "actual_technical_problem"],
} as const;

export const HINT_SCHEMA = {
  type: "object",
  properties: {
    obvious: { type: "boolean", description: "是否显而易见" },
    motivation: { type: "string", description: "技术启示（改进动机/结合启示/公知常识/有限试验）" },
    evidence: { type: "array", items: { type: "string" }, description: "启示证据" },
    dissenting_factors: { type: "array", items: { type: "string" }, description: "反面因素（反向教导/技术障碍）" },
  },
  required: ["obvious", "motivation"],
} as const;

export const SECONDARY_SCHEMA = {
  type: "object",
  properties: {
    unexpected_effect: { type: "string", description: "预料不到的技术效果（量化数据）" },
    long_felt_need: { type: "string", description: "长期渴望解决的技术问题" },
    technical_prejudice: { type: "string", description: "技术偏见克服" },
    commercial_success: { type: "string", description: "商业成功（如有）" },
  },
} as const;

export const CONCLUDE_SCHEMA = {
  type: "object",
  properties: {
    inventive: { type: "boolean", description: "是否具备创造性" },
    confidence: { type: "string", description: "high/medium/low" },
    key_rationale: { type: "string", description: "核心理由" },
    report: { type: "string", description: "完整三步法分析报告" },
  },
  required: ["inventive", "confidence", "key_rationale", "report"],
} as const;

export const RECALL_SCHEMA = {
  type: "object",
  properties: {
    adequate: { type: "boolean", description: "检索结果是否足以支撑创造性判断（至少覆盖核心技术特征）" },
    covered_features: { type: "array", items: { type: "string" }, description: "已被检索结果覆盖的技术特征" },
    missing_features: { type: "array", items: { type: "string" }, description: "未被覆盖的关键技术特征（补检依据）" },
  },
  required: ["adequate", "covered_features", "missing_features"],
} as const;

export const COMBINATION_SCHEMA = {
  type: "object",
  properties: {
    candidate_documents: {
      type: "array",
      items: { type: "string" },
      description: "可与 D1 结合的候选对比文件标识（文档号）",
    },
    combinable: { type: "boolean", description: "是否存在与 D1 结合以覆盖区别特征的技术启示" },
    motivation: { type: "string", description: "结合动机/技术启示（改进动机/结合启示/公知常识）" },
    obstacles: { type: "array", items: { type: "string" }, description: "结合的技术障碍" },
    teaching_away: { type: "boolean", description: "是否存在反向教导" },
  },
  required: ["candidate_documents", "combinable", "motivation", "obstacles", "teaching_away"],
} as const;
