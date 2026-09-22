/**
 * src/patent/figuregen — 附图确定性校验器（V1–V5、V7–V9；V6 为渲染器不变式）。
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
 *
 * V15/V16 需要**可观测的交付形态**（已交付 SVG 的图号回读）才判：只有结构化 FigureSpec
 * 而没有交付文件时，图号是渲染期由本模块决定的，对"看不见的东西"判违规属错误归因。
 *
 * V6（黑白线条）为渲染器构造期不变式，由 render-svg 单测保证，不在此重复。
 */

import { isSymbolShape, layoutFigure } from "./layout.js";
import { FIGURE_FONT_SIZE } from "./metrics.js";
import {
  minCharHeight,
  printableArea,
  profileForJurisdiction,
  sheetNumberText,
  shouldRenderCaption,
} from "./office-profile.js";
import { LEGIBILITY_SHRINK_FACTOR, pxToMm, uniformFigureZoom } from "./page-contract.js";
import { splitSpecFaces } from "./spec-sections.js";
import type { DocumentKind, FigureSpec, Jurisdiction } from "./types.js";
import { scanFigureWording, type WordingHit, type WordingRuleId } from "./wording-rules.js";

/** V5 阈值：单行 label 最大字符数 / 最大行数（超出视为疑似注释性文字）。 */
export const COMMENT_LABEL_LINE_MAX = 40;
export const COMMENT_LABEL_LINES_MAX = 3;

/** V12–V14 证据行上限（超出只报条数，避免长图把报告淹没）。 */
export const WORDING_EVIDENCE_MAX = 15;

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
  | "V18";

/** 按法域取依据措辞（CN 引 CN 条文，us 引 37 CFR，pct 引 PCT 细则/指南）。 */
function basis(jurisdiction: Jurisdiction, texts: { cn: string; us: string; pct: string }): string {
  if (jurisdiction === "cn") return texts.cn;
  return jurisdiction === "us" ? texts.us : texts.pct;
}

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
   * 用于**非本模块渲染器产出**的附图骨架（如栅格图/扫描图的分析结果）：那类图的画幅
   * 与字号由原图决定，用本模块布局结果判 V7 属错误归因（必然误报）。
   */
  skipLayoutRules?: boolean;
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

/** 词边界匹配：说明书文字部分是否提及该标记（"S20"/"120" 不算提及标记 20）。 */
function textMentionsRef(specText: string, ref: number): boolean {
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

/** V12–V14 依据措辞（cn 引 CN 条文；域外引 37 CFR 1.84 与 PCT 明文，逐条溯源见 references/*.md）。 */
const WORDING_MESSAGES: Record<WordingRuleId, { cn: string; intl: string }> = {
  V12: {
    cn: "附图图面含非必需注释或禁止标注（V12，细则第 21 条第 3 款：附图中除必需的词语外，不应当含有其他注释）",
    intl: 'Non-essential annotation on the drawing surface (V12, 37 CFR 1.84(k) / PCT Guide 5.150: indications such as "actual size" or "scale 1/2" are not permitted)',
  },
  V13: {
    cn: "附图图面词语应使用中文（V13，指南一部一章 4.3：附图中的词语应当使用中文，必要时可以在其后的括号里注明原文）",
    intl: "Figure wording should be in Chinese (V13, CNIPA Guidelines Part I Chapter 1 §4.3)",
  },
  V14: {
    cn: "附图标记形态不规范（V14，指南一部一章 4.3：附图标记应当使用阿拉伯数字编号）",
    intl: "Non-conforming reference-numeral form (V14, 37 CFR 1.84(p)(1) / PCT Rule 11.13(e): brackets, circles or inverted commas must not be used in association with numbers and letters)",
  },
};

/** 按规则聚合证据行（同一处缺陷只报一次；超上限只报条数）。 */
function buildWordingEvidence(hits: readonly WordingHit[]): string[] {
  const lines = [...new Set(hits.map(hit => `图${hit.figure_no} ${hit.where} ${hit.describe}：「${hit.text}」`))];
  if (lines.length <= WORDING_EVIDENCE_MAX) return lines;
  return [...lines.slice(0, WORDING_EVIDENCE_MAX), `（另有 ${lines.length - WORDING_EVIDENCE_MAX} 处同类命中）`];
}

export function checkFigures(
  figures: readonly FigureSpec[],
  specText: string,
  options: FigureCheckOptions = {},
): FigureCheckResult {
  const findings: FigureCheckFinding[] = [];
  const jurisdiction: Jurisdiction = options.jurisdiction ?? "cn";
  const profile = profileForJurisdiction(jurisdiction);
  const figureCount = options.figureCount ?? figures.length;

  // V1 图号连续编号
  const figureNos = figures.map(f => f.figure_no);
  const sortedNos = [...figureNos].sort((a, b) => a - b);
  const expected = Array.from({ length: figures.length }, (_, i) => i + 1);
  const duplicated = sortedNos.filter((no, i) => i > 0 && no === sortedNos[i - 1]);
  const us = jurisdiction === "us";
  const intl = jurisdiction !== "cn";
  const v1Basis = basis(jurisdiction, {
    cn: "细则第 21 条：附图应按'图1，图2……'顺序编号",
    us: "37 CFR 1.84(u)(1): views must be numbered in consecutive Arabic numerals, starting with 1",
    pct: "PCT Rule 11.13(k): figures numbered in Arabic numerals consecutively",
  });
  // V2/V3/V4 的依据：CN 有明文；us 引 37 CFR；pct 细则未规定图文标记双向对应，按 CN 口径
  // 执行并如实标注（不把 CN 条文伪装成 PCT 条文，也不因未核验就悄悄不判）。
  const refConsistencyBasis = basis(jurisdiction, {
    cn: "细则第 21 条",
    us: "37 CFR 1.84; MPEP 608.02",
    pct: "细则第 21 条口径（PCT 细则未规定图文标记的双向对应）",
  });
  if (figures.length === 0) {
    findings.push({
      rule: "V1",
      severity: "fail",
      message: `未提供任何附图（V1，${v1Basis}）`,
    });
  } else if (duplicated.length > 0 || sortedNos.some((no, i) => no !== expected[i])) {
    findings.push({
      rule: "V1",
      severity: "fail",
      message: `附图编号应为 1..${figures.length} 连续排列，实际为 [${figureNos.join(", ")}]（V1，${v1Basis}）`,
      figure_nos: figureNos,
    });
  }

  // 标记回流（skipTextRules 时文本侧规则整体跳过：生成期尚无说明书文本可核）
  const refsInFigures = [
    ...new Set(figures.flatMap(f => f.nodes.flatMap(n => (n.ref === undefined ? [] : [n.ref])))),
  ].sort((a, b) => a - b);
  const refsInText = options.skipTextRules ? [] : extractBracketRefs(specText);

  // V2 图→文
  const missingEvidence: string[] = [];
  if (!options.skipTextRules) {
    for (const figure of figures) {
      for (const node of figure.nodes) {
        if (node.ref === undefined) continue;
        if (!textMentionsRef(specText, node.ref)) {
          missingEvidence.push(
            `图${figure.figure_no} 节点「${node.label.replace(/\n/gu, " ")}」标记 ${node.ref} 未在说明书文字部分出现`,
          );
        }
      }
    }
  }
  if (missingEvidence.length > 0) {
    findings.push({
      rule: "V2",
      severity: "fail",
      message: intl
        ? "Reference numeral shown in a figure but not described in the specification (V2, 37 CFR 1.84; MPEP 608.02)"
        : `附图中出现的附图标记未在说明书文字部分中提及（V2，${refConsistencyBasis}）`,
      evidence: missingEvidence,
    });
  }

  // V3 文→图（保守 WARN）
  const orphanRefs = options.skipTextRules ? [] : refsInText.filter(ref => !refsInFigures.includes(ref));
  if (orphanRefs.length > 0) {
    findings.push({
      rule: "V3",
      severity: "warn",
      message: intl
        ? "Bracketed numeral in the specification not found in any figure (V3, 37 CFR 1.84; may not be a reference numeral — confirm manually)"
        : `说明书文字部分出现的括号标记未出现于任何附图（V3，${refConsistencyBasis}；数字未必是附图标记，请人工确认）`,
      evidence: orphanRefs.map(ref => `括号标记 ${ref} 未出现于任何附图`),
    });
  }

  // V4 一致性
  const refToNames = new Map<number, Set<string>>();
  const idToRefs = new Map<string, Set<number>>();
  for (const figure of figures) {
    const refToNodeIds = new Map<number, Set<string>>();
    for (const node of figure.nodes) {
      if (node.ref !== undefined) {
        const names = refToNames.get(node.ref) ?? new Set<string>();
        names.add(normalizeRefLabel(node.label));
        refToNames.set(node.ref, names);

        const ids = refToNodeIds.get(node.ref) ?? new Set<string>();
        ids.add(node.id);
        refToNodeIds.set(node.ref, ids);
      }
      const refs = idToRefs.get(node.id) ?? new Set<number>();
      if (node.ref !== undefined) refs.add(node.ref);
      idToRefs.set(node.id, refs);
    }
    for (const [ref, ids] of refToNodeIds) {
      if (ids.size > 1) {
        findings.push({
          rule: "V4",
          severity: "fail",
          message: `同一附图标记应始终表示同一组成部分（V4，${refConsistencyBasis}）`,
          figure_nos: [figure.figure_no],
          evidence: [`图${figure.figure_no} 中标记 ${ref} 重复用于 ${ids.size} 个不同节点`],
        });
      }
    }
  }
  for (const [ref, names] of refToNames) {
    if (names.size > 1) {
      findings.push({
        rule: "V4",
        severity: "fail",
        message: intl
          ? "Same reference numeral maps to different component names across figures (V4, 37 CFR 1.84)"
          : `同一附图标记跨图对应不同名称（V4，${refConsistencyBasis}：表示同一组成部分的附图标记应当一致）`,
        evidence: [`标记 ${ref} 对应多个名称：${[...names].join(" / ")}`],
      });
    }
  }
  for (const [id, refs] of idToRefs) {
    if (refs.size > 1) {
      findings.push({
        rule: "V4",
        severity: "fail",
        message: `同一节点跨图使用了不同附图标记（V4，${refConsistencyBasis}）`,
        evidence: [`节点 id「${id}」跨图标记不一致：${[...refs].join(" / ")}`],
      });
    }
  }

  // V5 禁注释（保守 WARN：疑似注释性长文）
  const annotationEvidence: string[] = [];
  for (const figure of figures) {
    for (const node of figure.nodes) {
      const lines = node.label.split("\n");
      const longest = Math.max(...lines.map(line => line.length));
      if (lines.length > COMMENT_LABEL_LINES_MAX || longest > COMMENT_LABEL_LINE_MAX) {
        annotationEvidence.push(
          `图${figure.figure_no} 节点「${node.id}」label 疑似注释性文字（${lines.length} 行，最长 ${longest} 字符）`,
        );
      }
    }
  }
  if (annotationEvidence.length > 0) {
    findings.push({
      rule: "V5",
      severity: "warn",
      message: "附图节点文字疑似含注释性段落（V5，细则第 21 条第 3 款：附图中除必需的词语外不应当含有其他注释）",
      evidence: annotationEvidence,
    });
  }

  // V18 伪状态符号节点不应含文字（渲染契约，非条文——实心圆/双圈不渲染 label，文字会静默丢失）。
  const symbolTextEvidence: string[] = [];
  for (const figure of figures) {
    for (const node of figure.nodes) {
      if (!isSymbolShape(node.shape) || node.label.trim() === "") continue;
      const refNote = node.ref === undefined ? "" : `，标记 ${node.ref} 亦随之不显示`;
      symbolTextEvidence.push(
        `图${figure.figure_no} 节点「${node.id}」形状 ${node.shape} 为符号，label「${node.label.replace(/\n/gu, " ")}」不被渲染${refNote}`,
      );
    }
  }
  if (symbolTextEvidence.length > 0) {
    findings.push({
      rule: "V18",
      severity: "warn",
      message:
        "符号形状节点（circle/doublecircle）含文字，文字不会被渲染（V18，渲染契约非条文：实心圆/双圈不输出 label；带文字的状态请用 round 形状）",
      evidence: symbolTextEvidence,
    });
  }

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

  // V10 权利要求面：附图标记未置于括号内（"组件名+裸数字"，且其后为列举分隔符或行尾）。
  // 判据有意收窄：只认"紧跟分隔符/行尾"的裸标记，避免把数量词（"共 20 个"）、
  // 数值范围（"20℃至 90℃"）判成附图标记——代价是漏掉句中夹缝形态（已在报告面注明）。
  if (faces?.claims !== undefined && refsInFigures.length > 0) {
    const evidence: string[] = [];
    for (const ref of refsInFigures) {
      const pattern = new RegExp(`[\\u4e00-\\u9fff]{2,}\\s*${ref}(?=\\s*(?:[，,；;、。：:]|$))`, "gmu");
      const match = pattern.exec(faces.claims);
      if (match !== null) {
        evidence.push(`权利要求面出现未加括号的附图标记 ${ref}：「${match[0].trim()}」`);
      }
    }
    if (evidence.length > 0) {
      findings.push({
        rule: "V10",
        severity: "fail",
        message: us
          ? "Reference numeral in a claim is not enclosed in parentheses (V10, 37 CFR 1.84; MPEP 608.02)"
          : "权利要求中的附图标记未置于括号内（V10，细则第 22 条：附图标记应当置于括号内）",
        evidence,
      });
    }
  }

  // V11 说明书正文面：以括号形式引用附图标记（惯例为"名称+数字"）。
  // 排除公式/步骤/图号编号（式(1)、步骤(1)、图(1)）与"附图说明"小节（"1—混料器"式样）。
  if (faces?.description !== undefined && refsInFigures.length > 0) {
    const scope = faces.descriptionSansBrief ?? faces.description;
    const evidence: string[] = [];
    for (const match of scope.matchAll(/[（(]\s*(\d{1,3})\s*[)）]/gu)) {
      const ref = Number(match[1]);
      if (!refsInFigures.includes(ref)) continue;
      const before = scope.slice(Math.max(0, (match.index ?? 0) - 2), match.index ?? 0);
      if (/(?:式|公式|步骤|第|图|表|claim|step|formula|fig)s?$/iu.test(before)) continue;
      evidence.push(`说明书正文以括号引用附图标记 ${ref}：「${(match[0] ?? "").trim()}」`);
    }
    if (evidence.length > 0) {
      findings.push({
        rule: "V11",
        severity: "warn",
        message: us
          ? "Bracketed numeral in the description; the customary form is name-then-numeral (V11)"
          : "说明书正文以括号形式引用附图标记（V11：正文惯例为「名称+数字」，括号形式仅用于权利要求）",
        evidence,
      });
    }
  }

  // V7 缩小三分之二可辨（介质锚定：法域档案的可印区 + 打印字高毫米）；skipLayoutRules 时跳过
  // （骨架类输入的画幅不由本模块决定，见 FigureCheckOptions.skipLayoutRules）。
  //
  // 判据来自交付形态（打印稿），不是画幅像素：px 代理与纸面脱钩，12 步流程图画幅
  // 355mm 高仍"通过"却会被分页切断（实测，见 docs/patent-figure-hardening-plan.md §3）。
  // 统一缩放系数（uniformFigureZoom，与 html.ts 同源）保证同文档字高一致，
  // 故字高判定用统一系数而非单图系数（后者会高估实际打印字高）。
  //
  // 画幅必须与渲染同源：图号是否需要标注由图幅数与档案决定，**不编号时画幅少一条标注带**
  // （layoutFigure 的 caption 选项），核验器与渲染器用同一判据，否则量的是另一张图。
  const captionRendered = shouldRenderCaption(profile, figureCount);
  const area = printableArea(profile);
  const charHeight = minCharHeight(profile);
  const paperSizes = options.skipLayoutRules
    ? []
    : figures.map(figure => {
        const { width, height } = layoutFigure(figure, { caption: captionRendered });
        return { figure_no: figure.figure_no, widthMm: pxToMm(width), heightMm: pxToMm(height) };
      });
  const zoom = uniformFigureZoom(paperSizes, profile);
  const pageFitBasis = basis(jurisdiction, {
    cn: "指南一部一章 4.3：缩小到三分之二时仍应能清晰分辨图中各个细节",
    us: "37 CFR 1.84(g)：sight no greater than 17.0 cm by 26.2 cm on A4",
    pct: "PCT Rule 11.6(c)：usable surface shall not exceed 26.2 cm x 17.0 cm",
  });
  for (const size of paperSizes) {
    const oversize = size.widthMm > area.widthMm || size.heightMm > area.heightMm;
    if (oversize) {
      findings.push({
        rule: "V7",
        severity: "fail",
        metric: "page_fit",
        message:
          `图${size.figure_no} 纸面尺寸 ${size.widthMm.toFixed(1)}×${size.heightMm.toFixed(1)}mm 超出` +
          `${profile.office} 可印区 ${area.widthMm.toFixed(1)}×${area.heightMm.toFixed(1)}mm（V7，${pageFitBasis}）` +
          `——超出部分会被分页切断，应拆分为多幅附图或减小画幅（当前需缩至 ${(zoom * 100).toFixed(0)}%）`,
        figure_nos: [size.figure_no],
      });
    }
    const printed = pxToMm(FIGURE_FONT_SIZE) * zoom;
    if (charHeight !== undefined && printed < charHeight.mm) {
      const limitNote =
        charHeight.basis === "statute"
          ? `最小字高 ${charHeight.mm}mm`
          : `最小字高 ${charHeight.mm}mm（实践下限，非法条数值——CN 无附图专有的字高条文）`;
      findings.push({
        rule: "V7",
        severity: "warn",
        metric: "font_size",
        message:
          `图${size.figure_no} 图内文字打印字高约 ${printed.toFixed(2)}mm 低于 ${limitNote}` +
          `（V7，${basis(jurisdiction, {
            cn: "指南一部一章 4.3：缩小到三分之二仍应清晰可辨",
            us: "37 CFR 1.84(p)(3)：numbers, letters and reference characters must measure at least .32 cm in height",
            pct: "PCT Rule 11.13(h)：the height of the numbers and letters shall not be less than 0.32 cm",
          })}），建议减少节点文字或拆分附图`,
        figure_nos: [size.figure_no],
        evidence: [
          `纸面缩放系数 ${zoom.toFixed(2)}，再缩 2/3 后字高约 ` +
            `${(printed * profile.reductionRatio).toFixed(2)}mm（LEGIBILITY_SHRINK_FACTOR=${LEGIBILITY_SHRINK_FACTOR}）`,
        ],
      });
    }
  }

  // V8 摘要附图指定（CNIPA 特有：PCT/US 无摘要附图制度）
  if (figures.length > 1 && !intl) {
    const abstractNos = figures.filter(f => f.abstract === true).map(f => f.figure_no);
    if (abstractNos.length === 0) {
      findings.push({
        rule: "V8",
        severity: "warn",
        message: "多幅附图未指定摘要附图（V8，指南一部一章 4.5.2：应指定一幅最能说明主要技术特征的附图作为摘要附图）",
        evidence: [`在 FigureSpec 上设置 abstract: true（图号：${figureNos.join(", ")}）`],
      });
    } else if (abstractNos.length > 1) {
      findings.push({
        rule: "V8",
        severity: "warn",
        message: "摘要附图指定了多幅（V8，指南一部一章 4.5.2：应指定其中一幅）",
        evidence: [`当前指定：图${abstractNos.join("、图")}`],
      });
    }
  }

  // V9 实用新型必须有附图（CNIPA 特有：PCT/US 无实用新型制度）
  if (!intl && options.documentKind === "utility" && figures.length === 0) {
    findings.push({
      rule: "V9",
      severity: "fail",
      message:
        "实用新型申请未提供任何附图（V9，指南一部二章 7.3 + 细则第 20 条第 5 款：附图是说明书组成部分，实用新型应当有附图）",
    });
  }

  // V12–V14 图面用语（依据与法域适用性见 wording-rules.ts 头注；skipTextRules 不跳过——
  // 三条规则吃的是图面词语，与说明书文本无关）。
  const wordingHits = scanFigureWording(figures, jurisdiction);
  for (const rule of ["V12", "V13", "V14"] as const) {
    const hits = wordingHits.filter(hit => hit.rule === rule);
    if (hits.length === 0) continue;
    findings.push({
      rule,
      severity: hits.some(hit => hit.severity === "warn") ? "warn" : "info",
      message: us ? WORDING_MESSAGES[rule].intl : WORDING_MESSAGES[rule].cn,
      evidence: buildWordingEvidence(hits),
    });
  }

  // V15/V16 图号义务。只在**交付形态可观测**时判（调用方给 numberedFigureNos，即已交付 SVG
  // 的回读结果）：结构化 FigureSpec 里没有"是否带图号"这一信息，缺省不判（不猜）。
  const numbered = options.numberedFigureNos;
  if (numbered !== undefined && figures.length > 0) {
    const numberingBasis = basis(jurisdiction, {
      cn: "指南一部一章 4.3：附图总数在两幅以上的，应当使用阿拉伯数字顺序编号，并在编号前冠以“图”字",
      us: "37 CFR 1.84(u)(1)：view numbers must be preceded by the abbreviation “FIG.”",
      pct: "PCT Rule 11.13(k)：figures shall be numbered in Arabic numerals consecutively",
    });
    const missingNos = figures.filter(figure => !numbered.includes(figure.figure_no)).map(f => f.figure_no);
    if (figureCount >= 2 && missingNos.length > 0) {
      findings.push({
        rule: "V15",
        severity: "fail",
        message: `本案附图共 ${figureCount} 幅，每一幅都应当标注图号（V15，${numberingBasis}）`,
        figure_nos: missingNos,
        evidence: missingNos.map(no => `图${no} 的交付 SVG 中未找到图号标注`),
      });
    }
    if (figureCount < 2 && numbered.length > 0 && profile.forbidCaptionWhenSingle) {
      findings.push({
        rule: "V16",
        severity: "warn",
        message:
          "仅一幅附图时不得编号、不得出现 “Fig.”/“FIG.”（V16，" +
          basis(jurisdiction, {
            cn: "CN 未禁止单幅编号（本条不判）",
            us: "37 CFR 1.84(u)(1)：where only a single view is used … it must not be numbered and the abbreviation “FIG.” must not appear",
            pct: "PCT 申请人指南 IP 5.141：where a single figure is sufficient … it should not be numbered and the abbreviation Fig. should not appear",
          }) +
          "）",
        figure_nos: [...numbered],
        evidence: numbered.map(no => `图${no} 带图号标注，而本案只有一幅附图`),
      });
    }
  }

  // V17 多页附图的页码声明：页码是**页级**要素（不在单幅图内），故只在调用方声明了页数、
  // 却没给出页码信息时判——"每份附图集都没页码"这类全局判定属错误归因（Sati 在只出单幅
  // SVG 的路径上不合成最终图页；需页码时应走落版页或由代理师按模板排页）。
  if (options.sheetTotal !== undefined && options.sheetTotal >= 2) {
    const sheetBasis = basis(jurisdiction, {
      cn: "指南一部一章 4.3 + 五部一章 5.6：说明书附图应当用阿拉伯数字顺序编写页码，页码置于每页下部页边的上沿并左右居中",
      us: "37 CFR 1.84(t)：the number of each sheet by two Arabic numerals on either side of an oblique line",
      pct: "PCT 行政规程 Section 207(b)(iii)：1/3, 2/3, 3/3",
    });
    const { sheetIndex, sheetTotal } = options;
    if (sheetIndex === undefined || sheetIndex < 1 || sheetIndex > sheetTotal) {
      findings.push({
        rule: "V17",
        severity: "warn",
        message: `本案附图共 ${sheetTotal} 页，须逐页声明页码（V17，${sheetBasis}）`,
        evidence: [
          sheetIndex === undefined
            ? `未声明附图页序号；本图页按档案体例应写作 ${sheetNumberText(profile, 1, sheetTotal)}`
            : `附图页序号 ${sheetIndex} 超出 1..${sheetTotal}`,
        ],
      });
    }
  }

  const bracketRules = bracketRulesApply
    ? undefined
    : {
        applied: false,
        reason:
          "pct 未适用 CN 括号规则（V10/V11 依据细则第 22 条与中文正文惯例，PCT 体例下未核验；" +
          "PCT Rule 6.2(b) 只规定权利要求“可以”带括号标记）",
      };

  return {
    ok: !findings.some(f => f.severity === "fail"),
    findings,
    refsInFigures,
    refsInText,
    ...(specFaces === undefined ? {} : { specFaces }),
    ...(bracketRules === undefined ? {} : { bracketRules }),
  };
}
