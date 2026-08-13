/**
 * TRIZ 方法论组件（第 8 个 MethodologyComponent）：
 * 技术矛盾定义 → 矛盾矩阵确定性查表 → 40 原理启发构思。
 *
 * 专利场景落点：撰写前创新辅助 / 规避设计（design around）/ 问题重构。
 * 矛盾矩阵数据：Altshuller 经典 39×39 矩阵（公开经典数据）。
 *
 * 确定性查表在产品路径的接入：execute 时从 goal 文本中自动识别 39 个工程
 * 参数名，对识别出的参数两两查表，把结果注入 prompt（LLM 无需凭记忆查矩阵）；
 * 未识别到参数对时回退为 prompt 引导 LLM 自行查表。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { MethodologyComponent } from "../../protocol/types.js";
import { keywordScore } from "./keywordMatch.js";

// 触发词仅保留 TRIZ 特有表述（矛盾/冲突/权衡/折中/规避设计）；"改进/优化/
// 重构"与 pdca、first-principles 重叠且非 TRIZ 语义核心，剔除避免稀释命中。
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
] as const;

/** 39×39 矛盾矩阵（[恶化参数][改善参数] = 推荐原理编号数组）。 */
let matrixCache: number[][][] | null = null;

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

/** 40 发明原理（编号 + 名称 + 说明）。 */
type TrizPrinciple = { no: number; name: string; description: string };
let principlesCache: TrizPrinciple[] | null = null;

function loadPrinciples(): TrizPrinciple[] {
  if (principlesCache) return principlesCache;
  const path = join(dirname(fileURLToPath(import.meta.url)), "data", "triz-principles.json");
  principlesCache = JSON.parse(readFileSync(path, "utf8")) as TrizPrinciple[];
  return principlesCache;
}

/**
 * 39 个工程参数（经典矩阵行/列名）。match 为 goal 中识别用核心词
 * （运动/静止成对参数共享核心词，两向都命中由 LLM 取舍），label 为展示名。
 */
const ENGINEERING_PARAMS: ReadonlyArray<{ no: number; match: string; label: string }> = [
  { no: 1, match: "重量", label: "运动物体重量" },
  { no: 2, match: "重量", label: "静止物体重量" },
  { no: 3, match: "长度", label: "运动物体长度" },
  { no: 4, match: "长度", label: "静止物体长度" },
  { no: 5, match: "面积", label: "运动物体面积" },
  { no: 6, match: "面积", label: "静止物体面积" },
  { no: 7, match: "体积", label: "运动物体体积" },
  { no: 8, match: "体积", label: "静止物体体积" },
  { no: 9, match: "速度", label: "速度" },
  { no: 10, match: "力", label: "力" },
  { no: 11, match: "应力", label: "应力" },
  { no: 12, match: "形状", label: "形状" },
  { no: 13, match: "稳定性", label: "结构稳定性" },
  { no: 14, match: "强度", label: "强度" },
  { no: 15, match: "作用时间", label: "运动物体作用时间" },
  { no: 16, match: "作用时间", label: "静止物体作用时间" },
  { no: 17, match: "温度", label: "温度" },
  { no: 18, match: "光照", label: "光照度" },
  { no: 19, match: "能量", label: "运动物体能量" },
  { no: 20, match: "能量", label: "静止物体能量" },
  { no: 21, match: "功率", label: "功率" },
  { no: 22, match: "能量损失", label: "能量损失" },
  { no: 23, match: "物质损失", label: "物质损失" },
  { no: 24, match: "信息损失", label: "信息损失" },
  { no: 25, match: "时间损失", label: "时间损失" },
  { no: 26, match: "数量", label: "物质数量" },
  { no: 27, match: "可靠性", label: "可靠性" },
  { no: 28, match: "测量精度", label: "测量精度" },
  { no: 29, match: "制造精度", label: "制造精度" },
  { no: 30, match: "有害因素", label: "作用于物体的有害因素" },
  { no: 31, match: "有害因素", label: "物体产生的有害因素" },
  { no: 32, match: "可制造性", label: "可制造性" },
  { no: 33, match: "可操作性", label: "可操作性" },
  { no: 34, match: "可维修性", label: "可维修性" },
  { no: 35, match: "适应性", label: "适应性" },
  { no: 36, match: "复杂性", label: "装置复杂性" },
  { no: 37, match: "复杂性", label: "检测复杂性" },
  { no: 38, match: "自动化", label: "自动化程度" },
  { no: 39, match: "生产率", label: "生产率" },
];

/** 从 goal 文本中识别命中的工程参数编号（子串匹配，去重）。 */
export function detectParamNumbers(goal: string): number[] {
  const g = goal.toLowerCase();
  const found = new Set<number>();
  for (const p of ENGINEERING_PARAMS) {
    if (g.includes(p.match)) found.add(p.no);
  }
  return [...found];
}

function paramLabel(no: number): string {
  return ENGINEERING_PARAMS.find(p => p.no === no)?.label ?? String(no);
}

/** 原理编号 → "N 名称" 列表（数据来自 triz-principles.json）。 */
function principleNames(ids: number[]): string {
  const byNo = new Map(loadPrinciples().map(p => [p.no, p]));
  return ids.map(id => `${id} ${byNo.get(id)?.name ?? ""}`.trim()).join(", ");
}

/** 对识别到的参数两两查表，生成确定性结果行。 */
function buildLookupLines(paramNos: number[]): string[] {
  const lines: string[] = [];
  if (paramNos.length < 2) return lines;
  for (const improving of paramNos) {
    for (const worsening of paramNos) {
      if (improving === worsening) continue;
      const ids = lookupMatrixCell(improving, worsening);
      if (ids.length === 0) continue;
      lines.push(
        `- 改善 ${paramLabel(improving)}(${improving}) → 恶化 ${paramLabel(worsening)}(${worsening})：原理 [${principleNames(ids)}]`,
      );
    }
  }
  return lines;
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
    const detected = detectParamNumbers(context.goal);
    const lookupLines = buildLookupLines(detected);
    const lookupSection =
      lookupLines.length > 0
        ? `\n【确定性查表结果】从问题中自动识别到工程参数 ${detected.map(n => `${paramLabel(n)}(${n})`).join("、")}，以下为经典矛盾矩阵（39×39）查得结果：\n${lookupLines.join("\n")}\n（若与你的技术矛盾方向不符，请忽略并按方法 2 自行查表）\n`
        : "";
    const prompt = `使用 **TRIZ（发明问题解决理论）** 分析以下问题：

问题：${context.goal}

方法：
1. **定义技术矛盾**：指出当前方案中「改善的参数」与「因此恶化的参数」，从 39 个工程参数中命名这对矛盾（如：改善强度→恶化重量）
2. **查矛盾矩阵**：以恶化参数为行、改善参数为列，从经典矛盾矩阵查得推荐发明原理编号（1-40）${lookupSection}
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
