/**
 * PDCA methodology — Plan-Do-Check-Act continuous improvement cycle.
 * Adapted from XiaoNuo Agent's `methodology/classical/pdca.ts`.
 */

import type { MethodologyComponent } from "../../protocol/types.js";
import { keywordScore } from "./keywordMatch.js";

const TRIGGERS = ["pdca", "改进", "优化", "流程", "质量", "循环", "持续改善", "迭代"];

export const pdca: MethodologyComponent = {
  name: "pdca",
  description: "用计划-执行-检查-处理的循环推进持续改进",
  category: "classical",
  applicableDomains: ["patent", "legal", "coding", "general"],

  identify(context) {
    return keywordScore(context, TRIGGERS);
  },

  execute(context) {
    return {
      prompt: `使用 **PDCA 循环** 推进以下改进任务：

任务：${context.goal}

四个阶段：
1. **P（Plan 计划）**：明确目标，找出差距，制定改进方案与衡量标准
2. **D（Do 执行）**：按计划实施，记录执行过程与偏差
3. **C（Check 检查）**：对照目标检查执行结果，分析成功与失败原因
4. **A（Act 处理）**：将有效措施标准化，未解决的问题进入下一轮 PDCA

输出格式：
- Plan：目标 = <可衡量目标>；差距 = <现状 vs 目标>；方案 = <步骤>；衡量 = <指标>
- Do：执行记录 = <做了什么，发生什么偏差>
- Check：结果 = <对照指标>；原因 = <成功/失败原因>
- Act：标准化 = <固化的措施>；遗留问题 = <进入下一轮>`,
    };
  },
};
