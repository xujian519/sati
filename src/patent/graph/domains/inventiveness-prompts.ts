/**
 * 创造性分析子图的提示词构建（#725 / W-07）。
 *
 * 从 inventiveness.ts 的 llmNode 内联模板逐字提取：本模块只负责拼提示词，
 * 状态读取与节点装配在 inventiveness-nodes.ts。提示词内容变更须同步
 * tests/patent/graph/inventiveness-prompts.spec.ts 的快照。
 */

import { dataBlock } from "../../prompt-hygiene.js";

export function buildParsePrompt(input: string): string {
  return [
    "你是专利创造性分析专家（专利法 A22.3）。解析以下权利要求/技术方案：",
    "- 提取技术特征，构建所属领域技术人员画像",
    "- 解析申请日与优先权日（如提供）；本节点只解析时间字段，截止日由 time_baseline 统一产出",
    "- 记录发明人声称的技术效果（不以声称的问题为准）",
    dataBlock(input.slice(0, 8000)),
    "请严格输出 JSON：{ features, field, priority_date, filing_date, inventor_claimed_effect }。",
  ].join("\n");
}

export function buildQueryPrompt(params: { parse: string; cutoffDate: string; cutoffBasis: string }): string {
  const { parse, cutoffDate, cutoffBasis } = params;
  const basisLabel = cutoffBasis === "priority" ? "优先权日" : "申请日";
  const timeLine =
    cutoffDate.length > 0
      ? `- 时间基准已确定：截止日 ${cutoffDate}（${basisLabel}）——只检索该日期之前公开的文献，检索式加入 after:${cutoffDate.replace(/-/g, "")} 或等效日期限定`
      : "- 时间基准未确定（缺少申请日/优先权日）：不得假定今天，检索式中不得写死当日日期，并在输出中标注时间基准缺失";
  return [
    "基于创造性分析解析结果，生成现有技术检索策略：",
    "- 最接近现有技术的检索方向（同技术领域/同技术问题）",
    "- 三层检索式：精确层 → 扩展层 → 语义层",
    "- 含布尔表达式与 IPC 限定（如可推断）",
    timeLine,
    dataBlock(parse.slice(0, 4000)),
    "输出检索策略文本（至少 3 组检索式）。",
  ].join("\n");
}

export function buildRecallPrompt(params: { parse: string; priorArtText: string }): string {
  const { parse, priorArtText } = params;
  return [
    "你是专利检索质量审查员。检查现有技术检索结果的覆盖度：",
    "- adequate：检索结果是否足以支撑创造性判断（至少覆盖核心技术特征）",
    "- covered_features：已被检索结果覆盖的技术特征",
    "- missing_features：未被覆盖的关键技术特征（补检依据）",
    "【待评技术特征】",
    dataBlock(parse.slice(0, 3000)),
    "【检索结果摘要（含公开日）】",
    priorArtText.length > 0 ? dataBlock(priorArtText.slice(0, 4000)) : "（无检索结果）",
    "",
    "请严格输出 JSON：{ adequate, covered_features, missing_features }。",
  ].join("\n");
}

export function buildClosestPrompt(params: { parse: string; domainFocus: string; priorArtText: string }): string {
  const { parse, domainFocus, priorArtText } = params;
  return [
    "三步法第一步：确定最接近的现有技术（D1）。",
    "选择标准：技术领域相同/相近 → 技术问题最接近 → 公开技术特征最多。",
    "不得脱离检索结果自行选择；候选多时逐个试判。",
    "逐篇标注候选公开日（publication_date），并说明其是否早于申请日/优先权日——仅早于的才构成现有技术，可用于创造性评价。",
    ...(domainFocus.length > 0 ? ["", domainFocus] : []),
    dataBlock(parse.slice(0, 4000)),
    "【现有技术候选】",
    priorArtText.length > 0 ? dataBlock(priorArtText.slice(0, 6000)) : "（无检索结果，基于内置知识推断）",
    "",
    "请严格输出 JSON：{ document, technical_field, disclosed_features, rationale }。",
  ].join("\n");
}

export function buildDiffPrompt(params: { parse: string; domainFocus: string; closest: string }): string {
  const { parse, domainFocus, closest } = params;
  return [
    "三步法第二步：确定区别技术特征和实际解决的技术问题。",
    "- 基于 D1 公开特征逐一比对，列出区别特征",
    "- 基于区别特征的技术效果客观确定实际解决的技术问题（不得包含解决手段）",
    "- 检查技术问题是否包含对区别特征的指引（事后诸葛亮风险）",
    ...(domainFocus.length > 0 ? ["", domainFocus] : []),
    dataBlock(parse.slice(0, 4000)),
    "【D1 最接近现有技术】",
    dataBlock(closest.slice(0, 3000)),
    "",
    "请严格输出 JSON：{ distinguishing_features, actual_technical_problem, effect_of_diff }。",
  ].join("\n");
}

export function buildCombinationPrompt(params: { closest: string; diff: string; priorArtText: string }): string {
  const { closest, diff, priorArtText } = params;
  return [
    "你是专利创造性分析专家。评估是否存在可与最接近现有技术（D1）结合的其他对比文件（D2），以判断区别特征的引入是否显而易见：",
    "- candidate_documents：可与 D1 结合的候选文件标识（文档号，如 D2/对比文件2）",
    "- combinable：是否存在结合动机/技术启示",
    "- motivation：结合动机（改进动机/结合启示/公知常识/有限试验）",
    "- obstacles：结合的技术障碍",
    "- teaching_away：是否存在反向教导",
    "引用规范：文档号 + 段落/特征描述，引用必须真实存在于检索结果，不得凭空捏造。",
    "【D1 最接近现有技术】",
    dataBlock(closest.slice(0, 2000)),
    "【区别特征与实际解决的技术问题】",
    dataBlock(diff.slice(0, 2000)),
    "【其他现有技术候选（除 D1 外）】",
    priorArtText.length > 0 ? dataBlock(priorArtText.slice(0, 6000)) : "（无）",
    "",
    "请严格输出 JSON：{ candidate_documents, combinable, motivation, obstacles, teaching_away }。",
  ].join("\n");
}

export function buildHintPrompt(params: {
  parse: string;
  domainFocus: string;
  diff: string;
  combination: string;
}): string {
  const { parse, domainFocus, diff, combination } = params;
  return [
    "三步法第三步：判断要求保护的发明对本领域技术人员是否显而易见。",
    "技术启示来源：改进动机/结合启示（D1+D2 能否结合、有无技术障碍）/公知常识/逻辑推理与有限试验。",
    "发明类型差异化：组合/选择/转用/要素变更/开拓性/改进发明。",
    ...(domainFocus.length > 0 ? ["", domainFocus] : []),
    dataBlock(parse.slice(0, 3000)),
    "【区别特征与实际解决的技术问题】",
    dataBlock(diff.slice(0, 3000)),
    "",
    "【D2 组合评估】",
    combination.trim().length > 0 ? dataBlock(combination.slice(0, 3000)) : "（无组合评估）",
    "",
    "请严格输出 JSON：{ obvious, motivation, evidence, dissenting_factors }。",
  ].join("\n");
}

export function buildSecondaryPrompt(parse: string): string {
  return [
    "辅助判断因素复核：",
    "- 预料不到的技术效果（须有量化数据支撑）",
    "- 解决了长期渴望解决的技术问题",
    "- 克服了技术偏见",
    "- 商业成功（如有，须证明与发明特征有因果关系）",
    dataBlock(parse.slice(0, 3000)),
    "请严格输出 JSON：{ unexpected_effect, long_felt_need, technical_prejudice, commercial_success }。",
  ].join("\n");
}

export function buildConcludePrompt(params: {
  parse: string;
  closest: string;
  diff: string;
  combination: string;
  hint: string;
  secondary: string;
  feedbackHistory: string;
}): string {
  const parts = [
    "【解析】",
    params.parse,
    "【最接近现有技术】",
    params.closest,
    "【区别特征】",
    params.diff,
    "【D2 组合评估】",
    params.combination,
    "【技术启示】",
    params.hint,
    "【辅助因素】",
    params.secondary,
  ];
  return [
    "综合三步法各步骤，生成创造性分析结论：",
    "- 完整三步法报告（最接近现有技术 → 区别特征 → 技术启示）",
    "- 反事后诸葛亮自检（结论不得依赖发明本身披露的技术启示）",
    "- 不得仅凭区别特征数量判断创造性",
    "- 结论标注置信度（high/medium/low），回避绝对化表述",
    ...(params.feedbackHistory.length > 0 ? ["", params.feedbackHistory] : []),
    "",
    dataBlock(parts.join("\n").slice(0, 8000)),
    "",
    "请严格输出 JSON：{ inventive, confidence, key_rationale, report }。",
  ].join("\n");
}
