/**
 * SWOT methodology — Strengths / Weaknesses / Opportunities / Threats analysis.
 * Adapted from XiaoNuo Agent's `methodology/analytical/swot.ts`.
 */

import type { MethodologyComponent } from "../../protocol/types.js";
import { keywordScore } from "./keywordMatch.js";

const TRIGGERS = ["swot", "优势", "劣势", "机会", "威胁", "态势", "竞争力", "布局策略"];

export const swot: MethodologyComponent = {
  name: "swot",
  description: "从优势、劣势、机会、威胁四个维度做态势分析",
  category: "analytical",
  applicableDomains: ["patent", "legal", "general"],

  identify(context) {
    return keywordScore(context, TRIGGERS);
  },

  execute(context) {
    return {
      prompt: `使用 **SWOT 分析** 评估以下对象/方案：

对象：${context.goal}

四个维度：
1. **S（Strengths 优势）**：内部具备的有利条件
2. **W（Weaknesses 劣势）**：内部存在的不足
3. **O（Opportunities 机会）**：外部环境中的有利因素
4. **T（Threats 威胁）**：外部环境中的不利因素

方法：
1. 分别列出 S/W/O/T 四类条目（各 2-5 条）
2. 交叉分析：SO（利用优势抓住机会）、WO（克服劣势抓住机会）、ST（利用优势抵御威胁）、WT（规避劣势与威胁）
3. 给出策略建议

输出格式：
- 优势（S）：...
- 劣势（W）：...
- 机会（O）：...
- 威胁（T）：...
- SO 策略：...
- WO 策略：...
- ST 策略：...
- WT 策略：...
- 结论建议：<一句话>`,
    };
  },
};
