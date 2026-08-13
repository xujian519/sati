/**
 * TRIZ 方法论组件（第 8 个 MethodologyComponent）：
 * 技术矛盾定义 → 矛盾矩阵确定性查表 → 40 原理启发构思。
 *
 * 专利场景落点：撰写前创新辅助 / 规避设计（design around）/ 问题重构。
 * 矛盾矩阵数据：Altshuller 经典 39×39 矩阵（公开经典数据）。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { MethodologyComponent } from "../../protocol/types.js";
import { keywordScore } from "./keywordMatch.js";

export const TRIGGERS = [
  "矛盾",
  "冲突",
  "权衡",
  "折中",
  "trade-off",
  "tradeoff",
  "规避",
  "设计规避",
  "design around",
  "改进",
  "优化",
  "重构",
] as const;

/** 39×39 矛盾矩阵（[恶化参数][改善参数] = 推荐原理编号数组）。 */
let matrixCache: number[][][] | null = null;

// 注意：dist 构建（pnpm build）的 cpSync 白名单不含 data/ 目录，T11 需把矩阵数据纳入构建拷贝（否则 dist 运行时 ENOENT）
export function loadMatrix(): number[][][] {
  if (matrixCache) return matrixCache;
  const path = join(dirname(fileURLToPath(import.meta.url)), "data", "triz-matrix.json");
  matrixCache = JSON.parse(readFileSync(path, "utf8")) as number[][][];
  return matrixCache;
}

/** 确定性查表：改善参数 paramImproving × 恶化参数 paramWorsening → 推荐原理。 */
export function lookupMatrixCell(paramImproving: number, paramWorsening: number): number[] {
  const m = loadMatrix();
  const row = m[paramWorsening - 1] ?? [];
  return row[paramImproving - 1] ?? [];
}

export const triz: MethodologyComponent = {
  name: "triz",
  description: "TRIZ 矛盾矩阵 + 40 发明原理：定义技术矛盾 → 查矩阵 → 原理启发构思",
  category: "creative",
  applicableDomains: ["patent", "general"],

  identify(context) {
    return keywordScore(context, TRIGGERS);
  },

  execute(context) {
    const prompt = `使用 **TRIZ（发明问题解决理论）** 分析以下问题：

问题：${context.goal}

方法：
1. **定义技术矛盾**：指出当前方案中「改善的参数」与「因此恶化的参数」，从 39 个工程参数中命名这对矛盾（如：改善强度→恶化重量）
2. **查矛盾矩阵**：以恶化参数为行、改善参数为列，从经典矛盾矩阵查得推荐发明原理编号（1-40）
3. **原理启发构思**：按命中的发明原理（结合 40 发明原理说明）生成 2-3 个候选解决方案，逐个说明其如何消解矛盾
4. **专利场景落点**（如适用）：
   - 撰写前创新辅助：候选方案与已知现有方案的区别特征
   - 规避设计：识别目标专利的保护点，用命中原理寻找替代技术手段
   - 问题重构：把「改进 X」重构为矛盾对形式，便于检索与布局

输出格式：
- 技术矛盾：<改善参数> vs <恶化参数>（矛盾矩阵格：原理 [编号列表]）
- 候选方案：
  - 方案 1：<描述>（应用原理 N：<原理名>）
  - 方案 2：…
- 专利落点：<区别特征 / 替代手段 / 重构后的矛盾表述>`;
    return { prompt };
  },
};
