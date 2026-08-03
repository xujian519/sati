/**
 * src/patent/checker — 常量与数据资产。
 *
 * 纯数据模块（零依赖）：术语常量、域常量、权利要求维度、同义词扩展表、
 * 否定模式、单独对比禁止短语、维度关键词模式。引擎（engine.ts）与规则集
 * （core-rules.ts / reasoning-rules.ts）共同引用，避免常量散落在算法文件中。
 */
// =============================================================================
// 术语常量（规则定义引用；与 Mady rule_engine.go term* 常量对应）
// =============================================================================

export const TERM_NOVELTY = "新颖性";
export const TERM_INVENTIVENESS = "创造性";
export const TERM_PRIOR_ART_DOC = "对比文件";
export const TERM_PRIOR_ART = "现有技术";
export const TERM_TECH_FEATURE = "技术特征";
export const TERM_CLOSEST_PRIOR_ART_FULL = "最接近的现有技术";
export const TERM_CLOSEST_PRIOR_ART = "最接近对比文件";
export const TERM_DISTINGUISHING_FEATURES = "区别技术特征";
export const TERM_DIFF_FEATURES = "区别特征";
export const TERM_TECH_HINT = "技术启示";
export const TERM_COMBINATION_MOTIVATION = "组合动机";
export const TERM_COMBINATION_HINT = "结合启示";
export const TERM_SUFFICIENT_DISCLOSURE = "充分公开";
export const TERM_ENABLE = "能够实现";
export const TERM_ENABLEMENT = "enablement";
export const TERM_CAN_USE = "能够使用";
export const TERM_TECH_EFFECT = "技术效果";
export const TERM_TECH_SOLUTION = "技术方案";
export const TERM_DESIGN_PATENT = "外观设计";
export const TERM_PRIORITY_DATE = "优先权日";
export const TERM_PRIORITY = "优先权";
export const TERM_FILING_DATE = "申请日";
export const TERM_SCI_DISCOVERY = "科学发现";
export const TERM_COMMON_KNOWLEDGE = "公知常识";
export const TERM_OBVIOUS = "显而易见";
export const TERM_USE_LIMIT = "用途限定";
export const TERM_NATURAL_LAW = "自然规律";
export const TERM_MENTAL_ACTIVITY = "智力活动规则";
export const TERM_OVERALL_VISUAL = "整体视觉效果";
export const TERM_PRODUCT_CATEGORY = "产品种类";
export const TERM_EXP_DATA = "实验数据";
export const TERM_FUNCTIONAL_LIMIT = "功能性限定";
export const TERM_PERSON_SKILLED = "本领域技术人员";
export const TERM_INTERNET_DISCLOSURE = "互联网公开";
export const TERM_PROTECTION_SCOPE = "保护范围";

// =============================================================================
// 域常量（规则适用域过滤）
// =============================================================================

export const DOMAIN_INVENTIVENESS = "patent_inventiveness";
export const DOMAIN_NOVELTY = "patent_novelty";
export const DOMAIN_INFRINGEMENT = "patent_infringement";
export const DOMAIN_DISCLOSURE = "patent_disclosure";
export const DOMAIN_CLAIMS = "patent_claims";
export const DOMAIN_EXAMINATION = "patent_examination";
export const DOMAIN_DESIGN = "patent_design";
export const DOMAIN_INVALIDATION = "patent_invalidation";
export const DOMAIN_AMENDMENT = "patent_amendment";
export const DOMAIN_REEXAMINATION = "patent_reexamination";

// =============================================================================
// 权利要求分析维度
// =============================================================================

export const DIM_CLARITY = "clarity";
export const DIM_SUPPORT = "support";
export const DIM_ESSENTIAL = "essential_features";
export const DIM_CONSISTENCY = "consistency";

/** 权利要求分析维度 → 关键词集（至少命中其一）。 */
export const claimDimensionPatterns: Record<string, string[]> = {
  [DIM_CLARITY]: ["清楚", "清晰", "明确", "简要"],
  [DIM_SUPPORT]: ["以说明书为依据", "支持", "记载", "记载于", "说明书支持"],
  [DIM_ESSENTIAL]: ["必要技术特征", "必要特征", "必不可少"],
  [DIM_CONSISTENCY]: ["一致", "对应", "协调", "不矛盾"],
};

// =============================================================================
// 同义词扩展表（移植 Mady synonymMap）
// =============================================================================

export const synonymMap: Record<string, string[]> = {
  [TERM_NOVELTY]: ["新创性", "未公开", "不属于现有技术", "未被披露"],
  [TERM_INVENTIVENESS]: ["非显而易见", "发明高度", "创造性步骤", "inventive step"],
  [TERM_PRIOR_ART_DOC]: ["现有技术", "在先技术", "引用文件", "文献", "reference"],
  权利要求: ["权项", "claims", "保护范围"],
  说明书: ["specification", "申请文件"],
  [TERM_SUFFICIENT_DISCLOSURE]: ["公开充分", TERM_ENABLE, "enablement"],
  三步法: [TERM_CLOSEST_PRIOR_ART_FULL, TERM_DISTINGUISHING_FEATURES, TERM_TECH_HINT],
  单独对比: ["单独对比原则", "一一对比"],
  公知常识: ["惯用技术手段", "常规设计", "common knowledge", "well-known"],
  // 侵权域
  全面覆盖: ["全部技术特征", "逐一比对", "全覆盖原则"],
  等同: ["等同替换", "等同侵权", "基本相同的手段", "基本相同的功能", "基本相同的效果"],
  禁止反悔: ["审查过程禁反言", "prosecution history estoppel", "修改导致放弃"],
  捐献规则: ["捐献原则", "dedicated to the public"],
  [TERM_TECH_FEATURE]: ["技术特征分解", "权项特征", "limitation"],
  // 无效域
  无效宣告: ["无效请求", "宣告无效", "invalidation"],
  [TERM_COMBINATION_MOTIVATION]: [TERM_COMBINATION_HINT, "有动机结合", "技术结合启示", TERM_TECH_HINT],
  [TERM_PRIORITY_DATE]: [TERM_PRIORITY, TERM_FILING_DATE, "filing date"],
  // 复审域
  复审: ["复审请求", "驳回复审", "reexamination"],
  程序违法: ["程序错误", "违反法定程序"],
  新证据: ["补充证据", "新提交的证据"],
  // 外观设计域
  [TERM_DESIGN_PATENT]: ["工业设计", "design", "industrial design", "外观"],
  整体视觉效果: ["视觉效果", "整体外观", "整体视觉", "overall visual effect"],
  产品种类: ["产品类别", "产品类型", "相似种类", "同类产品"],
  // 公开方式域
  出版物公开: ["公开出版", "论文", "期刊", "杂志", "书籍"],
  使用公开: ["公开使用", "销售公开", "展出", "公开实施"],
  互联网公开: ["网络公开", "在线公开", "网页公开", "网站公开"],
  公开方式: ["公开途径", "公开形式", "公开类型"],
  // 修改超范围域
  修改超范围: ["超出原范围", "增加新内容", "超范围修改", "amendment beyond scope", "超范围"],
  直接且毫无疑义: ["直接毫无疑义", "直接确定", "原申请文件"],
  // 保护客体域
  技术方案: ["技术方案本身", "technical solution"],
  保护客体: ["可专利主题", "patentable subject matter", "授权客体"],
  智力活动规则: ["智力活动的规则", "数学方法", "商业规则", "mental activity", "抽象思想"],
  疾病诊断方法: ["诊断方法", "治疗方法", "手术方法"],
  [TERM_SCI_DISCOVERY]: ["自然规律", "自然法则", "natural law"],
  // 推理模式域
  预料不到: ["预料不到的技术效果", "出乎意料", "surprising", "unexpected"],
  用途限定: ["用途特征", "用途限制", "use limitation"],
  实验数据: ["实验数据", "实施例", "实验例", "药效数据"],
  [TERM_CLOSEST_PRIOR_ART_FULL]: [TERM_CLOSEST_PRIOR_ART, "最接近的对比文件"],
  抵触申请: ["在先申请在后公开", "conflicting application"],
  功能性限定: ["功能限定", "功能性特征", "functional limitation"],
  实用性: ["工业实用性", "产业应用", "industrial applicability"],
  积极效果: ["有益效果", "positive effect", "技术效果"],
  本领域技术人员: ["所属领域技术人员", "person skilled in the art"],
  [TERM_ENABLE]: ["可实施", "enablement", "能够制造", "能够使用"],
  显而易见: ["obvious", "显而易见性", "非显而易见"],
  转让: ["transfer", "assign", "assignment"],
};

// =============================================================================
// 否定模式（命中前 60 字符窗口内出现任一模式 → 该命中视为否定表述，不采信）
// =============================================================================

export const negationPatterns: readonly RegExp[] = [
  /不具有/,
  /不构成/,
  /无法证明/,
  /缺少/,
  /未发现/,
  /没有公开/,
  /不满足/,
  /不符合/,
  /难以看出/,
  /不能证明/,
];

/** 新颖性单独对比禁止短语（SingleComparison 规则命中即失败）。 */
export const singleComparisonBanPhrases: readonly string[] = [
  "多份对比文件结合",
  "多篇文献相结合",
  "对比文件1-3",
  "对比文件1、2和3",
  "结合对比文件1-",
];

/** 否定检测窗口（命中位置前的字符数）。 */
export const NEGATION_WINDOW = 60;
