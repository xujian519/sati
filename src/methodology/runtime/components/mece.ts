/**
 * MECE methodology — Mutually Exclusive, Collectively Exhaustive decomposition.
 * Adapted from XiaoNuo Agent's `methodology/analytical/mece.ts`.
 */

import type { MethodologyComponent } from "../../protocol/types.js";
import { keywordScore } from "./keywordMatch.js";

const TRIGGERS = ["分类", "分解", "拆解", "结构", "分类分析", "mece", "维度", "分层"];

export const mece: MethodologyComponent = {
  name: "mece",
  description: "用「相互独立、完全穷尽」的原则对问题做结构化分解",
  category: "analytical",
  applicableDomains: ["patent", "legal", "coding", "general"],

  identify(context) {
    return keywordScore(context, TRIGGERS);
  },

  execute(context) {
    return {
      prompt: `使用 **MECE 原则** 对以下任务做结构化分解：

任务：${context.goal}

原则：
1. **ME（Mutually Exclusive）**：各分类之间相互独立，不重叠
2. **CE（Collectively Exhaustive）**：分类合并后完整覆盖全部可能

方法：
1. 确定分解的目标维度（如：按功能/按时间/按对象/按风险）
2. 列出所有可能的类别，检查是否有重叠（违反 ME）
3. 检查是否有遗漏（违反 CE），必要时补一个「其他」兜底
4. 对每个类别给出判断标准或处理方案

输出格式：
- 分解维度：<维度>
- 类别 1：<名称> — <覆盖范围>
- 类别 2：<名称> — <覆盖范围>
- ...
- ME 检查：<无重叠 / 存在重叠 X，已调整>
- CE 检查：<无遗漏 / 已补充「其他」>`,
    };
  },
};
