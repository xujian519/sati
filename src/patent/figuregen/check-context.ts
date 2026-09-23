/**
 * src/patent/figuregen — 附图校验的共享件：规则上下文、派生量与纯辅助函数。
 *
 * 这里放**规则之间共享的东西**：条文措辞（basis）、标记提取与归一化、画幅计算，以及
 * {@link FigureRuleContext}——每条规则能读到的全部输入。规则本身在 `check-rules.ts`。
 *
 * 为什么与规则分两个文件：合并成一个会越过本仓的单文件行数上限（800），而把共享件与规则
 * 实现混在一处的代价正是本次重构要消除的——规则读到的量必须在上下文里显式声明，
 * "改一条规则会不会影响另一条"由类型而不是由行数来回答。
 *
 * 昂贵的派生量（V7 的画幅布局，涉及逐图 `layoutFigure`/`layoutChart`）经
 * {@link FigureRuleContext.layout} **惰性**求值：只有 V7 用得到，让每条规则都付这份代价
 * 是不可接受的。
 */

import { layoutChart } from "./chart.js";
import type { FigureCheckFinding, FigureCheckOptions, FigureCheckResult, FigureCheckRuleId } from "./check.js";
import { layoutFigure } from "./layout.js";
import { profileForJurisdiction, shouldRenderCaption, type OfficeProfile } from "./office-profile.js";
import { pxToMm, uniformFigureZoom } from "./page-contract.js";
import { splitSpecFaces, type SpecFaces } from "./spec-sections.js";
import type { FigureSpec, Jurisdiction } from "./types.js";
import { scanFigureWording, type WordingHit } from "./wording-rules.js";

/** V5 阈值：单行 label 最大字符数 / 最大行数（超出视为疑似注释性文字）。 */
export const COMMENT_LABEL_LINE_MAX = 40;
export const COMMENT_LABEL_LINES_MAX = 3;

/** V12–V14/V20/V21 证据行上限（超出只报条数，避免长图把报告淹没）。 */
export const WORDING_EVIDENCE_MAX = 15;

/** 按法域取依据措辞（CN 引 CN 条文，us 引 37 CFR，pct 引 PCT 细则/指南）。 */
export function basis(jurisdiction: Jurisdiction, texts: { cn: string; us: string; pct: string }): string {
  if (jurisdiction === "cn") return texts.cn;
  return jurisdiction === "us" ? texts.us : texts.pct;
}

/** 词边界匹配：说明书文字部分是否提及该标记（"S20"/"120" 不算提及标记 20）。 */
export function textMentionsRef(specText: string, ref: number): boolean {
  return new RegExp(`(?<![0-9A-Za-z])${ref}(?![0-9])`, "u").test(specText);
}

/** 提取说明书文字部分括号形式的疑似附图标记。 */
function extractBracketRefs(specText: string): number[] {
  const found = new Set<number>();
  for (const match of specText.matchAll(/[（(]\s*(\d{1,3})\s*[)）]/gu)) {
    found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

/** 剥离 label 中的括号标记后缀，得到组件名称主干。 */
export function stripRefMark(label: string): string {
  return label
    .replace(/[（(]\s*\d{1,3}\s*[)）]/gu, "")
    .split("\n")[0]
    .trim();
}

/**
 * 附图标记名称归一化（**仅用于比较**，不改变呈现形态）。
 *
 * 同一组件在图上可能写作「处理模块(20)」（附图惯例）或「处理模块20」（说明书正文
 * 惯例：名称+数字、不加括号）——两者指同一组成部分，V4 不得判为名称不一致。
 * 归一化 = 剥括号标记 + 剥尾部裸数字 + trim；`stripRefMark` 保持对外呈现形态
 * （brief.ts 依赖其输出格式）。
 */
export function normalizeRefLabel(label: string): string {
  return stripRefMark(label)
    .replace(/\s*\d{1,3}\s*$/u, "")
    .trim();
}

/**
 * 单幅附图的画幅（px）。曲线图由坐标图几何决定，其余图型由分层布局决定——
 * **核验与渲染必须同源**，否则 V7 量的是另一张图。
 */
function figureCanvasPx(figure: FigureSpec, caption: boolean): { width: number; height: number } {
  return figure.kind === "chart" ? layoutChart(figure.chart, { caption }) : layoutFigure(figure, { caption });
}

/** V7 的画幅量（惰性求值：只有 V7 用得到，见 FigureRuleContext.layout）。 */
export type FigureLayoutMetrics = {
  captionRendered: boolean;
  paperSizes: readonly { figure_no: number; widthMm: number; heightMm: number }[];
  zoom: number;
};

/**
 * 规则能读到的全部输入。
 *
 * 规则之间**不共享局部量**：任何跨规则使用的派生值都必须在这里显式声明，于是"改一条规则
 * 会不会影响另一条"由类型而不是由 500 行的阅读来回答。
 */
export type FigureRuleContext = {
  readonly figures: readonly FigureSpec[];
  readonly specText: string;
  readonly options: FigureCheckOptions;
  readonly jurisdiction: Jurisdiction;
  readonly profile: OfficeProfile;
  readonly figureCount: number;
  /** us 辖区（英语措辞 + 37 CFR 依据）。 */
  readonly us: boolean;
  /** 非 CN 辖区（CN 特有规则 V8/V9/V10/V11 的适用性由此决定）。 */
  readonly intl: boolean;
  readonly figureNos: readonly number[];
  /** 全部附图中出现的附图标记（去重升序）。 */
  readonly refsInFigures: readonly number[];
  /** 说明书文字部分以括号形式出现的疑似附图标记（去重升序）。 */
  readonly refsInText: readonly number[];
  /** V2/V3/V4 共用的依据措辞（三处必须一致，故在上下文里声明一次）。 */
  readonly refConsistencyBasis: string;
  /** V10/V11 的判定面（undefined = 未分面或该族规则不适用）。 */
  readonly faces: SpecFaces | undefined;
  /** 文字面分节情况（对调用方如实声明，勿静默）。 */
  readonly specFaces: FigureCheckResult["specFaces"];
  /** 括号规则（V10/V11）适用性：不适用的法域如实声明原因（pct）。 */
  readonly bracketRules: FigureCheckResult["bracketRules"];
  /** V12–V14 的图面用语命中（scanFigureWording 只跑一次，三条规则各取所需）。 */
  readonly wordingHits: readonly WordingHit[];
  /** V15/V16 的图号观测（undefined = 不可观测，不判——不猜）。 */
  readonly numberedFigureNos: readonly number[] | undefined;
  /** V7 的画幅量（惰性：涉及逐图布局，非 V7 的规则不该付这份代价）。 */
  layout(): FigureLayoutMetrics;
};

/** 一条校验规则：吃上下文，产出发现（纯函数，无副作用、不读时钟）。 */
export type FigureRule = {
  readonly id: FigureCheckRuleId;
  run(ctx: FigureRuleContext): FigureCheckFinding[];
};

/**
 * 组装规则上下文（派生量在此一次算清；昂贵的画幅量延后到 V7 真正需要时）。
 */
export function buildRuleContext(
  figures: readonly FigureSpec[],
  specText: string,
  options: FigureCheckOptions,
): FigureRuleContext {
  const jurisdiction: Jurisdiction = options.jurisdiction ?? "cn";
  const profile = profileForJurisdiction(jurisdiction);
  const figureCount = options.figureCount ?? figures.length;

  const refsInFigures = [
    ...new Set(figures.flatMap(f => f.nodes.flatMap(n => (n.ref === undefined ? [] : [n.ref])))),
  ].sort((a, b) => a - b);
  const refsInText = options.skipTextRules ? [] : extractBracketRefs(specText);

  // V10/V11 括号规则（需文字面分节成功；细则第 22 条：权利要求中的附图标记置于括号内，
  // 而说明书正文惯例为"名称+数字"。两个面的括号规则相反，故必须按面判定——
  // 分节失败时两条规则整体跳过并如实声明，不对混合文本猜面判违规。）
  //
  // pct 下整族跳过：这两条的判据是 CN 细则第 22 条与中文正文惯例，PCT 体例下未核验
  // （PCT Rule 6.2(b) 只规定权利要求"可以"带括号标记，未规定正文惯例），不猜。
  const bracketRulesApply = jurisdiction !== "pct";
  const explicitFaces = options.faces;
  const faces =
    options.skipTextRules === true || !bracketRulesApply
      ? undefined
      : explicitFaces !== undefined
        ? {
            ...explicitFaces,
            reason:
              "调用方显式分面（claims_text/description_text）" +
              (explicitFaces.claims === undefined ? "；未提供权利要求面（V10 未生效）" : "") +
              (explicitFaces.description === undefined ? "；未提供正文面（V11 未生效）" : ""),
          }
        : splitSpecFaces(specText);
  const specFaces =
    faces === undefined
      ? undefined
      : {
          sectioned: faces.claims !== undefined || faces.description !== undefined,
          reason: faces.reason,
        };
  const bracketRules = bracketRulesApply
    ? undefined
    : {
        applied: false,
        reason:
          "pct 未适用 CN 括号规则（V10/V11 依据细则第 22 条与中文正文惯例，PCT 体例下未核验；" +
          "PCT Rule 6.2(b) 只规定权利要求“可以”带括号标记）",
      };

  let layoutCache: FigureLayoutMetrics | undefined;
  return {
    figures,
    specText,
    options,
    jurisdiction,
    profile,
    figureCount,
    us: jurisdiction === "us",
    intl: jurisdiction !== "cn",
    figureNos: figures.map(f => f.figure_no),
    refsInFigures,
    refsInText,
    refConsistencyBasis: basis(jurisdiction, {
      cn: "细则第 21 条",
      us: "37 CFR 1.84; MPEP 608.02",
      pct: "细则第 21 条口径（PCT 细则未规定图文标记的双向对应）",
    }),
    faces,
    specFaces,
    bracketRules,
    wordingHits: scanFigureWording(figures, jurisdiction),
    numberedFigureNos: options.numberedFigureNos,
    layout(): FigureLayoutMetrics {
      if (layoutCache !== undefined) return layoutCache;
      const captionRendered = shouldRenderCaption(profile, figureCount);
      // 画幅不可量的图（回读骨架）逐图排除：见 skipLayoutFigureNos 的选项文档。
      const skipLayoutNos = new Set(options.skipLayoutFigureNos ?? []);
      const paperSizes = options.skipLayoutRules
        ? []
        : figures
            .filter(figure => !skipLayoutNos.has(figure.figure_no))
            .map(figure => {
              const { width, height } = figureCanvasPx(figure, captionRendered);
              return { figure_no: figure.figure_no, widthMm: pxToMm(width), heightMm: pxToMm(height) };
            });
      layoutCache = { captionRendered, paperSizes, zoom: uniformFigureZoom(paperSizes, profile) };
      return layoutCache;
    },
  };
}
