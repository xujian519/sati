/**
 * src/patent/figuregen — 附图校验规则（V1–V21）与注册表。
 *
 * 为什么拆出来：这些规则原先挤在一个 503 行的 `checkFigures` 里，**共用一个作用域**——
 * 规则之间通过 `skipLayoutRules`/`figureCount`/`zoom` 这类共享局部量相互牵动，改一条规则
 * 必须通读 500 行并确认与其它规则的相互作用。拆成「上下文 + 每条规则一个纯函数」后，一条
 * 规则能读到的量由 {@link FigureRuleContext} 的字段写死，耦合在编译期可见。
 *
 * 两条纪律：
 * - **判据语义逐字不变**：本文件是搬运而非改写；规则之间的顺序与产出顺序也是契约
 *   （报告与既有 spec 按顺序断言）；
 * - **共享件不在此处**：条文措辞、标记归一化、画幅计算在 `check-context.ts`，本文件只放
 *   规则本身与注册表。
 *
 * 各条规则的条文依据与判据说明见 `check.ts` 的模块头注（那是**规则的说明书**，此处不复述）。
 */

import { chartOutOfRange, chartStyleConflicts } from "./chart.js";
import type { FigureCheckFinding, FigureCheckSeverity } from "./check.js";
import {
  basis,
  COMMENT_LABEL_LINE_MAX,
  COMMENT_LABEL_LINES_MAX,
  normalizeRefLabel,
  textMentionsRef,
  WORDING_EVIDENCE_MAX,
  type FigureRule,
  type FigureRuleContext,
} from "./check-context.js";
import { isSymbolShape } from "./layout.js";
import { FIGURE_FONT_SIZE } from "./metrics.js";
import { minCharHeight, printableArea, sheetNumberText } from "./office-profile.js";
import { LEGIBILITY_SHRINK_FACTOR, pxToMm } from "./page-contract.js";
import type { FigureSpec } from "./types.js";
import type { WordingHit, WordingRuleId } from "./wording-rules.js";

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
  return capEvidence(lines);
}

/** 证据行封顶（超出只报条数，避免长清单把报告淹没）。 */
function capEvidence(lines: readonly string[]): string[] {
  if (lines.length <= WORDING_EVIDENCE_MAX) return [...lines];
  return [...lines.slice(0, WORDING_EVIDENCE_MAX), `（另有 ${lines.length - WORDING_EVIDENCE_MAX} 处同类命中）`];
}
/** V1 图号连续编号（细则第 21 条：附图应按"图1，图2……"顺序编号）。 */
const ruleV1: FigureRule = {
  id: "V1",
  run(ctx) {
    const v1Basis = basis(ctx.jurisdiction, {
      cn: "细则第 21 条：附图应按'图1，图2……'顺序编号",
      us: "37 CFR 1.84(u)(1): views must be numbered in consecutive Arabic numerals, starting with 1",
      pct: "PCT Rule 11.13(k): figures numbered in Arabic numerals consecutively",
    });
    if (ctx.figures.length === 0) {
      return [{ rule: "V1", severity: "fail", message: `未提供任何附图（V1，${v1Basis}）` }];
    }
    const sortedNos = [...ctx.figureNos].sort((a, b) => a - b);
    const expected = Array.from({ length: ctx.figures.length }, (_, i) => i + 1);
    const duplicated = sortedNos.filter((no, i) => i > 0 && no === sortedNos[i - 1]);
    if (duplicated.length === 0 && sortedNos.every((no, i) => no === expected[i])) return [];
    return [
      {
        rule: "V1",
        severity: "fail",
        message: `附图编号应为 1..${ctx.figures.length} 连续排列，实际为 [${ctx.figureNos.join(", ")}]（V1，${v1Basis}）`,
        figure_nos: [...ctx.figureNos],
      },
    ];
  },
};

/** V2 图→文：说明书文字部分中未提及的附图标记不得在附图中出现。 */
const ruleV2: FigureRule = {
  id: "V2",
  run(ctx) {
    if (ctx.options.skipTextRules) return [];
    const missingEvidence: string[] = [];
    for (const figure of ctx.figures) {
      for (const node of figure.nodes) {
        if (node.ref === undefined) continue;
        if (!textMentionsRef(ctx.specText, node.ref)) {
          missingEvidence.push(
            `图${figure.figure_no} 节点「${node.label.replace(/\n/gu, " ")}」标记 ${node.ref} 未在说明书文字部分出现`,
          );
        }
      }
    }
    if (missingEvidence.length === 0) return [];
    return [
      {
        rule: "V2",
        severity: "fail",
        message: ctx.intl
          ? "Reference numeral shown in a figure but not described in the specification (V2, 37 CFR 1.84; MPEP 608.02)"
          : `附图中出现的附图标记未在说明书文字部分中提及（V2，${ctx.refConsistencyBasis}）`,
        evidence: missingEvidence,
      },
    ];
  },
};

/** V3 文→图（保守 WARN：文本侧数字未必是附图标记）。 */
const ruleV3: FigureRule = {
  id: "V3",
  run(ctx) {
    if (ctx.options.skipTextRules) return [];
    const orphanRefs = ctx.refsInText.filter(ref => !ctx.refsInFigures.includes(ref));
    if (orphanRefs.length === 0) return [];
    return [
      {
        rule: "V3",
        severity: "warn",
        message: ctx.intl
          ? "Bracketed numeral in the specification not found in any figure (V3, 37 CFR 1.84; may not be a reference numeral — confirm manually)"
          : `说明书文字部分出现的括号标记未出现于任何附图（V3，${ctx.refConsistencyBasis}；数字未必是附图标记，请人工确认）`,
        evidence: orphanRefs.map(ref => `括号标记 ${ref} 未出现于任何附图`),
      },
    ];
  },
};

/** V4 一致性：同一标记同一组成部分、跨图名称一致、同一节点跨图标记一致。 */
const ruleV4: FigureRule = {
  id: "V4",
  run(ctx) {
    const findings: FigureCheckFinding[] = [];
    const refToNames = new Map<number, Set<string>>();
    const idToRefs = new Map<string, Set<number>>();
    for (const figure of ctx.figures) {
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
            message: `同一附图标记应始终表示同一组成部分（V4，${ctx.refConsistencyBasis}）`,
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
          message: ctx.intl
            ? "Same reference numeral maps to different component names across figures (V4, 37 CFR 1.84)"
            : `同一附图标记跨图对应不同名称（V4，${ctx.refConsistencyBasis}：表示同一组成部分的附图标记应当一致）`,
          evidence: [`标记 ${ref} 对应多个名称：${[...names].join(" / ")}`],
        });
      }
    }
    for (const [id, refs] of idToRefs) {
      if (refs.size > 1) {
        findings.push({
          rule: "V4",
          severity: "fail",
          message: `同一节点跨图使用了不同附图标记（V4，${ctx.refConsistencyBasis}）`,
          evidence: [`节点 id「${id}」跨图标记不一致：${[...refs].join(" / ")}`],
        });
      }
    }
    return findings;
  },
};

/** V5 禁注释（保守 WARN：疑似注释性长文）。 */
const ruleV5: FigureRule = {
  id: "V5",
  run(ctx) {
    const annotationEvidence: string[] = [];
    for (const figure of ctx.figures) {
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
    if (annotationEvidence.length === 0) return [];
    return [
      {
        rule: "V5",
        severity: "warn",
        message: "附图节点文字疑似含注释性段落（V5，细则第 21 条第 3 款：附图中除必需的词语外不应当含有其他注释）",
        evidence: annotationEvidence,
      },
    ];
  },
};

/** V18 伪状态符号节点不应含文字（渲染契约，非条文——实心圆/双圈不渲染 label，文字会静默丢失）。 */
const ruleV18: FigureRule = {
  id: "V18",
  run(ctx) {
    const symbolTextEvidence: string[] = [];
    for (const figure of ctx.figures) {
      for (const node of figure.nodes) {
        if (!isSymbolShape(node.shape) || node.label.trim() === "") continue;
        const refNote = node.ref === undefined ? "" : `，标记 ${node.ref} 亦随之不显示`;
        symbolTextEvidence.push(
          `图${figure.figure_no} 节点「${node.id}」形状 ${node.shape} 为符号，label「${node.label.replace(/\n/gu, " ")}」不被渲染${refNote}`,
        );
      }
    }
    if (symbolTextEvidence.length === 0) return [];
    return [
      {
        rule: "V18",
        severity: "warn",
        message:
          "符号形状节点（circle/doublecircle）含文字，文字不会被渲染（V18，渲染契约非条文：实心圆/双圈不输出 label；带文字的状态请用 round 形状）",
        evidence: symbolTextEvidence,
      },
    ];
  },
};

/** V19 实用新型不得仅有性能曲线图（只在看全本案时判）。 */
const ruleV19: FigureRule = {
  id: "V19",
  run(ctx) {
    if (
      ctx.jurisdiction !== "cn" ||
      ctx.options.documentKind !== "utility" ||
      ctx.figures.length === 0 ||
      ctx.figureCount !== ctx.figures.length ||
      !ctx.figures.every(figure => figure.kind === "chart")
    ) {
      return [];
    }
    return [
      {
        rule: "V19",
        severity: "warn",
        message:
          "实用新型的附图全部为曲线图，未见表示产品形状、构造的附图（V19，细则第 20 条第 5 款：" +
          "实用新型专利申请说明书应当有表示要求保护的产品的形状、构造或者其结合的附图）——请确认本案另有结构视图" +
          "（若结构视图由 CAD 通路单独产出，可忽略本提示）",
        figure_nos: ctx.figures.map(figure => figure.figure_no),
        evidence: ctx.figures.map(
          figure => `图${figure.figure_no} kind=chart（曲线图只表达性能数据，不是形状/构造视图）`,
        ),
      },
    ];
  },
};

/** 曲线图逐图收集证据（V20/V21 共用一次遍历）。 */
function chartEvidence(ctx: FigureRuleContext, pick: (chart: FigureSpec["chart"]) => string[]): string[] {
  const evidence: string[] = [];
  for (const figure of ctx.figures) {
    if (figure.kind !== "chart") continue;
    for (const line of pick(figure.chart)) {
      evidence.push(`图${figure.figure_no} ${line}`);
    }
  }
  return evidence;
}

/** V20 同一曲线图内两条曲线的线型与标记完全相同（渲染契约，非条文）。 */
const ruleV20: FigureRule = {
  id: "V20",
  run(ctx) {
    const evidence = chartEvidence(ctx, chartStyleConflicts);
    if (evidence.length === 0) return [];
    return [
      {
        rule: "V20",
        severity: "warn",
        message:
          "同一曲线图内两条曲线的线型与标记完全相同，图面上无从分辨（V20，渲染契约非条文：" +
          "黑白附图不得用颜色区分曲线，标记与线型是唯二的区分手段；改用不同的 marker/line）",
        evidence: capEvidence(evidence),
      },
    ];
  },
};

/** V21 曲线图有数据点落在坐标轴范围之外（渲染契约：渲染器有意不裁剪）。 */
const ruleV21: FigureRule = {
  id: "V21",
  run(ctx) {
    const evidence = chartEvidence(ctx, chartOutOfRange);
    if (evidence.length === 0) return [];
    return [
      {
        rule: "V21",
        severity: "warn",
        message:
          "曲线图有数据点落在坐标轴范围之外，会被画到绘图区之外（V21，渲染契约非条文：" +
          "渲染器有意不裁剪数据；请扩大 x/y 的 min/max 或修正数据）",
        evidence: capEvidence(evidence),
      },
    ];
  },
};

/**
 * V10 权利要求面：附图标记未置于括号内（"组件名+裸数字"，且其后为列举分隔符或行尾）。
 *
 * 判据有意收窄：只认"紧跟分隔符/行尾"的裸标记，避免把数量词（"共 20 个"）、
 * 数值范围（"20℃至 90℃"）判成附图标记——代价是漏掉句中夹缝形态（已在报告面注明）。
 */
const ruleV10: FigureRule = {
  id: "V10",
  run(ctx) {
    if (ctx.faces?.claims === undefined || ctx.refsInFigures.length === 0) return [];
    const evidence: string[] = [];
    for (const ref of ctx.refsInFigures) {
      const pattern = new RegExp(`[\\u4e00-\\u9fff]{2,}\\s*${ref}(?=\\s*(?:[，,；;、。：:]|$))`, "gmu");
      const match = pattern.exec(ctx.faces.claims);
      if (match !== null) {
        evidence.push(`权利要求面出现未加括号的附图标记 ${ref}：「${match[0].trim()}」`);
      }
    }
    if (evidence.length === 0) return [];
    return [
      {
        rule: "V10",
        severity: "fail",
        message: ctx.us
          ? "Reference numeral in a claim is not enclosed in parentheses (V10, 37 CFR 1.84; MPEP 608.02)"
          : "权利要求中的附图标记未置于括号内（V10，细则第 22 条：附图标记应当置于括号内）",
        evidence,
      },
    ];
  },
};

/**
 * V11 说明书正文面：以括号形式引用附图标记（惯例为"名称+数字"）。
 * 排除公式/步骤/图号编号（式(1)、步骤(1)、图(1)）与"附图说明"小节（"1—混料器"式样）。
 */
const ruleV11: FigureRule = {
  id: "V11",
  run(ctx) {
    if (ctx.faces?.description === undefined || ctx.refsInFigures.length === 0) return [];
    const scope = ctx.faces.descriptionSansBrief ?? ctx.faces.description;
    const evidence: string[] = [];
    for (const match of scope.matchAll(/[（(]\s*(\d{1,3})\s*[)）]/gu)) {
      const ref = Number(match[1]);
      if (!ctx.refsInFigures.includes(ref)) continue;
      const before = scope.slice(Math.max(0, (match.index ?? 0) - 2), match.index ?? 0);
      if (/(?:式|公式|步骤|第|图|表|claim|step|formula|fig)s?$/iu.test(before)) continue;
      evidence.push(`说明书正文以括号引用附图标记 ${ref}：「${(match[0] ?? "").trim()}」`);
    }
    if (evidence.length === 0) return [];
    return [
      {
        rule: "V11",
        severity: "warn",
        message: ctx.us
          ? "Bracketed numeral in the description; the customary form is name-then-numeral (V11)"
          : "说明书正文以括号形式引用附图标记（V11：正文惯例为「名称+数字」，括号形式仅用于权利要求）",
        evidence,
      },
    ];
  },
};

/**
 * V7 缩小三分之二可辨（介质锚定：法域档案的可印区 + 打印字高毫米）。
 *
 * 判据来自交付形态（打印稿），不是画幅像素：px 代理与纸面脱钩，12 步流程图画幅
 * 355mm 高仍"通过"却会被分页切断（实测，见 docs/patent-figure-hardening-plan.md §3）。
 * 统一缩放系数（uniformFigureZoom，与 html.ts 同源）保证同文档字高一致，
 * 故字高判定用统一系数而非单图系数（后者会高估实际打印字高）。
 *
 * 画幅必须与渲染同源：图号是否需要标注由图幅数与档案决定，**不编号时画幅少一条标注带**
 * （layoutFigure 的 caption 选项），核验器与渲染器用同一判据，否则量的是另一张图。
 */
const ruleV7: FigureRule = {
  id: "V7",
  run(ctx) {
    const { profile, jurisdiction } = ctx;
    const area = printableArea(profile);
    const charHeight = minCharHeight(profile);
    const { paperSizes, zoom } = ctx.layout();
    const pageFitBasis = basis(jurisdiction, {
      cn: "指南一部一章 4.3：缩小到三分之二时仍应能清晰分辨图中各个细节",
      us: "37 CFR 1.84(g)：sight no greater than 17.0 cm by 26.2 cm on A4",
      pct: "PCT Rule 11.6(c)：usable surface shall not exceed 26.2 cm x 17.0 cm",
    });
    const fontBasis = basis(jurisdiction, {
      cn: "指南一部一章 4.3：缩小到三分之二仍应清晰可辨",
      us: "37 CFR 1.84(p)(3)：numbers, letters and reference characters must measure at least .32 cm in height",
      pct: "PCT Rule 11.13(h)：the height of the numbers and letters shall not be less than 0.32 cm",
    });
    const findings: FigureCheckFinding[] = [];
    for (const size of paperSizes) {
      // 画幅算不出（NaN/Infinity）时判据恒为 false ⇒ 静默"通过"。核验器的职责是不假装通过，
      // 故显式 fail：算不出的尺寸与超限的尺寸同样不可交付。（渲染期已保证不产 NaN——退化轴在
      // `axisTicks` 里被撑开，入参层另有拒绝；这里是判据侧的最后一道。）
      if (!Number.isFinite(size.widthMm) || !Number.isFinite(size.heightMm)) {
        findings.push({
          rule: "V7",
          severity: "fail",
          metric: "page_fit",
          message:
            `图${size.figure_no} 的画幅无法度量（宽 ${size.widthMm}、高 ${size.heightMm}）：` +
            `核验器不对算不出的尺寸判通过（V7，${pageFitBasis}）——请检查该图的坐标数据`,
          figure_nos: [size.figure_no],
        });
        continue;
      }
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
            `（V7，${fontBasis}），建议减少节点文字或拆分附图`,
          figure_nos: [size.figure_no],
          evidence: [
            `纸面缩放系数 ${zoom.toFixed(2)}，再缩 2/3 后字高约 ` +
              `${(printed * profile.reductionRatio).toFixed(2)}mm（LEGIBILITY_SHRINK_FACTOR=${LEGIBILITY_SHRINK_FACTOR}）`,
          ],
        });
      }
    }
    return findings;
  },
};

/** V8 摘要附图指定（CNIPA 特有：PCT/US 无摘要附图制度）。 */
const ruleV8: FigureRule = {
  id: "V8",
  run(ctx) {
    if (ctx.figures.length <= 1 || ctx.intl) return [];
    const abstractNos = ctx.figures.filter(f => f.abstract === true).map(f => f.figure_no);
    if (abstractNos.length === 0) {
      return [
        {
          rule: "V8",
          severity: "warn",
          message: "多幅附图未指定摘要附图（V8，指南一部一章 4.5.2：应指定一幅最能说明主要技术特征的附图作为摘要附图）",
          evidence: [`在 FigureSpec 上设置 abstract: true（图号：${ctx.figureNos.join(", ")}）`],
        },
      ];
    }
    if (abstractNos.length > 1) {
      return [
        {
          rule: "V8",
          severity: "warn",
          message: "摘要附图指定了多幅（V8，指南一部一章 4.5.2：应指定其中一幅）",
          evidence: [`当前指定：图${abstractNos.join("、图")}`],
        },
      ];
    }
    return [];
  },
};

/** V9 实用新型必须有附图（CNIPA 特有：PCT/US 无实用新型制度）。 */
const ruleV9: FigureRule = {
  id: "V9",
  run(ctx) {
    if (ctx.intl || ctx.options.documentKind !== "utility" || ctx.figures.length > 0) return [];
    return [
      {
        rule: "V9",
        severity: "fail",
        message:
          "实用新型申请未提供任何附图（V9，指南一部二章 7.3 + 细则第 20 条第 5 款：附图是说明书组成部分，实用新型应当有附图）",
      },
    ];
  },
};

/** V12/V13/V14 图面用语（三条共用一个命中集合，措辞与级别各按规则取）。 */
function wordingRule(id: WordingRuleId): FigureRule {
  return {
    id,
    run(ctx) {
      const hits = ctx.wordingHits.filter(hit => hit.rule === id);
      if (hits.length === 0) return [];
      const severity: FigureCheckSeverity = hits.some(hit => hit.severity === "warn") ? "warn" : "info";
      return [
        {
          rule: id,
          severity,
          message: ctx.us ? WORDING_MESSAGES[id].intl : WORDING_MESSAGES[id].cn,
          evidence: buildWordingEvidence(hits),
        },
      ];
    },
  };
}

/**
 * V15/V16 图号义务。只在**交付形态可观测**时判（调用方给 numberedFigureNos，即已交付 SVG
 * 的回读结果）：结构化 FigureSpec 里没有"是否带图号"这一信息，缺省不判（不猜）。
 */
const ruleV15: FigureRule = {
  id: "V15",
  run(ctx) {
    const numbered = ctx.numberedFigureNos;
    if (numbered === undefined || ctx.figures.length === 0 || ctx.figureCount < 2) return [];
    const missingNos = ctx.figures.filter(figure => !numbered.includes(figure.figure_no)).map(f => f.figure_no);
    if (missingNos.length === 0) return [];
    return [
      {
        rule: "V15",
        severity: "fail",
        message: `本案附图共 ${ctx.figureCount} 幅，每一幅都应当标注图号（V15，${basis(ctx.jurisdiction, {
          cn: "指南一部一章 4.3：附图总数在两幅以上的，应当使用阿拉伯数字顺序编号，并在编号前冠以“图”字",
          us: "37 CFR 1.84(u)(1)：view numbers must be preceded by the abbreviation “FIG.”",
          pct: "PCT Rule 11.13(k)：figures shall be numbered in Arabic numerals consecutively",
        })})`,
        figure_nos: missingNos,
        evidence: missingNos.map(no => `图${no} 的交付 SVG 中未找到图号标注`),
      },
    ];
  },
};

/** V16 单幅却标注图号（仅 pct/us：CN 未禁止单幅编号，判它只会制造噪音）。 */
const ruleV16: FigureRule = {
  id: "V16",
  run(ctx) {
    const numbered = ctx.numberedFigureNos;
    if (
      numbered === undefined ||
      ctx.figures.length === 0 ||
      ctx.figureCount >= 2 ||
      numbered.length === 0 ||
      !ctx.profile.forbidCaptionWhenSingle
    ) {
      return [];
    }
    return [
      {
        rule: "V16",
        severity: "warn",
        message:
          "仅一幅附图时不得编号、不得出现 “Fig.”/“FIG.”（V16，" +
          basis(ctx.jurisdiction, {
            cn: "CN 未禁止单幅编号（本条不判）",
            us: "37 CFR 1.84(u)(1)：where only a single view is used … it must not be numbered and the abbreviation “FIG.” must not appear",
            pct: "PCT 申请人指南 IP 5.141：where a single figure is sufficient … it should not be numbered and the abbreviation Fig. should not appear",
          }) +
          "）",
        figure_nos: [...numbered],
        evidence: numbered.map(no => `图${no} 带图号标注，而本案只有一幅附图`),
      },
    ];
  },
};

/**
 * V17 多页附图的页码声明：页码是**页级**要素（不在单幅图内），故只在调用方声明了页数、
 * 却没给出页码信息时判——"每份附图集都没页码"这类全局判定属错误归因（Sati 在只出单幅
 * SVG 的路径上不合成最终图页；需页码时应走落版页或由代理师按模板排页）。
 */
const ruleV17: FigureRule = {
  id: "V17",
  run(ctx) {
    const { sheetIndex, sheetTotal } = ctx.options;
    if (sheetTotal === undefined || sheetTotal < 2) return [];
    if (sheetIndex !== undefined && sheetIndex >= 1 && sheetIndex <= sheetTotal) return [];
    return [
      {
        rule: "V17",
        severity: "warn",
        message: `本案附图共 ${sheetTotal} 页，须逐页声明页码（V17，${basis(ctx.jurisdiction, {
          cn: "指南一部一章 4.3 + 五部一章 5.6：说明书附图应当用阿拉伯数字顺序编写页码，页码置于每页下部页边的上沿并左右居中",
          us: "37 CFR 1.84(t)：the number of each sheet by two Arabic numerals on either side of an oblique line",
          pct: "PCT 行政规程 Section 207(b)(iii)：1/3, 2/3, 3/3",
        })})`,
        evidence: [
          sheetIndex === undefined
            ? `未声明附图页序号；本图页按档案体例应写作 ${sheetNumberText(ctx.profile, 1, sheetTotal)}`
            : `附图页序号 ${sheetIndex} 超出 1..${sheetTotal}`,
        ],
      },
    ];
  },
};

/**
 * 规则注册表。
 *
 * **顺序是契约**：报告里的发现顺序与 24 个 spec 的断言都按它排列（不是号码顺序——V18–V21
 * 是后加的规则，当年按实现顺序追加，改序会让既有快照与人工习惯同时失配）。新增规则请追加
 * 到末尾，而不是按号码插入。
 */
export const FIGURE_RULES: readonly FigureRule[] = [
  ruleV1,
  ruleV2,
  ruleV3,
  ruleV4,
  ruleV5,
  ruleV18,
  ruleV19,
  ruleV20,
  ruleV21,
  ruleV10,
  ruleV11,
  ruleV7,
  ruleV8,
  ruleV9,
  wordingRule("V12"),
  wordingRule("V13"),
  wordingRule("V14"),
  ruleV15,
  ruleV16,
  ruleV17,
];

/** 按注册表顺序跑全部规则（规则的产出顺序即报告顺序）。 */
export function evaluateFigureRules(ctx: FigureRuleContext): FigureCheckFinding[] {
  const findings: FigureCheckFinding[] = [];
  for (const rule of FIGURE_RULES) {
    findings.push(...rule.run(ctx));
  }
  return findings;
}
