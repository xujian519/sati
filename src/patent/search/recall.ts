/**
 * 检索覆盖度判断（提示词 + schema + 解析 + 补检式拼接）。
 *
 * 与创造性图 `recall_check` 节点共用同一份提示词文本：抽出只为一处维护，
 * 不改变图的模型行为。提示词字符串由 `tests/patent/search/recall.spec.ts`
 * 的快照测试锁住。
 */

import { dataBlock } from "../prompt-hygiene.js";

/** 覆盖度判断的结构化输出契约。 */
export const RECALL_SCHEMA = {
  type: "object",
  properties: {
    adequate: { type: "boolean", description: "检索结果是否足以支撑创造性判断（至少覆盖核心技术特征）" },
    covered_features: { type: "array", items: { type: "string" }, description: "已被检索结果覆盖的技术特征" },
    missing_features: { type: "array", items: { type: "string" }, description: "未被覆盖的关键技术特征（补检依据）" },
  },
  required: ["adequate", "covered_features", "missing_features"],
} as const;

/** 与创造性图 `recall_check` 节点逐字相同的提示词。 */
export function buildRecallPrompt(params: { parse: string; priorArtText: string }): string {
  const { parse, priorArtText } = params;
  return [
    "你是专利检索质量审查员。检查现有技术检索结果的覆盖度：",
    "- adequate：检索结果是否足以支撑创造性判断（至少覆盖核心技术特征）",
    "- covered_features：已被检索结果覆盖的技术特征",
    "- missing_features：未被覆盖的关键技术特征（补检依据）",
    "【待评技术特征】",
    dataBlock(parse.slice(0, 3000)),
    "【检索结果摘要（含公开日）】",
    priorArtText.length > 0 ? dataBlock(priorArtText.slice(0, 4000)) : "（无检索结果）",
    "",
    "请严格输出 JSON：{ adequate, covered_features, missing_features }。",
  ].join("\n");
}

export type RecallDecision = {
  adequate: boolean;
  covered_features: string[];
  missing_features: string[];
};

/** 解析模型输出；不可用时返回 undefined（调用方据此记 `not_evaluated`，不得当成通过）。 */
export function parseRecallDecision(raw: string): RecallDecision | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // 模型输出不是 JSON 时返回 undefined；调用方据此记 not_evaluated，不当作通过。
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.adequate !== "boolean") return undefined;
  const toStrings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").filter(Boolean) : [];
  return {
    adequate: record.adequate,
    covered_features: toStrings(record.covered_features),
    missing_features: toStrings(record.missing_features),
  };
}

/**
 * 补检式：旧查询 OR 缺特征1 OR 缺特征2。
 *
 * 与 `refineQueryNode` 一致；无缺失特征时原样返回旧查询。
 */
export function buildRefinedQuery(previousQuery: string, missingFeatures: readonly string[]): string {
  const previous = previousQuery.trim();
  const missing = missingFeatures.map(item => item.trim()).filter(Boolean);
  const suffix = missing.length > 0 ? ` OR ${missing.join(" OR ")}` : "";
  return `${previous}${suffix}` || "补充检索";
}
