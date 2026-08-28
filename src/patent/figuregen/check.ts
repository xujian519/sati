/**
 * src/patent/figuregen — 附图确定性校验器（P0：V1–V4）。
 *
 * 规则依据（溯源锚见 skills/patent-illustrator/references/cn-drawing-rules.md）：
 * - V1 附图按"图1，图2……"顺序编号排列（细则 2023 第 21 条第 1 款）
 * - V2 说明书文字部分中未提及的附图标记不得在附图中出现（细则第 21 条）
 * - V3 附图中未出现的附图标记不得在说明书文字部分中提及（细则第 21 条）。
 *   文本侧数字未必是附图标记（如"步骤S20""三步法"），故仅提取括号形式标记
 *   且降级为 WARN，证据供人工确认，避免硬 FAIL 打断撰写流程。
 * - V4 表示同一组成部分的附图标记应当一致（细则第 21 条）
 *
 * V6（黑白线条）为渲染器构造期不变式，由 render-svg 单测保证，不在此重复。
 */

import type { FigureSpec } from "./types.js";

export type FigureCheckSeverity = "fail" | "warn" | "info";

export type FigureCheckRuleId = "V1" | "V2" | "V3" | "V4";

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
  options: { skipTextRules?: boolean } = {},
): FigureCheckResult {
  const findings: FigureCheckFinding[] = [];

  // V1 图号连续编号
  const figureNos = figures.map(f => f.figure_no);
  const sortedNos = [...figureNos].sort((a, b) => a - b);
  const expected = Array.from({ length: figures.length }, (_, i) => i + 1);
  const duplicated = sortedNos.filter((no, i) => i > 0 && no === sortedNos[i - 1]);
  if (figures.length === 0) {
    findings.push({
      rule: "V1",
      severity: "fail",
      message: "未提供任何附图（V1，细则第 21 条：附图应按'图1，图2……'顺序编号）",
    });
  } else if (duplicated.length > 0 || sortedNos.some((no, i) => no !== expected[i])) {
    findings.push({
      rule: "V1",
      severity: "fail",
      message: `附图编号应为 1..${figures.length} 连续排列，实际为 [${figureNos.join(", ")}]（V1，细则第 21 条）`,
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
      message: "附图中出现的附图标记未在说明书文字部分中提及（V2，细则第 21 条）",
      evidence: missingEvidence,
    });
  }

  // V3 文→图（保守 WARN）
  const orphanRefs = options.skipTextRules ? [] : refsInText.filter(ref => !refsInFigures.includes(ref));
  if (orphanRefs.length > 0) {
    findings.push({
      rule: "V3",
      severity: "warn",
      message: "说明书文字部分出现的括号标记未出现于任何附图（V3，细则第 21 条；数字未必是附图标记，请人工确认）",
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
          message: `同一附图标记应始终表示同一组成部分（V4，细则第 21 条）`,
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
        message: "同一附图标记跨图对应不同名称（V4，细则第 21 条：表示同一组成部分的附图标记应当一致）",
        evidence: [`标记 ${ref} 对应多个名称：${[...names].join(" / ")}`],
      });
    }
  }
  for (const [id, refs] of idToRefs) {
    if (refs.size > 1) {
      findings.push({
        rule: "V4",
        severity: "fail",
        message: "同一节点跨图使用了不同附图标记（V4，细则第 21 条）",
        evidence: [`节点 id「${id}」跨图标记不一致：${[...refs].join(" / ")}`],
      });
    }
  }

  return {
    ok: !findings.some(f => f.severity === "fail"),
    findings,
    refsInFigures,
    refsInText,
  };
}
