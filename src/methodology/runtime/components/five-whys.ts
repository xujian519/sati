/**
 * Five Whys methodology — root-cause analysis by iterated "why" questions.
 * Adapted from XiaoNuo Agent's `methodology/analytical/five-whys.ts`.
 */

import type { MethodologyComponent } from "../../protocol/types.js";
import { keywordScore } from "./keywordMatch.js";

const TRIGGERS = ["为什么", "原因", "根因", "why", "root cause", "失败", "错误", "bug", "问题"];

export const fiveWhys: MethodologyComponent = {
  name: "five-whys",
  description: "通过连续追问「为什么」追溯问题的根本原因",
  category: "analytical",
  applicableDomains: ["patent", "legal", "coding", "general"],

  identify(context) {
    return keywordScore(context, TRIGGERS);
  },

  execute(context) {
    return {
      prompt: `使用 **5 Whys（五问法）** 分析以下问题：

问题：${context.goal}

方法：
1. 从问题表象出发，连续追问「为什么」（最多 5 层）
2. 每一层深入到更直接的原因，避免跳跃
3. 识别出根本原因（Root Cause）——即「修复后问题不再复发」的那一层
4. 对根本原因提出可执行的纠正措施

输出格式：
- 问题表象：<一句话描述>
- Why 1 → <直接原因>
- Why 2 → <更深一层>
- Why 3 → <更深一层>
- Why 4 → <更深一层>
- Why 5 → <最深一层>
- 根本原因：<结论>
- 纠正措施：<建议>`,
    };
  },
};
