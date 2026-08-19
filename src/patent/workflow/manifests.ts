/**
 * src/patent/workflow — 内置 manifest 数据（7 个 + 目录）。
 *
 * 从 workflow.ts 拆出（轮次 1 纯搬移）：纯数据常量，零执行依赖。
 */

import type { WorkflowManifest } from "./types.js";

/**
 * 内置：专利新颖性分析五阶段 manifest（镜像 Mady patent_novelty.yaml 与 novelty_chain 模板）。
 *
 * 注意：本 manifest **不声明 atom** —— 其消费方 patent_workflow 工具采用"主代理产出
 * 文本 → 工具收口校验"语义（确定性、无 LLM）。需要原子自动执行时，调用方应定义
 * 带 atom 的自定义 manifest，并注入已注册内置原子的注册表与 provider（见 src/patent/atoms）。
 */
export const patentNoveltyManifest: WorkflowManifest = {
  id: "patent_novelty_v1",
  name: "专利新颖性分析",
  caseType: "novelty_search",
  stages: [
    { id: "parse", strategy: "chain", description: "解析技术交底书，提取技术特征" },
    { id: "search", strategy: "react", description: "检索现有技术文献" },
    { id: "compare", strategy: "chain", description: "逐项对比技术特征与现有技术（单独对比原则）" },
    { id: "conclude", strategy: "chain", description: "生成新颖性分析结论（附置信度）" },
    { id: "approval", strategy: "chain", description: "人工确认分析结论" },
  ],
  validation: { requireAllSteps: true, maxRetries: 2 },
};

/**
 * PFE 一致性检查 reasoning_prompt（disclosure 与 drafting 共用，2026-08 提取：
 * 此前两处逐字重复，改一致性契约（JSON 形状/信号词）须两处同步，防漂移）。
 */
const PFE_CONSISTENCY_PROMPT =
  "对以下 PFE 三元组做一致性检查：特征-效果因果链是否闭合、有无孤立特征（无问题/无效果关联的特征）。" +
  "严格输出 JSON：{ consistent: boolean, issues: string[] }。issues 为空数组表示一致。";

/**
 * 内置：技术交底书披露分析 manifest（移植 Mady disclosure/graph.go 的 PFE 管线）。
 *
 * PFE（Problem/Feature/Effect）三元组提取：problem/features/effects 三路提取
 * （经 stage.params 分键，互不覆盖）→ merge 融合 → groundedness 原文依据过滤
 * （低分特征反馈）→ 一致性检查（输出含"不一致/矛盾/缺少"信号时回退到提取阶段
 * 重做，最多 1 次）→ 检索关键词生成 → 现有技术检索（prior_art 证据注入）→
 * 逐特征新颖性初判（单独对比原则 + 证据引用）→ 报告 → review_gate 人工复核
 * （中断等待确认）→ draft_claims 直出权利要求草稿。
 *
 * 注意：本 manifest 声明了内置原子（extract / merge / groundedness / reasoning /
 * keywords / search / novelty / approval-gate / draft-claims），消费方需注入 provider
 * （LLM/检索器）与内置原子注册表（registerBuiltinAtoms）执行。prior-art 注入链
 * （generate_keywords → search → novelty）在 provider.search 缺失时降级
 * （evidence_coverage=none），不中断管线（对齐 Mady fail-open 语义）。
 */
export const patentDisclosureManifest: WorkflowManifest = {
  id: "patent_disclosure_v1",
  name: "技术交底书披露分析",
  caseType: "disclosure_analysis",
  stages: [
    { id: "preprocess", strategy: "chain", description: "预处理技术交底书，分段与去噪" },
    {
      id: "extract_problem",
      strategy: "sub_agent",
      description: "提取待解决的技术问题",
      atom: "extract",
      params: { extraction_type: "提取待解决的技术问题（严格输出 problems 数组）", output_key: "problems" },
    },
    {
      id: "extract_features",
      strategy: "sub_agent",
      description: "提取技术特征",
      atom: "extract",
      params: { extraction_type: "提取技术特征（严格输出 features 数组）", output_key: "features" },
    },
    {
      id: "extract_effects",
      strategy: "sub_agent",
      description: "提取技术效果",
      atom: "extract",
      params: { extraction_type: "提取技术效果（严格输出 effects 数组）", output_key: "effects" },
    },
    { id: "merge", strategy: "chain", description: "融合 PFE 三元组（问题↔特征↔效果交叉引用）", atom: "merge" },
    {
      id: "groundedness",
      strategy: "chain",
      description: "评估提取特征在原文中的依据（低分特征反馈）",
      atom: "groundedness",
    },
    {
      id: "consistency",
      strategy: "chain",
      description: "PFE 一致性检查（特征-效果因果链闭合、无孤立特征）",
      atom: "reasoning",
      params: { reasoning_prompt: PFE_CONSISTENCY_PROMPT },
      retry: {
        whenOutputMatches: "不一致|矛盾|缺少|孤立",
        rewindTo: "extract_problem",
        maxRetries: 1,
      },
    },
    { id: "generate_keywords", strategy: "chain", description: "生成检索关键词（上位/下位/同义词）", atom: "keywords" },
    { id: "search", strategy: "react", description: "检索现有技术文献（证据片段注入新颖性评估）", atom: "search" },
    {
      id: "novelty",
      strategy: "chain",
      description: "逐特征新颖性初判（单独对比原则 + 证据引用）",
      atom: "novelty",
    },
    { id: "report", strategy: "chain", description: "生成披露分析报告（创新点/保护建议）" },
    {
      id: "review_gate",
      strategy: "chain",
      description: "人工复核披露分析报告（中断等待确认）",
      atom: "approval-gate",
      params: { review_context: "披露分析报告需人工复核后方可继续" },
    },
    {
      id: "draft_claims",
      strategy: "chain",
      description: "基于 PFE 与新颖性结果直出权利要求草稿（独立+从属）",
      atom: "draft-claims",
    },
  ],
  validation: { requireAllSteps: true, maxRetries: 2 },
};

/**
 * 内置：专利创造性分析八阶段 manifest（专利法 A22.3，三步法）。
 *
 * 阶段设计对齐知识资产（src/knowledge/patent/wiki/专利实务/创造性/）与
 * 复审无效实务的模板化论证结构：解析与画像 → 检索与候选筛选 → 三步法
 * 展开为三阶段（最接近现有技术 → 区别特征与实际解决的技术问题 → 技术启示）
 * → 辅助判断因素复核 → 结论与反事后诸葛亮自检 → 人工确认（HITL）。
 *
 * 注意：本 manifest **不声明 atom**（与 patent_novelty_v1 一致）——消费方
 * patent_workflow 工具采用"主代理产出文本 → 工具收口校验"语义（确定性、无
 * LLM）；收口时按 caseType inventiveness_analysis 映射 patent_inventiveness 域
 * 规则门（9 条：三步法/实际解决技术问题/公知常识路径/多文件结合/技术启示/
 * 惯用手段/用途限定/预料不到效果）。需要原子自动执行时，调用方应定义带 atom
 * 的自定义 manifest，并注入已注册内置原子的注册表与 provider（见 src/patent/atoms）。
 */
export const patentInventivenessManifest: WorkflowManifest = {
  id: "patent_inventiveness_v1",
  name: "专利创造性分析",
  caseType: "inventiveness_analysis",
  stages: [
    {
      id: "parse",
      strategy: "chain",
      description: "解析权利要求/技术方案，构建所属领域技术人员画像，确定申请日/优先权日时间基准",
    },
    {
      id: "search",
      strategy: "react",
      description: "检索现有技术文献，筛选最接近现有技术候选（技术领域→技术问题→发明构思）",
    },
    { id: "closest", strategy: "chain", description: "三步法 Step1：确定最接近的现有技术（候选多时逐个试判）" },
    {
      id: "diff",
      strategy: "chain",
      description: "三步法 Step2：实质对比确定区别技术特征，客观确定实际解决的技术问题（不得包含解决手段）",
    },
    {
      id: "hint",
      strategy: "chain",
      description: "三步法 Step3：技术启示判断（改进动机/结合启示/公知常识/发明构思/逻辑推理与有限试验）",
    },
    {
      id: "secondary",
      strategy: "chain",
      description: "辅助判断因素复核（预料不到的技术效果/长期渴望难题/克服技术偏见/商业成功）",
    },
    { id: "conclude", strategy: "chain", description: "生成创造性结论（高/中/低/无，附置信度）+ 反事后诸葛亮自检" },
    { id: "approval", strategy: "chain", description: "人工确认分析结论（HITL）" },
  ],
  validation: { requireAllSteps: true, maxRetries: 2 },
};

/**
 * 内置：可专利性检索与布局 manifest（撰写场景）。
 * parse（主代理）→ claim-chart（要素级证据网格，atom 自动执行）→
 * draft（基于 not-found 区别特征布局规避 D1；draft-claims 原子输入键
 * pfe_triples/merge_result 本 manifest 无产出，故不声明 atom，回退收口）。
 */
export const patentPatentabilityManifest: WorkflowManifest = {
  id: "patent_patentability_v1",
  name: "可专利性检索与权利要求布局",
  caseType: "novelty_search",
  stages: [
    { id: "parse", strategy: "chain", description: "解析技术方案与权利要求" },
    {
      id: "claim-chart",
      strategy: "chain",
      description: "权利要求要素级映射到最接近现有技术（mode=patentability）",
      atom: "claim-chart",
      params: { chart_mode: "patentability" },
    },
    { id: "draft", strategy: "chain", description: "基于区别特征布局权利要求（规避 D1）（原子路径不支持，收口模式）" },
    { id: "approval", strategy: "chain", description: "人工确认权利要求布局" },
  ],
  validation: { requireAllSteps: true, maxRetries: 2 },
};

/**
 * 内置：审查意见答复 manifest（OA 答复场景）。
 * parse → claim-chart（mode=oa-response，targets=审查员引用对比文件）→
 * draft（意见陈述书撰写，消费 claim-chart 产出）。
 */
export const patentOaResponseManifest: WorkflowManifest = {
  id: "patent_oa_response_v1",
  name: "审查意见答复",
  caseType: "oa_response",
  stages: [
    { id: "parse", strategy: "chain", description: "解析审查意见与权利要求" },
    {
      id: "claim-chart",
      strategy: "chain",
      description: "权利要求要素级映射到审查员引用对比文件（mode=oa-response）",
      atom: "claim-chart",
      params: { chart_mode: "oa-response" },
    },
    { id: "draft", strategy: "chain", description: "撰写意见陈述书（新颖性陈述 + 三步法，消费 claim-chart）" },
    { id: "approval", strategy: "chain", description: "人工确认答复书" },
  ],
  validation: { requireAllSteps: true, maxRetries: 2 },
};

/**
 * 内置：无效宣告/复审答复 manifest（无效/复审双场景）。
 * parse → claim-chart（mode=invalidity；复审场景可经 flexible-plan 调整）→
 * novelty（单篇全覆盖由 mapping-machine 校验）→ inventiveness（区别特征 = D1
 * not-found 行）。
 *
 * 注意：novelty / inventiveness 两阶段**不声明 atom**（原子路径不支持——novelty
 * 原子输入键为 features/prior_art、reasoning 原子输入键为 reasoning_prompt/
 * reasoning_input，本 manifest 无对应产出），回退为收口语义：主代理按阶段描述
 * 产出阶段文本，消费方 patent_workflow 工具按 caseType 映射规则门校验。
 */
export const patentInvalidationManifest: WorkflowManifest = {
  id: "patent_invalidation_v1",
  name: "无效/复审答复",
  caseType: "invalidation_analysis",
  stages: [
    { id: "parse", strategy: "chain", description: "解析无效请求/驳回决定与权利要求" },
    {
      id: "claim-chart",
      strategy: "chain",
      description: "权利要求要素级映射到证据组合（mode=invalidity/reexamination）",
      atom: "claim-chart",
      params: { chart_mode: "invalidity" },
    },
    { id: "novelty", strategy: "chain", description: "新颖性单独对比（单篇全覆盖）（原子路径不支持，收口模式）" },
    { id: "inventiveness", strategy: "chain", description: "三步法创造性分析（原子路径不支持，收口模式）" },
    { id: "approval", strategy: "chain", description: "人工确认分析结论" },
  ],
  validation: { requireAllSteps: true, maxRetries: 2 },
};

/**
 * 内置：侵权比对 manifest（侵权场景）。
 * parse → claim-chart（mode=infringement，targets=被控产品，支持 doe 行）→ 报告。
 */
export const patentInfringementManifest: WorkflowManifest = {
  id: "patent_infringement_v1",
  name: "侵权比对分析",
  caseType: "infringement_analysis",
  stages: [
    { id: "parse", strategy: "chain", description: "解析权利要求与被控产品材料" },
    {
      id: "claim-chart",
      strategy: "chain",
      description: "权利要求要素级映射到被控产品（mode=infringement，支持等同 doe 行）",
      atom: "claim-chart",
      params: { chart_mode: "infringement" },
    },
    { id: "report", strategy: "chain", description: "生成侵权比对报告（全面覆盖 + 等同 + 现有技术抗辩）" },
    { id: "approval", strategy: "chain", description: "人工确认比对结论" },
  ],
  validation: { requireAllSteps: true, maxRetries: 2 },
};

/**
 * 内置：申请撰写辅助 manifest（撰写场景，对应 assets/workflows/patent/prosecution-draft.yaml 12 步 SOP）。
 *
 * 全链路：PFE 提取 → 一致性 → HITL 确认解构 → 附图/化学（主代理工具完成，
 * 无原子透传）→ 关键词/检索 → 检索质量门（quality-gate）→ HITL 确认对比文件 →
 * 逐特征对比（novelty，区别特征输出）→ HITL 确认区别特征 → 充分公开审查
 * （reasoning）→ HITL 审核 → draft-claims → draft-spec（含确定性校验）→
 * slop-gate（反套话评分）→ HITL 定稿。
 *
 * 说明：
 * - figure / chemistry 阶段无原子：StageProvider 契约无图片/文件通道，由主代理
 *   先行调用 analyze_patent_figure / recognize_chemical_structure 并写入阶段文本
 *   （无原子阶段在 patent_workflow_run 下透传输入，不降级）。
 * - 规则门（rule-gate）不设阶段：消费方 patent_workflow / patent_workflow_run
 *   在收尾时按 checkDomains 自动运行确定性规则门（dual-track checker）。
 * - 一致性检查用 reasoning 原子，输出命中"不一致/矛盾/缺少/孤立"信号时
 *   回退 extract_problem 重做（最多 1 次）。
 */
export const patentDraftingManifest: WorkflowManifest = {
  id: "patent_drafting_v1",
  name: "申请撰写辅助",
  caseType: "drafting",
  stages: [
    { id: "preprocess", strategy: "chain", description: "预处理技术交底书（透传输入）" },
    {
      id: "extract_problem",
      strategy: "sub_agent",
      description: "提取待解决的技术问题",
      atom: "extract",
      params: { extraction_type: "提取待解决的技术问题（严格输出 problems 数组）", output_key: "problems" },
    },
    {
      id: "extract_features",
      strategy: "sub_agent",
      description: "提取技术特征",
      atom: "extract",
      params: { extraction_type: "提取技术特征（严格输出 features 数组）", output_key: "features" },
    },
    {
      id: "extract_effects",
      strategy: "sub_agent",
      description: "提取技术效果",
      atom: "extract",
      params: { extraction_type: "提取技术效果（严格输出 effects 数组）", output_key: "effects" },
    },
    { id: "merge", strategy: "chain", description: "融合 PFE 三元组（问题↔特征↔效果交叉引用）", atom: "merge" },
    {
      id: "groundedness",
      strategy: "chain",
      description: "评估提取特征在原文中的依据（低分特征反馈）",
      atom: "groundedness",
    },
    {
      id: "consistency",
      strategy: "chain",
      description: "PFE 一致性检查（问题-手段-效果链闭合、无孤立特征）",
      atom: "reasoning",
      params: { reasoning_prompt: PFE_CONSISTENCY_PROMPT },
      retry: {
        whenOutputMatches: "不一致|矛盾|缺少|孤立",
        rewindTo: "extract_problem",
        maxRetries: 1,
      },
    },
    {
      id: "deconstruct_approval",
      strategy: "chain",
      description: "HITL：确认发明解构与核心特征（编号选择：1=确认/2=修改/3=退回/4=其他意见）",
      atom: "approval-gate",
      params: { review_context: "确认发明七维解构与核心特征（1=确认/2=修改/3=退回/4=其他意见）" },
    },
    { id: "figure", strategy: "chain", description: "附图分析（主代理经 analyze_patent_figure 完成后透传）" },
    {
      id: "chemistry",
      strategy: "chain",
      description: "化学式核验（主代理经 recognize_chemical_structure 完成后透传）",
    },
    {
      id: "generate_keywords",
      strategy: "chain",
      description: "生成检索关键词（上位/下位/同义词）",
      atom: "keywords",
    },
    {
      id: "search",
      strategy: "react",
      description: "检索现有技术文献（证据注入下游对比）",
      atom: "search",
      worker: "patent-search-commander",
    },
    {
      id: "search_quality",
      strategy: "chain",
      description: "检索质量门槛（对比文件≥3 篇/相关度标注/全文≥2 篇/布尔+IPC 检索式）",
      atom: "quality-gate",
    },
    {
      id: "search_approval",
      strategy: "chain",
      description: "HITL：确认对比文件列表与相关性（编号选择：1=确认/2=修改/3=退回/4=其他意见）",
      atom: "approval-gate",
      params: { review_context: "确认对比文件列表与相关性（1=确认/2=修改/3=退回/4=其他意见）" },
    },
    {
      id: "prior_art_compare",
      strategy: "chain",
      description: "本发明 vs 检索结果逐特征对比（区别特征输出，撰写避重复必步）",
      atom: "novelty",
      params: {
        novelty_scope: "申请撰写场景：逐特征对比现有技术，输出区别特征与可写入权利要求的特征（撰写避重复）",
      },
    },
    {
      id: "compare_approval",
      strategy: "chain",
      description: "HITL：确认与现有技术的区别特征（编号选择：1=确认/2=修改/3=退回/4=其他意见）",
      atom: "approval-gate",
      params: { review_context: "确认与现有技术的区别特征（1=确认/2=修改/3=退回/4=其他意见）" },
    },
    {
      id: "disclosure",
      strategy: "chain",
      description: "充分公开审查（A26.3）与权利要求/说明书撰写改进建议",
      atom: "reasoning",
      params: {
        reasoning_prompt:
          "你是充分公开审查专家（A26.3 清楚/完整/能够实现）。审查技术交底书/说明书是否充分公开，结合区别特征" +
          "给出权利要求与说明书撰写改进建议（引用附图标记须与图面一致，化学方案引用核验结论）。" +
          "输出章节式报告：disclosure_review（现状评估/缺陷清单/撰写改进建议）。",
      },
    },
    {
      id: "disclosure_approval",
      strategy: "chain",
      description: "HITL：审核充分公开与撰写建议（编号选择：1=确认/2=修改/3=退回/4=其他意见）",
      atom: "approval-gate",
      params: { review_context: "审核充分公开与撰写建议（1=确认/2=修改/3=退回/4=其他意见）" },
    },
    {
      id: "draft_claims",
      strategy: "chain",
      description: "基于 PFE 与新颖性结果直出权利要求草稿（独立+从属）",
      atom: "draft-claims",
    },
    {
      id: "draft_spec",
      strategy: "chain",
      description: "撰写说明书七部分（技术领域/背景/发明内容/附图说明/实施方式/摘要）+ 确定性合规校验",
      atom: "draft-spec",
    },
    {
      id: "slop_clean",
      strategy: "chain",
      description: "反套话 5 维评分门（总分<35 判需修订）",
      atom: "slop-gate",
    },
    {
      id: "final_approval",
      strategy: "chain",
      description: "HITL：确认权利要求书与说明书定稿（编号选择：1=确认/2=修改/3=退回/4=其他意见）",
      atom: "approval-gate",
      params: { review_context: "确认权利要求书与说明书定稿（1=确认/2=修改/3=退回/4=其他意见）" },
    },
  ],
  validation: { requireAllSteps: true, maxRetries: 2 },
};

/**
 * 内置 manifest 目录（单一数据源）。
 *
 * 消费方（patent_workflow 工具）经此遍历注册 manifest，并按条目读取确定性
 * 规则门检查域（caseType 推导的默认值）——新增内置 manifest 只需在此追加
 * 一项，工具层零改动；检查域与 manifest 同源声明，消除"漏配 → 规则门静默
 * 跳过"的故障模式。自定义 manifest 不在目录内，未显式传 checkDomain 时不
 * 跑规则门（fail-open，文档已声明）。
 */
export type BuiltinPatentManifest = {
  manifest: WorkflowManifest;
  /** 收口时确定性规则门检查域（caseType 推导的默认值）。 */
  checkDomains: readonly string[];
};

export const builtinPatentManifests: readonly BuiltinPatentManifest[] = [
  { manifest: patentNoveltyManifest, checkDomains: ["patent_novelty"] },
  { manifest: patentDisclosureManifest, checkDomains: ["patent_disclosure", "patent_claims"] },
  { manifest: patentInventivenessManifest, checkDomains: ["patent_inventiveness"] },
  { manifest: patentPatentabilityManifest, checkDomains: ["patent_novelty"] },
  { manifest: patentOaResponseManifest, checkDomains: ["patent_claims", "patent_inventiveness"] },
  {
    manifest: patentInvalidationManifest,
    checkDomains: ["patent_invalidation", "patent_novelty", "patent_inventiveness"],
  },
  { manifest: patentInfringementManifest, checkDomains: ["patent_infringement"] },
  { manifest: patentDraftingManifest, checkDomains: ["patent_disclosure", "patent_claims"] },
];
