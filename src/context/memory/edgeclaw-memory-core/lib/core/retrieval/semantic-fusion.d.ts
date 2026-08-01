/**
 * 语义召回与 manifest 的融合（RRF）——从 reasoning-loop 抽离，便于单测。
 *
 * 规则：union = manifest ∪ 语义命中；每个 id 计 RRF 分
 * （manifest rank 与语义 rank 各自 1/(k+rank) 求和）；语义独有命中
 * （超出 manifest 上限 200 的旧文件）也进入候选，由 LLM 决定是否采用。
 */
import type { RecallHeaderEntry } from "../types.js";
export declare const SEMANTIC_SEARCH_LIMIT = 10;
export declare function fuseManifestWithSemantic(manifest: RecallHeaderEntry[], semanticHits: Array<{
    relativePath: string;
    score: number;
}>): RecallHeaderEntry[];
