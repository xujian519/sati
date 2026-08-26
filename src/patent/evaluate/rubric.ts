/**
 * Rubric —— 评测「可观察行为」分项评分标准（私有，对被测 Agent 完全隔离）。
 *
 * 对齐 PenguinHarness rubric 的硬约束：评分项必须**可观察**（行为是否发生），
 * 不允许"分析是否充分/全面"这类不可观察措辞，且每 case 固定 0-100 分，避免
 * 格式/枚举/完整性分析形成高保底分。这是与 `expected` 文本相似度（keyword_recall
 * / jaccard）的**根本区别**：后者对措辞敏感、对行为达标不敏感。
 */

import { parse as parseYaml } from "yaml";

/** 评分项行为类型。当前只允许 observable（行为是否发生）。 */
export type RubricBehavior = "observable";

/** 单个评分项。 */
export type RubricItem = {
  /** 稳定 id（scoreboard / 诊断引用）。 */
  id: string;
  /** 该项权重（0..1，全项之和必须为 1）。 */
  weight: number;
  /** 可观察行为断言（如"是否使用三步法给出区别技术特征"）。 */
  criterion: string;
  /** 行为类型；强制 observable。 */
  behavior: RubricBehavior;
};

/** 解析完成的 rubric。 */
export type Rubric = {
  /** 单 case 满分（默认 100）。 */
  maxScore: number;
  items: RubricItem[];
};

/** `parseRubric` 的容错结果（discriminated）。 */
export type RubricParseResult = { rubric: Rubric; error: null } | { rubric: null; error: string };

/** weight 之和相对 1 的容差（浮点误差）。 */
const WEIGHT_TOLERANCE = 1e-6;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 解析并校验 rubric YAML。容错归一（对齐`readGoalStatus`思路）：文件缺失/非法
 * YAML/结构非法一律返回 `{ rubric: null, error }`——调用方据此判"不作数"，而不是
 * 假装解析成功。
 *
 * @param text rubric.yaml 的原始文本。
 * @returns 合法 → `{ rubric, error: null }`；非法 → `{ rubric: null, error }`。
 */
export function parseRubric(text: string): RubricParseResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    return { rubric: null, error: `Rubric YAML 解析失败: ${errorMessage(err)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { rubric: null, error: "Rubric 必须是 YAML 映射（含 items 列表）。" };
  }
  const raw = parsed as Record<string, unknown>;
  const itemList = raw.items;
  if (!Array.isArray(itemList)) {
    return { rubric: null, error: "Rubric items 必须是列表。" };
  }

  const items: RubricItem[] = [];
  for (let i = 0; i < itemList.length; i++) {
    const item = itemList[i];
    if (typeof item !== "object" || item === null) {
      return { rubric: null, error: `Rubric item [${i}] 必须是映射。` };
    }
    const it = item as Record<string, unknown>;
    const id = it.id;
    const weight = it.weight;
    const criterion = it.criterion;
    const behavior = it.behavior;
    if (typeof id !== "string" || id.trim().length === 0) {
      return { rubric: null, error: `Rubric item [${i}] 缺少字符串 id。` };
    }
    if (typeof weight !== "number" || !Number.isFinite(weight)) {
      return { rubric: null, error: `Rubric item [${i}] weight 必须是数字。` };
    }
    if (typeof criterion !== "string" || criterion.trim().length === 0) {
      return { rubric: null, error: `Rubric item [${i}] criterion 必须是非空字符串。` };
    }
    if (behavior !== "observable") {
      return {
        rubric: null,
        error: `Rubric item [${i}] behavior 必须是 "observable"；收到 ${JSON.stringify(behavior)}。`,
      };
    }
    items.push({ id, weight, criterion, behavior });
  }

  if (items.length === 0) {
    return { rubric: null, error: "Rubric 至少需要一个评分项。" };
  }
  const weightSum = items.reduce((sum, it) => sum + it.weight, 0);
  if (Math.abs(weightSum - 1) > WEIGHT_TOLERANCE) {
    return { rubric: null, error: `Rubric 各项 weight 之和必须为 1；当前为 ${weightSum}。` };
  }

  const maxScoreRaw = raw.maxScore;
  const maxScore = typeof maxScoreRaw === "number" && Number.isFinite(maxScoreRaw) ? maxScoreRaw : 100;

  return { rubric: { maxScore, items }, error: null };
}

/**
 * 纯函数聚合：按各评分项布尔判定折算 case 分数（0..maxScore）。
 * 每一项通过记为满分、未通过记 0 分，按 weight 加权。
 *
 * @param verdicts itemId → 是否通过（可观察行为是否发生）。
 * @param rubric 已解析的 rubric。
 */
export function aggregateRubricScore(verdicts: Record<string, boolean>, rubric: Rubric): number {
  let total = 0;
  for (const item of rubric.items) {
    const passed = verdicts[item.id] === true;
    total += item.weight * (passed ? 1 : 0);
  }
  return round2(total * rubric.maxScore);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
