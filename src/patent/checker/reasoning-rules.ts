/**
 * src/patent/checker — 推理模式规则聚合层（24 条）。
 *
 * 移植自 Mady domains/workflows/patent/reasoning_patterns.go：18 个标准化
 * 推理模式 × CheckRules。规则按组拆分为 4 个文件（对齐 core-rules.ts
 * 的按域拆函数范式）：creativity(7) + novelty(6) + claims(5) + other(6)。
 */

import type { CheckRule } from "./types.js";
import { claimsReasoningRules } from "./reasoning-claims.js";
import { creativityReasoningRules } from "./reasoning-creativity.js";
import { noveltyReasoningRules } from "./reasoning-novelty.js";
import { otherReasoningRules } from "./reasoning-other.js";

/**
 * 推理模式规则（24 条）。推理模式编码复审/无效实务中的规范推理模板，
 * 规则用 PathElements 校验推理路径步骤完整性（每步至少命中其一）。
 */
export function reasoningPatternRules(): CheckRule[] {
  return [
    ...creativityReasoningRules(),
    ...noveltyReasoningRules(),
    ...claimsReasoningRules(),
    ...otherReasoningRules(),
  ];
}
