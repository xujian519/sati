/**
 * src/patent/figuregen — 附图法域合规核算（纯函数）。
 *
 * 用途：把**落版后的物理量**（图内字高、本案附图幅数、本幅是否已标图号）对照目标法域的
 * 条文要求核算一遍，产出面向模型/用户的中文结论（finding）。本模块只核算工具自己产出的量，
 * **不评价图面内容是否清楚**——那是审查员与代理人的判断。
 *
 * 三条判据与依据条文：
 * 1. **图号义务**（`figure-number-missing`）：本案附图两幅以上而本幅未标图号时报告。
 *    依据按法域分：CN《专利审查指南》第一部分第一章 4.3（附图总数在两幅以上的应当使用
 *    阿拉伯数字顺序编号并标注在相应附图的正下方）；PCT 实施细则 11.13(k) 与申请人指南
 *    IP 5.141；美国 37 CFR 1.84(u)。
 * 2. **字高下限**（`char-height-below-minimum`）：落版后图内数字与字母的字高低于该法域
 *    的字高下限时报告。下限值取自法域档案的 {@link minCharHeight}——**不直接读
 *    `profile.minCharHeightMm`**：CN 该字段为空（CN 无附图专有的字高条文），读它会得出
 *    "CN 无法核字高"的错误结论。档案口径是"条文优先，否则实践下限"：PCT/US 为条文字高
 *    3.2mm（PCT 实施细则 11.13(h) / 37 CFR 1.84(p)(3)），CN 取代理实践下限 2.0mm 且在
 *    消息里标注"实践下限（非法条数值）"——把实践取值说成法条要求就是把工具的约定伪装成
 *    条文。
 * 3. **摘要附图缩放字高**（`abstract-figure-scaled-height`）：摘要附图另有 40×60 毫米的
 *    尺寸上限（《专利审查指南》第二部分第二章 2.4），本判据只报告缩放到该尺寸后的字高，
 *    **不判定"清晰"**——清晰与否由人工判断。
 *
 * 与姊妹项目 deepseek-harness（`packages/patent/patent-tools/src/figure/compliance.ts`）
 * 的有意差异：
 * - **不设色彩策略判据**：DSH 版有 `style: "semantic"` 分支（彩色附图在 PCT 不得着色、
 *    在美国实用申请须呈请）。本仓是**构造期黑白不变式**——渲染器只产出 #000000/#FFFFFF、
 *    无渐变、无彩色函数，"彩色模式"在本仓**不是一个输入维度**（见 `types.ts` 里
 *    "黑白附图不得用颜色区分曲线（构造期黑白不变式）"的约定与 `render-svg.ts` 的构造期
 *    保证）。为一个不存在的输入维度写判据，只会造出永不触发的分支与"我们判过色彩"的错觉。
 * - **产出结构化 finding 而非字符串数组**：本仓的发现面（`check.ts` 的
 *    `FigureCheckFinding`、`render-check.ts` 的 `RenderCheckFinding`）统一是"稳定 id +
 *    级别 + 中文结论"，本模块沿用同一形状，便于上层合并、去重与统计。
 * - **字高下限走档案的 `minCharHeight`**：DSH 版直接读 `profile.minCharHeightMm`，对 CN
 *    会因该字段为空而**静默不判**；本仓按档案口径判，并在消息里写明下限的性质与出处。
 *
 * 纯函数：同一输入两次调用结果逐字节相同（无时钟、无随机、无 I/O）。
 */

import { minCharHeight, type OfficeProfile, type TargetOffice } from "./office-profile.js";

/**
 * 发现级别。本模块只产出"提醒"（warn），不产出"违规"级别的结论：同一批物理量在不同
 * 代理人的解读下可能有不同处理方式，交由人工确认。
 */
export type ComplianceSeverity = "warn";

/** 一条核算结论。 */
export type ComplianceFinding = {
  /** 稳定标识（跨调用不变，便于上层去重与统计）。 */
  readonly id: string;
  readonly severity: ComplianceSeverity;
  /** 模型可见的中文结论。 */
  readonly message: string;
};

/**
 * 核算用的**物理量**（纸面毫米）。
 *
 * 刻意收窄成三个量而不是直接吃 `SubmissionPageMetrics`：核算只需要「落版后图形占多大纸面」
 * 与「图内字高」，而落版页的基线（caption/sheet 基线）与核算无关；收窄后调用方既可以用
 * 落版页的度量，也可以用图形自身的实测尺寸（未产出落版页时），不必伪造基线值。
 */
export type ComplianceMetrics = {
  /** 落版后图形宽（毫米）。 */
  readonly placedWidthMm: number;
  /** 落版后图形高（毫米）。 */
  readonly placedHeightMm: number;
  /** 图内数字与字母的字高（毫米）。 */
  readonly charHeightMm: number;
};

/** 核算输入。 */
export type ComplianceInput = {
  /** 目标法域档案（纸面常数与规则口径的单一事实源）。 */
  readonly profile: OfficeProfile;
  /** 本案附图总幅数。 */
  readonly figureCount: number;
  /** 本幅是否已标注图号。 */
  readonly hasCaption: boolean;
  /** 本幅是否为请求书指定的摘要附图。 */
  readonly abstractFigure?: boolean;
  /**
   * 落版尺寸与字高（纸面毫米）。
   *
   * **缺省 ⇒ 字高类判据不参与**（图号义务仍然判）：调用方拿不到物理量时，不拿估算值
   * 充数——「没量到」与「量过且合规」必须可区分（AGENTS 第 11 条）。
   */
  readonly metrics?: ComplianceMetrics;
};

/** 图号义务的条文出处（按法域分，逐条可溯源）。 */
const CAPTION_PROVISION: Readonly<Record<TargetOffice, string>> = {
  cnipa: "《专利审查指南》第一部分第一章 4.3",
  pct: "PCT 实施细则 11.13(k) 与申请人指南 IP 5.141",
  uspto: "37 CFR 1.84(u)",
};

/**
 * 字高下限的条文出处（按法域分）。
 *
 * CN 这一句是**否定式**的：现行指南未设附图字高条文值，此处用的是代理实践下限。写成
 * "有条文出处"会让实践取值被当成法条引用。
 */
const CHAR_HEIGHT_PROVISION: Readonly<Record<TargetOffice, string>> = {
  cnipa: "CN 现行指南未设附图字高条文值，此为代理实践下限",
  pct: "PCT 实施细则 11.13(h)",
  uspto: "37 CFR 1.84(p)(3)",
};

/** 下限性质的说法：条文下限 vs 实践下限（实践下限非法条数值，不能说成"要求"）。 */
const LIMIT_NATURE = {
  statute: "条文下限",
  practice: "实践下限（非法条数值）",
} as const;

/** 摘要附图的尺寸上限（毫米，宽×高；《专利审查指南》第二部分第二章 2.4）。 */
const ABSTRACT_MAX_WIDTH_MM = 40;
const ABSTRACT_MAX_HEIGHT_MM = 60;

/** 毫米数值的可读文本（两位小数，去掉尾随零）。 */
function mm(value: number): string {
  return `${String(Math.round(value * 100) / 100)} 毫米`;
}

/**
 * 字高下限的**出处**文案（按法域与下限性质分）。
 *
 * 绝大多数情形下直接取法域档案登记的出处；CN 的档案只有实践下限，出处句必须点明
 * "现行指南未设附图字高条文值"，否则消息会读成"CN 有条文要求"。若调用方自造了一个带
 * `minCharHeightMm` 的 CN 档案（条文下限），此处改说档案登记值——仓库纪律是"没有条文
 * 数值的地方不编数值"，此时不得凭空引一条不存在的条文。
 * @param profile - 目标法域档案。
 * @param basis - 下限性质（条文 / 实践）。
 * @returns 出处文案。
 */
function charHeightProvision(profile: OfficeProfile, basis: "statute" | "practice"): string {
  if (profile.office === "cnipa" && basis === "statute") {
    return "档案登记的条文字高下限（CN 档案当前未登记附图字高条文值）";
  }
  return CHAR_HEIGHT_PROVISION[profile.office];
}

/**
 * 生成附图合规核算结论。
 * @param input - 法域档案、附图幅数、图号有无与落版尺寸。
 * @returns 结论列表；全部满足时为空数组。顺序固定：图号义务 → 字高下限 → 摘要附图缩放。
 */
export function drawingComplianceFindings(input: ComplianceInput): ComplianceFinding[] {
  const { profile, figureCount, hasCaption, abstractFigure, metrics } = input;
  const findings: ComplianceFinding[] = [];

  // 判据一：图号义务——附图两幅以上须逐幅编号（本幅无图号即报告）。
  if (!hasCaption && figureCount >= 2) {
    findings.push({
      id: "figure-number-missing",
      severity: "warn",
      message:
        `本案附图共 ${String(figureCount)} 幅，本幅未标注图号：` +
        `${CAPTION_PROVISION[profile.office]} 要求逐幅编号，请开启图号入图或自行排版补标`,
    });
  }

  // 判据二：落版字高下限——走档案的 minCharHeight（条文优先，否则实践下限）。
  const limit = minCharHeight(profile);
  if (limit !== undefined && metrics !== undefined && metrics.charHeightMm < limit.mm) {
    findings.push({
      id: "char-height-below-minimum",
      severity: "warn",
      message:
        `落版后图中数字与字母字高约 ${mm(metrics.charHeightMm)}，低于该法域字高下限 ${mm(limit.mm)}。` +
        `性质：${LIMIT_NATURE[limit.basis]}；出处：${charHeightProvision(profile, limit.basis)}。` +
        `请减少图面元件或缩小图幅后重排`,
    });
  }

  // 判据三：摘要附图缩放到 40×60 毫米后的字高（只报数值，不判定"清晰"）。
  if (abstractFigure === true && metrics !== undefined && metrics.placedWidthMm > 0 && metrics.placedHeightMm > 0) {
    const scale = Math.min(
      ABSTRACT_MAX_WIDTH_MM / metrics.placedWidthMm,
      ABSTRACT_MAX_HEIGHT_MM / metrics.placedHeightMm,
    );
    const scaled = metrics.charHeightMm * scale;
    findings.push({
      id: "abstract-figure-scaled-height",
      severity: "warn",
      message:
        `摘要附图缩小到 ${String(ABSTRACT_MAX_WIDTH_MM)}×${String(ABSTRACT_MAX_HEIGHT_MM)} 毫米时` +
        `图中数字与字母字高约 ${mm(scaled)}：` +
        `请人工确认各细节仍可分辨（《专利审查指南》第二部分第二章 2.4）；` +
        `本工具不判定『清晰』，清晰与否由人工判断`,
    });
  }

  return findings;
}
