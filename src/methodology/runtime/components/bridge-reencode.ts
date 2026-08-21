/**
 * Bridge-before-conclusion + re-encode methodology.
 *
 * Two cheap prompt-level corrections that help on unseen chains: re-encode the
 * requirement in one line before working (to buy back some of the recurrence
 * the architecture lacks), and let the required intermediate light up before
 * the conclusion consumes it. Pure prompt template, no LLM call.
 */

import type { MethodologyComponent } from "../../protocol/types.js";
import { keywordScore } from "./keywordMatch.js";

const TRIGGERS = [
  "推理",
  "推导",
  "分析",
  "为什么",
  "原因",
  "论证",
  "推导步骤",
  "reason",
  "analyze",
  "derive",
  "why",
  "steps",
];

export const bridgeReencode: MethodologyComponent = {
  name: "bridge-reencode",
  description: "先重述需求、让中间概念先于结论点亮，避免结论先行的合理化",
  category: "analytical",
  applicableDomains: ["patent", "legal", "coding", "general"],

  identify(context) {
    return keywordScore(context, TRIGGERS);
  },

  execute(context) {
    return {
      prompt: `采用 **结论前桥接 + 重编码** 方式分析以下问题：

问题：${context.goal}

要求：
1. **重编码**：先用一句话、用自己的话重述本任务的实际需求（不是给用户看的总结，是给自己重新编码）。完成后对照原文，确认没有遗漏约束。
2. **结论前桥接**：如果结论需要某个中间概念，先让这个中间概念形成（如"该问题真正要判断的是 X"），再据此得出结论。确保中间步骤先于它被消费的步骤出现。
3. 若结论先到，视为可疑：回退并按顺序重走推导链，标注每步状态（✓ 已验证 / ? 未验证 / ✗ 已否定）。`,
    };
  },
};
