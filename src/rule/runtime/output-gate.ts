/**
 * 宪法规则引擎 — 输出门禁通道。
 *
 * 对 Agent 输出文本运行规则评估，并按 action 转换语义：
 *   - review / block ：needsApproval = true（输出已生成无法拦截，block 降级为强制审批）
 *   - warn            ：在文本末尾追加合规提示（含规则依据）
 *   - log             ：仅记录，不改变文本
 *
 * 与专利域 output-gate.ts 的挂起审批（DeferredPersistQueue）解耦：
 * 本门禁只产出判定结果，挂起/审批由调用方（Agent 输出流）处理。
 */

import type { RuleEvaluation, RuleSet, RuleViolation } from "../protocol/types.js";
import { evaluateText, groupByAction } from "./RuleEngine.js";

export type RuleOutputGateOptions = {
  /** warn 违规提示区块标题（默认 "合规提示"）。 */
  warnTitle?: string;
  /** block 违规追加说明文案。 */
  blockMessage?: string;
};

export type RuleOutputGateResult = {
  /** 处理后的文本（已追加 warn/block 提示）。 */
  text: string;
  /** 全部违规（含 log 级）。 */
  violations: RuleViolation[];
  /** 是否存在 review/block 级违规（需人工审批）。 */
  needsApproval: boolean;
  /** warn 级命中的规则 id。 */
  warnHits: string[];
  /** review 级命中的规则 id。 */
  reviewHits: string[];
  /** block 级命中的规则 id。 */
  blockHits: string[];
  /** 完整评估（含 log 分组）。 */
  evaluation: RuleEvaluation;
};

/** 规则驱动的输出门禁。一个实例持有一份 RuleSet（启动时加载一次）。 */
export class RuleOutputGate {
  private readonly warnTitle: string;
  private readonly blockMessage: string;

  constructor(
    private readonly ruleSet: RuleSet,
    options?: RuleOutputGateOptions,
  ) {
    this.warnTitle = options?.warnTitle ?? "合规提示";
    this.blockMessage = options?.blockMessage ?? "输出命中强制拦截规则，须经人工审批后发布。";
  }

  /** 评估并处理输出文本（纯函数）。 */
  process(text: string): RuleOutputGateResult {
    const evaluation = evaluateText(text, this.ruleSet);
    const grouped = groupByAction(evaluation);
    const warnHits = grouped.warn.map(v => v.ruleId);
    const reviewHits = grouped.review.map(v => v.ruleId);
    const blockHits = grouped.block.map(v => v.ruleId);
    const needsApproval = reviewHits.length > 0 || blockHits.length > 0;

    let output = text;
    const append = (block: string) => {
      output = `${output}\n\n---\n${block}`;
    };

    if (warnHits.length > 0) {
      const lines = grouped.warn.map(formatViolation);
      append(`⚠️ ${escapeXml(this.warnTitle)}：\n${lines.join("\n")}`);
    }
    if (blockHits.length > 0) {
      const lines = grouped.block.map(formatViolation);
      append(`🚫 ${escapeXml(this.blockMessage)}\n${lines.join("\n")}`);
    }

    return {
      text: output,
      violations: evaluation.violations,
      needsApproval,
      warnHits,
      reviewHits,
      blockHits,
      evaluation,
    };
  }
}

function formatViolation(v: RuleViolation): string {
  const basis = v.legalBasis ? `（依据：${escapeXml(v.legalBasis)}）` : "";
  const evidence = v.evidence.length > 0 ? ` — 命中「${v.evidence.map(escapeXml).join("」「")}」` : "";
  return `- [${escapeXml(v.ruleId)}] ${escapeXml(v.ruleName)}：${escapeXml(v.message)}${evidence}${basis}`;
}

/** 转义规则/证据文本中的 XML 特殊字符，防提示注入/格式混淆。 */
function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
