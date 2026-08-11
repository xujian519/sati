/**
 * src/patent/problem — 原子化技术问题四检验（纯函数，确定性正则，零依赖零 IO）。
 *
 * 面向创造性分析（A22.3 三步法）diff 阶段"实际解决的技术问题"表述的合规校验，
 * 对应审查指南第二部分第四章 3.2.1.1："根据区别特征相对于最接近的现有技术所能
 * 达到的技术效果确定发明实际解决的技术问题"——问题表述不得包含解决手段、不得
 * 捆绑多个因果链、应落到可测效果。
 *
 * 四检验（8 陷阱中可确定性检测的 4 个，其余需上下文/LLM 的不在此列）：
 * 1. noSolutionBinding 不绑方案（陷阱 2 问题含方案）——参与合规判定
 * 2. singleCausality    单一因果（陷阱 3 捆绑问题 / 陷阱 5 复合因果）——参与合规判定
 * 3. measurableEffect   单一可测效果（陷阱 4 效果当问题）——质量提示项，不参与合规判定
 * 4. meansReversible    手段可反推——信息性检验（当前为弱启发式），不参与合规判定
 *
 * 本模块不依赖任何外部服务与 LLM，供 checker 规则（INVENTIVENESS-PROBLEM-*）
 * 及未来 PFE 提取阶段复用。
 */

// =============================================================================
// 检测模式（纯数据）
// =============================================================================

/** 因果连接词（用于单一因果检验）。注意剔除"产生"——"产生热量/噪音"为正常
 *  结果宾语表述而非因果桥，计入会显著误报。 */
const CAUSAL_CONNECTORS: readonly string[] = ["导致", "使得", "造成", "引起", "引发", "致使", "源于", "归因于"];

/** 泛指手段词（"通过技术手段降低成本"不视为绑方案，负向前瞻排除）。 */
const GENERIC_MEANS: readonly string[] = ["技术手段", "现有技术", "常规手段", "通常做法", "已有手段", "公知手段"];

/** 手段性表述模式（不绑方案检验）。命中任一即视为问题文本包含解决手段。 */
const SOLUTION_BINDING_PATTERNS: readonly RegExp[] = [
  // "通过设置X" / "利用液冷泵" / "借助弹性垫" 等：动词前缀 + 具体内容
  new RegExp(`通过(?!${GENERIC_MEANS.join("|")})(?:设置|增设|加装|引入|配置|利用|采用|借助|使用|依靠)[^，。；]{1,16}`),
  // "设置限位凸台" / "增设密封圈" / "引入闭环控制器" 等：动作 + 具体结构名词
  /(?:设置|增设|加装|引入|配置|利用|采用)[^，。；]{1,12}(?:机构|装置|组件|模块|系统|结构|单元|片|件|阀|泵|块|器|机|圈|垫|座|罩|盖|台|板|管|杆|轮|轴|簧|塞)/,
];

/** 可测指标模式（单一可测效果检验）。命中任一即认为有量化支撑。 */
const MEASURABLE_EFFECT_PATTERNS: readonly RegExp[] = [
  // "15°C" / "58dB" / "23%" / "20000h" / "8mm" 等
  /\d+(?:\.\d+)?\s*(?:%|％|℃|°C|度|dB|mm|cm|m|kg|h|小时|天|次|倍|ppm|MPa|kPa|V|A|W)/,
  // "降低至42dB" / "提升到60%" / "缩短了3天" 等
  /(?:提升|降低|减少|增加|升高|下降|缩短|延长)[^。]{0,10}\d/,
  // "从95°C降至78°C" 等对比句式
  /从\s*\d/,
];

/** 现状锚点（手段可反推检验）：问题表述提及现有技术/传统方案等现状，即可反推出
 * 一个"现有手段不能解决"的场景。"现有"为通配锚点（现有技术/现有方案/现有设备…）。 */
const REVERSIBILITY_ANCHORS: readonly string[] = ["现有", "传统", "目前", "常规", "背景技术"];

// =============================================================================
// 类型与实现
// =============================================================================

/** 单一检验结果；meansReversible 为信息性检验（true=有现状锚点可反推，false=无锚点，
 * 当前实现无法确定性判定，不参与合规判定）。 */
export type AtomicChecks = {
  readonly singleCausality: boolean;
  readonly measurableEffect: boolean;
  readonly meansReversible: boolean;
  readonly noSolutionBinding: boolean;
};

/**
 * 四检验结果：pass 由合规性检验决定（不绑方案 + 单一因果）。
 * measurableEffect（质量提示）与 meansReversible（信息性）不参与 pass——
 * 缺量化指标或无法判定可反推都不是"确定不合规"。
 */
export type AtomicCheckResult = {
  readonly pass: boolean;
  readonly checks: AtomicChecks;
  /** 未通过项的具体原因（供规则 message / fixSuggestion 复用）。 */
  readonly diagnostics: readonly string[];
};

function countCausalConnections(text: string): number {
  let count = 0;
  for (const connector of CAUSAL_CONNECTORS) {
    let idx = text.indexOf(connector);
    while (idx !== -1) {
      count += 1;
      idx = text.indexOf(connector, idx + 1);
    }
  }
  return count;
}

function checkNoSolutionBinding(text: string): boolean {
  return !SOLUTION_BINDING_PATTERNS.some(pattern => pattern.test(text));
}

function checkSingleCausality(text: string): boolean {
  return countCausalConnections(text) < 2;
}

function checkMeasurableEffect(text: string): boolean {
  return MEASURABLE_EFFECT_PATTERNS.some(pattern => pattern.test(text));
}

function checkMeansReversible(text: string): boolean {
  return REVERSIBILITY_ANCHORS.some(anchor => text.includes(anchor));
}

/** 对单个技术问题文本执行四检验。 */
export function checkAtomic(problem: string): AtomicCheckResult {
  const checks: AtomicChecks = {
    singleCausality: checkSingleCausality(problem),
    measurableEffect: checkMeasurableEffect(problem),
    meansReversible: checkMeansReversible(problem),
    noSolutionBinding: checkNoSolutionBinding(problem),
  };
  const diagnostics: string[] = [];
  if (!checks.noSolutionBinding) {
    diagnostics.push(
      "问题表述包含解决手段（如'通过设置X'/'利用X装置'），技术问题不得包含任何具体手段，请改写为不绑定方案的表述",
    );
  }
  if (!checks.singleCausality) {
    diagnostics.push("问题表述含多个因果连接词，疑似捆绑/复合问题，请拆分或明确主因");
  }
  if (!checks.measurableEffect) {
    diagnostics.push("问题表述缺少可测指标，建议落到量化效果（如'焊点断裂率从 0.1% 升至 3%'）");
  }
  const pass = checks.noSolutionBinding && checks.singleCausality;
  return { pass, checks, diagnostics };
}

// =============================================================================
// 规则接线（供 checker 规则复用）
// =============================================================================

/**
 * 从评估文本中提取"实际解决的技术问题"片段（兼容两种形态）：
 * - Graph 形态：collectStateText 拼入的 inventiveness_diff JSON（"actual_technical_problem" 字段）；
 * - 文本形态：收口工具 / 主代理产出文本中的"实际解决的技术问题：/为/是 ..."句。
 * 提取不到返回 undefined。
 */
export function extractTechnicalProblem(text: string): string | undefined {
  const json = /"actual_technical_problem"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (json !== null) {
    try {
      return JSON.parse(`"${json[1]}"`) as string;
    } catch {
      return json[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
  const flat = /实际解决的技术问题[是为：:]+([^。\n]{4,120})/.exec(text);
  if (flat !== null) return flat[1];
  return undefined;
}

/**
 * 规则 customCheck 工厂：提取技术问题 → 跑四检验 → 按 selector 判定。
 * 提取不到返回通过（技术问题缺失由 INVENTIVENESS-THREE-STEP 规则处理，避免双重惩罚）。
 */
export function technicalProblemCheck(
  check: (result: AtomicCheckResult) => boolean,
  failDetail: string,
): (text: string) => { passed: boolean; detail: string } {
  return text => {
    const problem = extractTechnicalProblem(text);
    if (problem === undefined) return { passed: true, detail: "" };
    const result = checkAtomic(problem);
    return check(result) ? { passed: true, detail: "" } : { passed: false, detail: failDetail };
  };
}
