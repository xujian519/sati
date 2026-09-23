/**
 * src/patent/figuregen — 附图确定性校验器（V1–V5、V7–V9；V6 为渲染器不变式）。
 *
 * 本文件是**规则的说明书与装配点**：条文依据、判据含义、以及对外类型契约在这里；每条规则的
 * 实现与注册表在 `check-rules.ts`（原先 21 条规则挤在一个 503 行的函数里共用一个作用域，
 * 改一条必须通读 500 行——拆开的原因与纪律见该文件头注）。
 *
 * 规则依据（溯源锚见 skills/patent-illustrator/references/cn-drawing-rules.md）：
 * - V1 附图按"图1，图2……"顺序编号排列（细则 2023 第 21 条第 1 款）
 * - V2 说明书文字部分中未提及的附图标记不得在附图中出现（细则第 21 条）
 * - V3 附图中未出现的附图标记不得在说明书文字部分中提及（细则第 21 条）。
 *   文本侧数字未必是附图标记（如"步骤S20""三步法"），故仅提取括号形式标记
 *   且降级为 WARN，证据供人工确认，避免硬 FAIL 打断撰写流程。
 * - V4 表示同一组成部分的附图标记应当一致（细则第 21 条）；名称比较经
 *   normalizeRefLabel 归一化——「处理模块(20)」与「处理模块20」属同一组成部分，
 *   标注书写形态差异不构成违规
 * - V5 附图中除必需的词语外不应当含有其他注释（细则第 21 条第 3 款，官方全文已核验）：
 *   label 疑似注释性长文（超长单行/多行段落）→ WARN
 * - V10 权利要求中的附图标记应当置于括号内（细则第 22 条）：权利要求面出现"名称+裸数字"
 *   → FAIL（需文字面分节成功；判据收窄至"紧跟列举分隔符/行尾"，避免数量词/数值范围误报）
 * - V11 说明书正文惯例为"名称+数字"（与权利要求面规则相反）：正文面以括号引用图内标记
 *   → WARN（排除 式(1)/步骤(1)/图(1) 与附图说明小节"1—混料器"式样）
 * - V7 附图缩小到三分之二时仍应能清晰分辨细节（指南一部一章 4.3，官方已核验）：
 *   **介质锚定**（法域档案的可印区 + 毫米，常量与 html.ts 同源）——画幅超出可印区会被
 *   分页切断 ⇒ FAIL（metric=page_fit）；打印字高低于该法域的字高下限 ⇒ WARN
 *   （metric=font_size）。字高下限取自**档案**：CN 无附图专有的条文数值（第五部分第一章
 *   5.2 的 3.5mm 是纸件申请正文的通用要求），故用实践下限 2.0mm 并在 message 里注明
 *   "实践下限（非法条数值）"；PCT/US 为条文数值 3.2mm（PCT Rule 11.13(h) / 37 CFR
 *   1.84(p)(3)）
 * - V8 说明书有附图的应指定一幅摘要附图（指南一部一章 4.5.2）：多图未指定/
 *   指定多幅 → WARN（CNIPA 特有，非 cn 辖区跳过）
 * - V9 实用新型附图是说明书组成部分，应当有附图（指南一部二章 7.3 + 细则 20.5；非 cn 跳过）
 * - V12/V13/V14 图面用语（细则第 21 条第 3 款 + 指南一部一章 4.3；纯函数在
 *   `wording-rules.ts`，依据与法域适用性见该模块头注）：只吃图面词语（节点 label +
 *   边标签），不吃说明书正文——正文侧括号规则由 V10/V11 覆盖，不重复报。
 *   V12 非必需注释/禁止标注 → WARN；V13 图面词语非中文（仅 cn）→ WARN；
 *   V14 标号形态（小写字母后缀；数字与括号/引号/圈号连用仅非 cn）→ WARN
 * - V15 多幅却未标注图号 → FAIL（编号义务：指南一部一章 4.3「附图总数在两幅以上的，应当
 *   使用阿拉伯数字顺序编号」/ PCT Rule 11.13(k) / 37 CFR 1.84(u)(1)）
 * - V16 单幅却标注图号 → WARN（**仅 pct/us**：PCT 指南 IP 5.141 与 37 CFR 1.84(u)(1)
 *   明令单幅不得编号、不得出现 "Fig."/"FIG."；CN 只是把编号义务系于两幅以上，未禁止，
 *   故对 CN 不判——Sati 自家 CN 产物默认带"图1"，判它只会制造噪音）
 * - V17 多页附图未声明页码 → WARN（CN 指南 4.3/5.6「说明书附图应当用阿拉伯数字顺序编写
 *   页码」；PCT 行政规程 207(b)(iii) 与 37 CFR 1.84(t) 规定 1/3 体例）
 * - V18 伪状态符号节点（circle/doublecircle）含文字 → WARN。**依据是渲染契约而非条文**：
 *   实心圆/双圈是符号形状，渲染器不输出其 label（黑底黑字不可见）⇒ 写了文字会静默丢失；
 *   需要文字的状态请用 round（状态框）。不引条文，避免把工具契约伪装成法条要求。
 * - V19 实用新型的附图全部为曲线图 → WARN（细则 2023 第二十条第五款"实用新型专利申请说明书
 *   应当有表示要求保护的产品的形状、构造或者其结合的附图"；专利法第二条第三款同向）。
 *   性能曲线图不是形状/构造视图 ⇒ 只有曲线图的实用新型申请不满足该款。**只在看全本案
 *   （figureCount === figures.length）时判**：分次核验只拿到部分附图时无从判断是否有结构视图；
 *   且结构视图可能由 CAD 通路单独产出（不进本数组）⇒ 级别为 warn，措辞是"请确认"而非"违规"。
 *   ⚠️ 不引"指南一部二章 7.3(10)"：该条号在可核验的来源里未能确认（deepseek-harness 的
 *   `plot-diagram.ts` 如此引用，但未见其核验出处），本模块只引已核验的条文。
 * - V20 同一曲线图内两条曲线的线型与标记完全相同 → WARN。**渲染契约非条文**：黑白附图
 *   不得用颜色区分曲线，标记与线型是唯二的区分手段，两者都相同则图面上无从分辨。
 * - V21 曲线图有数据点落在坐标轴范围之外 → WARN。**渲染契约非条文**：轴外数据点会被画到
 *   绘图区之外、压住刻度值与轴标目（渲染器有意不裁剪——裁剪会把超范围数据画成贴边失真）。
 *
 * V15/V16 需要**可观测的交付形态**（已交付 SVG 的图号回读）才判：只有结构化 FigureSpec
 * 而没有交付文件时，图号是渲染期由本模块决定的，对"看不见的东西"判违规属错误归因。
 *
 * V6（黑白线条）为渲染器构造期不变式，由 render-svg 单测保证，不在此重复。
 */

import { buildRuleContext } from "./check-context.js";
import { evaluateFigureRules } from "./check-rules.js";
import type { DocumentKind, FigureSpec, Jurisdiction } from "./types.js";

// 共享件在 check-context.ts、规则与注册表在 check-rules.ts；此处**原样再导出**，使既有导入面
// （bridge.ts / brief.ts 从 check.js 取 stripRefMark，barrel 取常量，spec 取阈值）不变。
export {
  COMMENT_LABEL_LINE_MAX,
  COMMENT_LABEL_LINES_MAX,
  WORDING_EVIDENCE_MAX,
  normalizeRefLabel,
  stripRefMark,
  type FigureLayoutMetrics,
  type FigureRule,
  type FigureRuleContext,
} from "./check-context.js";

export type FigureCheckSeverity = "fail" | "warn" | "info";

export type FigureCheckRuleId =
  | "V1"
  | "V2"
  | "V3"
  | "V4"
  | "V5"
  | "V7"
  | "V8"
  | "V9"
  | "V10"
  | "V11"
  | "V12"
  | "V13"
  | "V14"
  | "V15"
  | "V16"
  | "V17"
  | "V18"
  | "V19"
  | "V20"
  | "V21";

export type FigureCheckOptions = {
  /** 生成期无说明书文本可核时跳过 V2/V3（V1/V4/V5/V7/V8/V9 照常）。 */
  skipTextRules?: boolean;
  /**
   * 显式文字面（调用方已知权利要求/说明书分界时提供，**替代启发式分节**）。
   * 缺省走 `splitSpecFaces` 的启发式；分节失败时 V10/V11 静默并由 `specFaces.reason` 说明。
   */
  faces?: { claims?: string; description?: string; descriptionSansBrief?: string };
  /**
   * 跳过画幅规则 V7（纸面尺寸 + 打印字高）。
   *
   * 用于**整批**附图都是非本模块渲染器产出的骨架（如只有栅格图/扫描图时）：那类图的画幅
   * 与字号由原图决定，用本模块布局结果判 V7 属错误归因（必然误报）。只跳过其中几幅时用
   * {@link FigureCheckOptions.skipLayoutFigureNos}。
   */
  skipLayoutRules?: boolean;
  /**
   * 画幅不由本模块布局决定的图号（逐图粒度，这些图不参与 V7 的纸面尺寸判据）。
   *
   * 与 `skipLayoutRules` 的分工：那个是"这批图都不可量"，这个是"这几幅图不可量、其余照判"。
   * 场景是**混合核验**——结构化 `figures` 与 `svg_paths` 回读骨架同时给出时，前者照判 V7，
   * 后者必须排除。
   *
   * 为什么回读骨架必须排除：`svg_paths` 的骨架来自**已交付 SVG**，有标记与文本但**没有
   * 几何**（`readback.ts` 只认 `<g>` 的 id/data-ref 与 `<text>`）。拿它喂 `layoutFigure`
   * 等于让核验器按另一种图型（且是没有原始方向/坐标的图型）重新排一张图，V7 量的是那张
   * 重排图的画幅，不是交付画幅——实测一张 34.4×220.7mm 的合规横向框图会被重排成
   * 282.0×37.3mm 并判 fail，代理师照报告去拆图/缩画幅，而报告里的 282mm 并不存在。
   * 反向同样坏：曲线图回读时骨架 `nodes` 为空，V7 变成对一张空骨架的测量，属覆盖假象。
   *
   * 排除的只是 V7 的画幅判据：V1–V5、V15–V17（图号可见形态）等仍照常作用于这些图。
   */
  skipLayoutFigureNos?: readonly number[];
  /** 发明/实用新型（V9 仅对 utility 生效；非 cn 辖区无此规则）。 */
  documentKind?: DocumentKind;
  /**
   * 辖区（默认 cn）：us 跳过 V8/V9 与 CN 特有措辞并引 37 CFR；pct 再跳过 V10/V11
   * （CN 括号规则在 PCT 体例下未核验，不猜）。
   */
  jurisdiction?: Jurisdiction;
  /**
   * 本案附图**总幅数**（缺省取本次核验的附图数）。
   *
   * 与 `figures.length` 可能不同：分次调用生成附图、或只核验其中一幅时，只有调用方知道总数；
   * 它决定图号是否需要标注（档案 `shouldRenderCaption`）⇒ 也决定 V7 量的画幅高度。
   */
  figureCount?: number;
  /**
   * **已交付 SVG 回读到的图号集合**（带可见图号的图号）。
   *
   * 只有给了它才判 V15/V16——图号的可见形态只在交付文件里可观测；结构化 FigureSpec
   * 没有"是否带图号"这一信息，缺省不判（不猜）。
   */
  numberedFigureNos?: readonly number[];
  /** 附图页序号（多页附图；缺省不判 V17）。 */
  sheetIndex?: number;
  /** 附图页总页数（≥2 时要求声明页码，V17）。 */
  sheetTotal?: number;
};

export type FigureCheckFinding = {
  rule: FigureCheckRuleId;
  severity: FigureCheckSeverity;
  message: string;
  figure_nos?: number[];
  evidence?: string[];
  /** V7 判定维度：page_fit=可印区/分页切断；font_size=打印字高可辨性。 */
  metric?: "page_fit" | "font_size";
};

export type FigureCheckResult = {
  /** 无 fail 级 finding。 */
  ok: boolean;
  findings: FigureCheckFinding[];
  /** 全部附图中出现的附图标记（去重升序）。 */
  refsInFigures: number[];
  /** 说明书文字部分以括号形式出现的疑似附图标记（去重升序）。 */
  refsInText: number[];
  /** 文字面分节情况：V10/V11 是否需要分面、分面是否成功（如实声明，勿静默）。 */
  specFaces?: { sectioned: boolean; reason: string };
  /** 括号规则（V10/V11）适用性：不适用的法域如实声明原因（pct）。 */
  bracketRules?: { applied: boolean; reason: string };
};

/**
 * 按注册表跑全部规则并汇总。
 *
 * 装配 = 建上下文（派生量在此一次算清）→ 跑规则 → 拼结果。规则的产出顺序即报告顺序
 * （注册表顺序是契约，见 `check-rules.ts` 的 FIGURE_RULES）。
 */
export function checkFigures(
  figures: readonly FigureSpec[],
  specText: string,
  options: FigureCheckOptions = {},
): FigureCheckResult {
  const ctx = buildRuleContext(figures, specText, options);
  const findings = evaluateFigureRules(ctx);
  return {
    ok: !findings.some(finding => finding.severity === "fail"),
    findings,
    refsInFigures: [...ctx.refsInFigures],
    refsInText: [...ctx.refsInText],
    ...(ctx.specFaces === undefined ? {} : { specFaces: ctx.specFaces }),
    ...(ctx.bracketRules === undefined ? {} : { bracketRules: ctx.bracketRules }),
  };
}
