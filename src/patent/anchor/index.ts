/**
 * src/patent/anchor — 原文锚定（连续子串）。
 *
 * 纯函数、零依赖：可被 workflow 原子、脚本与测试直接复用。
 * 只覆盖连续子串；跨段匹配、章节归属与「未命中返回空数组」的批量口径
 * 属于撰写增强计划的 M1，本模块不声称已完成那部分。
 */

export { normalizeChar, normalizeText, normalizeWithOffsets } from "./normalize.js";
export { matchFeature, matchFeatures } from "./match.js";
export type { FeatureMatch, NormalizedText, SourceSpan } from "./types.js";
