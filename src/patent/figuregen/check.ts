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
 *   **介质锚定**（A4 可印区 + 毫米，常量与 html.ts 同源）——画幅超出可印区会被
 *   分页切断 ⇒ FAIL（metric=page_fit）；打印字高低于最小可辨字高 ⇒ WARN
 *   （metric=font_size，证据给出实际 mm 与再缩 2/3 后的 mm）
 * - V8 说明书有附图的应指定一幅摘要附图（指南一部一章 4.5.2）：多图未指定/
 *   指定多幅 → WARN
 * - V9 实用新型附图是说明书组成部分，应当有附图（指南一部二章 7.3 + 细则 20.5）
 * - V12/V13/V14 图面用语（细则第 21 条第 3 款 + 指南一部一章 4.3；纯函数在
 *   `wording-rules.ts`，依据与法域适用性见该模块头注）：只吃图面词语（节点 label +
 *   边标签），不吃说明书正文——正文侧括号规则由 V10/V11 覆盖，不重复报。
 *   V12 非必需注释/禁止标注 → WARN；V13 图面词语非中文（仅 cn）→ WARN；
 *   V14 标号形态（小写字母后缀；数字与括号/引号/圈号连用仅非 cn）→ WARN
 *
 * V6（黑白线条）为渲染器构造期不变式，由 render-svg 单测保证，不在此重复。
 */

import { layoutFigure } from "./layout.js";
import { FIGURE_FONT_SIZE } from "./metrics.js";
import {
  LEGIBILITY_SHRINK_FACTOR,
  MIN_PRINTED_FONT_MM,
  PRINTABLE_HEIGHT_MM,
  PRINTABLE_WIDTH_MM,
  pxToMm,
  uniformFigureZoom,
} from "./page-contract.js";
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
  | "V14";

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
  /** 发明/实用新型（V9 仅对 utility 生效；US 辖区无此规则）。 */
  documentKind?: DocumentKind;
  /** 辖区（默认 cn）：us 跳过 V8 摘要附图/V9 实用新型规则，违规信息引用 37 CFR 1.84。 */
  jurisdiction?: Jurisdiction;
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

  // V1 图号连续编号
  const figureNos = figures.map(f => f.figure_no);
  const sortedNos = [...figureNos].sort((a, b) => a - b);
  const expected = Array.from({ length: figures.length }, (_, i) => i + 1);
  const duplicated = sortedNos.filter((no, i) => i > 0 && no === sortedNos[i - 1]);
  const us = options.jurisdiction === "us";
  const v1Basis = us
    ? "37 CFR 1.84: views should be numbered in consecutive sequence (FIG. 1, FIG. 2, ...)"
    : "细则第 21 条：附图应按'图1，图2……'顺序编号";
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
      message: us
        ? "Reference numeral shown in a figure but not described in the specification (V2, 37 CFR 1.84; MPEP 608.02)"
        : "附图中出现的附图标记未在说明书文字部分中提及（V2，细则第 21 条）",
      evidence: missingEvidence,
    });
  }

  // V3 文→图（保守 WARN）
  const orphanRefs = options.skipTextRules ? [] : refsInText.filter(ref => !refsInFigures.includes(ref));
  if (orphanRefs.length > 0) {
    findings.push({
      rule: "V3",
      severity: "warn",
      message: us
        ? "Bracketed numeral in the specification not found in any figure (V3, 37 CFR 1.84; may not be a reference numeral — confirm manually)"
        : "说明书文字部分出现的括号标记未出现于任何附图（V3，细则第 21 条；数字未必是附图标记，请人工确认）",
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
          message: `同一附图标记应始终表示同一组成部分（V4，${us ? "37 CFR 1.84" : "细则第 21 条"}）`,
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
        message: us
          ? "Same reference numeral maps to different component names across figures (V4, 37 CFR 1.84)"
          : "同一附图标记跨图对应不同名称（V4，细则第 21 条：表示同一组成部分的附图标记应当一致）",
        evidence: [`标记 ${ref} 对应多个名称：${[...names].join(" / ")}`],
      });
    }
  }
  for (const [id, refs] of idToRefs) {
    if (refs.size > 1) {
      findings.push({
        rule: "V4",
        severity: "fail",
        message: `同一节点跨图使用了不同附图标记（V4，${us ? "37 CFR 1.84" : "细则第 21 条"}）`,
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

  // V10/V11 括号规则（需文字面分节成功；细则第 22 条：权利要求中的附图标记置于括号内，
  // 而说明书正文惯例为"名称+数字"。两个面的括号规则相反，故必须按面判定——
  // 分节失败时两条规则整体跳过并如实声明，不对混合文本猜面判违规。）
  const explicitFaces = options.faces;
  const faces =
    options.skipTextRules === true
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

  // V7 缩小三分之二可辨（介质锚定：A4 可印区 + 打印字高毫米）；skipLayoutRules 时跳过
  // （骨架类输入的画幅不由本模块决定，见 FigureCheckOptions.skipLayoutRules）。
  //
  // 判据来自交付形态（A4 打印），不是画幅像素：px 代理与纸面脱钩，12 步流程图画幅
  // 355mm 高仍"通过"却会被分页切断（实测，见 docs/patent-figure-hardening-plan.md §3）。
  // 统一缩放系数（uniformFigureZoom，与 html.ts 同源）保证同文档字高一致，
  // 故字高判定用统一系数而非单图系数（后者会高估实际打印字高）。
  const paperSizes = options.skipLayoutRules
    ? []
    : figures.map(figure => {
        const { width, height } = layoutFigure(figure);
        return { figure_no: figure.figure_no, widthMm: pxToMm(width), heightMm: pxToMm(height) };
      });
  const zoom = uniformFigureZoom(paperSizes);
  for (const size of paperSizes) {
    const oversize = size.widthMm > PRINTABLE_WIDTH_MM || size.heightMm > PRINTABLE_HEIGHT_MM;
    if (oversize) {
      findings.push({
        rule: "V7",
        severity: "fail",
        metric: "page_fit",
        message:
          `图${size.figure_no} 纸面尺寸 ${size.widthMm.toFixed(1)}×${size.heightMm.toFixed(1)}mm 超出 A4 可印区` +
          ` ${PRINTABLE_WIDTH_MM}×${PRINTABLE_HEIGHT_MM}mm（V7，指南一部一章 4.3：缩小到三分之二时仍应能清晰分辨` +
          `图中各个细节）——超出部分会被分页切断，应拆分为多幅附图或减小画幅（当前需缩至 ${(zoom * 100).toFixed(0)}%）`,
        figure_nos: [size.figure_no],
      });
    }
    const printed = pxToMm(FIGURE_FONT_SIZE) * zoom;
    if (printed < MIN_PRINTED_FONT_MM) {
      findings.push({
        rule: "V7",
        severity: "warn",
        metric: "font_size",
        message:
          `图${size.figure_no} 图内文字打印字高约 ${printed.toFixed(2)}mm 低于最小可辨字高 ${MIN_PRINTED_FONT_MM}mm` +
          `（V7，指南一部一章 4.3：缩小到三分之二仍应清晰可辨），建议减少节点文字或拆分附图`,
        figure_nos: [size.figure_no],
        evidence: [
          `纸面缩放系数 ${zoom.toFixed(2)}，再缩 2/3 后字高约 ${(printed * LEGIBILITY_SHRINK_FACTOR).toFixed(2)}mm`,
        ],
      });
    }
  }

  // V8 摘要附图指定（CNIPA 特有：USPTO 无摘要附图制度）
  if (figures.length > 1 && !us) {
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

  // V9 实用新型必须有附图（CNIPA 特有：USPTO 无实用新型制度）
  if (!us && options.documentKind === "utility" && figures.length === 0) {
    findings.push({
      rule: "V9",
      severity: "fail",
      message:
        "实用新型申请未提供任何附图（V9，指南一部二章 7.3 + 细则第 20 条第 5 款：附图是说明书组成部分，实用新型应当有附图）",
    });
  }

  // V12–V14 图面用语（依据与法域适用性见 wording-rules.ts 头注；skipTextRules 不跳过——
  // 三条规则吃的是图面词语，与说明书文本无关）。
  const wordingHits = scanFigureWording(figures, options.jurisdiction ?? "cn");
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

  return {
    ok: !findings.some(f => f.severity === "fail"),
    findings,
    refsInFigures,
    refsInText,
    ...(specFaces === undefined ? {} : { specFaces }),
  };
}
