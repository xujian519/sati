/**
 * First Principles methodology — break a problem down to fundamental truths
 * and rebuild from there. Adapted from XiaoNuo Agent's
 * `methodology/classical/first-principles.ts`.
 */

import type { MethodologyComponent } from "../../protocol/types.js";
import { keywordScore } from "./keywordMatch.js";

const TRIGGERS = ["第一性原理", "本质", "基本事实", "假设", "重构", "first principles", "颠覆"];

export const firstPrinciples: MethodologyComponent = {
  name: "first-principles",
  description: "回到基本事实与原理，重建对问题的理解与方案",
  category: "classical",
  applicableDomains: ["patent", "legal", "coding", "general"],

  identify(context) {
    return keywordScore(context, TRIGGERS);
  },

  execute(context) {
    return {
      prompt: `使用 **第一性原理（First Principles）** 分析以下问题：

问题：${context.goal}

方法：
1. **剥离假设**：列出当前理解中所有被默认接受的假设（技术路线、行业惯例、约束条件）
2. **还原基本事实**：每个假设追问「它为什么成立？背后更基本的事实是什么？」直至不可再分
3. **重建方案**：仅基于基本事实，重新推导解决方案，忽略被推翻的假设
4. **对比验证**：新方案与常规方案对比，说明差异与取舍

输出格式：
- 被剥离的假设：
  - 假设 1：... → 是否成立：<成立/存疑/不成立>
  - 假设 2：...
- 基本事实：<不可再分的事实清单>
- 重建方案：<基于基本事实的方案>
- 与常规方案对比：<差异、风险、收益>`,
    };
  },
};
