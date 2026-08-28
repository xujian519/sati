/**
 * src/patent/figuregen — 附图确定性校验器（V1–V5、V7–V9；V6 为渲染器不变式）。
 *
 * 规则依据（溯源锚见 skills/patent-illustrator/references/cn-drawing-rules.md）：
 * - V1 附图按"图1，图2……"顺序编号排列（细则 2023 第 21 条第 1 款）
 * - V2 说明书文字部分中未提及的附图标记不得在附图中出现（细则第 21 条）
 * - V3 附图中未出现的附图标记不得在说明书文字部分中提及（细则第 21 条）。
 *   文本侧数字未必是附图标记（如"步骤S20""三步法"），故仅提取括号形式标记
 *   且降级为 WARN，证据供人工确认，避免硬 FAIL 打断撰写流程。
 * - V4 表示同一组成部分的附图标记应当一致（细则第 21 条）
 * - V5 附图中除必需的词语外不应当含有其他注释（细则第 21 条第 3 款，官方全文已核验）：
 *   label 疑似注释性长文（超长单行/多行段落）→ WARN
 * - V7 附图缩小到三分之二时仍应能清晰分辨细节（指南一部一章 4.3，官方已核验）：画幅超限 → WARN
 * - V8 说明书有附图的应指定一幅摘要附图（指南一部一章 4.5.2）：多图未指定/
 *   指定多幅 → WARN
 * - V9 实用新型附图是说明书组成部分，应当有附图（指南一部二章 7.3 + 细则 20.5）
 *
 * V6（黑白线条）为渲染器构造期不变式，由 render-svg 单测保证，不在此重复。
 */

import { layoutFigure } from "./layout.js";
import type { DocumentKind, FigureSpec, Jurisdiction } from "./types.js";

/** V5 阈值：单行 label 最大字符数 / 最大行数（超出视为疑似注释性文字）。 */
export const COMMENT_LABEL_LINE_MAX = 40;
export const COMMENT_LABEL_LINES_MAX = 3;
/** V7 阈值：画幅最大边长（px）。超出则缩小到 2/3 后小于可辨字号。 */
export const FIGURE_CANVAS_MAX_PX = 1600;

export type FigureCheckSeverity = "fail" | "warn" | "info";

export type FigureCheckRuleId = "V1" | "V2" | "V3" | "V4" | "V5" | "V7" | "V8" | "V9";

export type FigureCheckOptions = {
  /** 生成期无说明书文本可核时跳过 V2/V3（V1/V4/V5/V7/V8/V9 照常）。 */
  skipTextRules?: boolean;
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
};

export type FigureCheckResult = {
  /** 无 fail 级 finding。 */
  ok: boolean;
  findings: FigureCheckFinding[];
  /** 全部附图中出现的附图标记（去重升序）。 */
  refsInFigures: number[];
  /** 说明书文字部分以括号形式出现的疑似附图标记（去重升序）。 */
  refsInText: number[];
};

/** 剥离 label 中的括号标记后缀，得到组件名称主干。 */
export function stripRefMark(label: string): string {
  return label
    .replace(/[（(]\s*\d{1,3}\s*[)）]/gu, "")
    .split("\n")[0]
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
        names.add(stripRefMark(node.label));
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

  // V7 缩小三分之二可辨（画幅代理检查）
  for (const figure of figures) {
    const { width, height } = layoutFigure(figure);
    if (Math.max(width, height) > FIGURE_CANVAS_MAX_PX) {
      findings.push({
        rule: "V7",
        severity: "warn",
        message:
          `图${figure.figure_no} 画幅 ${Math.round(width)}×${Math.round(height)}px 超过 ${FIGURE_CANVAS_MAX_PX}px` +
          `（V7，指南一部一章 4.3：缩小到三分之二时仍应能清晰分辨图中各个细节），建议拆分为多幅附图`,
        figure_nos: [figure.figure_no],
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

  return {
    ok: !findings.some(f => f.severity === "fail"),
    findings,
    refsInFigures,
    refsInText,
  };
}
