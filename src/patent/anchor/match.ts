/**
 * 特征匹配：归一化后做连续子串查找，命中区间映射回原文。
 *
 * 未命中返回 `hit: null` 而不是抛错——调用方据此产出缺口，不需要 try/catch。
 */

import { normalizeText, normalizeWithOffsets } from "./normalize.js";
import type { FeatureMatch } from "./types.js";

/**
 * 在 `text` 中查找 `feature` 的第一次出现。
 *
 * `feature` 走同一套归一化（全角、空白、标点），因此「包括 A、B」与
 * 「包括 A,B」视为同一写法；但「包括」不会命中「包含」。
 */
export function matchFeature(text: string, feature: string): FeatureMatch {
  const normalizedFeature = normalizeText(feature);
  if (normalizedFeature.replace(/\s/gu, "").length === 0) {
    return { feature, hit: null };
  }
  if (text.replace(/\s/gu, "").length === 0) {
    return { feature, hit: null };
  }

  const normalized = normalizeWithOffsets(text);
  const index = normalized.text.indexOf(normalizedFeature);
  if (index < 0) return { feature, hit: null };

  const first = normalized.spans[index];
  const last = normalized.spans[index + normalizedFeature.length - 1];
  if (first === undefined || last === undefined) return { feature, hit: null };

  return { feature, hit: { start: first.start, end: last.end } };
}

/**
 * 批量匹配（保持输入顺序）。
 *
 * 每条特征独立查找，不做跨特征的区间合并——合并会把两条相邻特征
 * 误报成一条更长的命中。
 */
export function matchFeatures(text: string, features: readonly string[]): FeatureMatch[] {
  return features.map(feature => matchFeature(text, feature));
}
