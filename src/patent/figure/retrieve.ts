/**
 * src/patent/figure/retrieve — 附图检索（关键词 + 可选向量混合）。
 *
 * 检索对象：附图分析索引条目（FigureIndexEntry）。每张图拼成一份"图档"
 * 文本（附图编号/类型/整体描述/组件/连接/附图说明/文件名）：
 *
 * - 关键词路：CJK 单字 + 相邻二元组 + ASCII 词元，idf 加权余弦（0-1）；
 * - 向量路（可选）：复用可配置 embedding 端点（EmbeddingClient），对
 *   query + 全部图档编码后算余弦（0-1，负值截断）；
 * - 融合：0.6 关键词 + 0.4 向量加权和；关键词零命中时退化为纯向量，
 *   embedding 未配置/不可用/索引超限时退化为纯关键词。
 *
 * 语义检索是**可选增强**：关键词路径在任何环境下原样可用。
 */

import path from "node:path";
import type { EmbeddingClient } from "../../model/embedding/index.js";
import type { FigureIndexEntry } from "./index-store.js";
import { FIGURE_TYPE_NAMES } from "./types.js";

/** 向量检索的索引条目上限（超出仅关键词，避免超大 embedding 请求）。 */
export const MAX_VECTOR_DOCS = 100;

/** 混合检索融合权重：关键词 0.6 + 向量 0.4。 */
export const HYBRID_KEYWORD_WEIGHT = 0.6;
export const HYBRID_VECTOR_WEIGHT = 0.4;

export type FigureRetrieveMethod = "keyword" | "vector" | "hybrid";

export type FigureRetrieveHit = {
  entry: FigureIndexEntry;
  /**
   * 相关度得分 0-1：
   * - 混合 = 0.6·关键词 + 0.4·向量；
   * - 关键词零命中且向量可用 = 纯向量分；
   * - 仅关键词 = 关键词余弦；
   * - 空查询（列表模式）= usable ? 1 : 0.5。
   */
  score: number;
};

export type FigureRetrieveResult = {
  hits: FigureRetrieveHit[];
  method: FigureRetrieveMethod;
  /** 非致命说明（如向量检索被跳过），无则省略。 */
  note?: string;
};

export type FigureRetrieveOptions = {
  limit: number;
  embeddingClient?: EmbeddingClient;
};

const ASCII_TOKEN_RE = /[a-zA-Z0-9_]+/g;
const CJK_CHAR_RE = /[\u3400-\u9fff]/g;

/** 分词：ASCII 词元（小写）+ CJK 单字 + 相邻二元组（中文短查询召回友好）。 */
export function tokenizeFigureText(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.toLowerCase().matchAll(ASCII_TOKEN_RE)) tokens.push(match[0]);
  const chars = text.match(CJK_CHAR_RE) ?? [];
  for (let i = 0; i < chars.length; i++) {
    tokens.push(chars[i]!);
    if (i + 1 < chars.length) tokens.push(chars[i]! + chars[i + 1]!);
  }
  return tokens;
}

/** 将附图索引条目拼成可检索的图档文本（编号/类型/描述/组件/连接/附图说明/文件名）。 */
export function buildFigureDocumentText(entry: FigureIndexEntry): string {
  const analysis = entry.analysis;
  const parts = [
    `图${analysis.figureNumber}`,
    FIGURE_TYPE_NAMES[analysis.figureType],
    analysis.overallDescription,
    // 数组字段兜底：防御绕过索引校验的畸形条目（正常条目经 index-store 校验必为数组）
    ...(analysis.components ?? []).map(
      component => `${component.refNumber} ${component.name} ${component.description}`,
    ),
    ...(analysis.connections ?? []).map(
      connection => `${connection.source} ${connection.target} ${connection.description}`,
    ),
    analysis.figureDescription,
  ];
  parts.push(path.basename(entry.imagePath));
  return parts.join("\n");
}

/** 文档频率（含自身）反推 idf：稀有词权重高，常见词（单字）权重低。 */
function computeIdf(docTokens: string[][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    for (const token of new Set(tokens)) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  const total = docTokens.length;
  const idf = new Map<string, number>();
  for (const [token, count] of df) {
    idf.set(token, Math.log(1 + total / (1 + count)));
  }
  return idf;
}

/** 词项向量：idf × (1 + ln(1+tf))。 */
function termVector(tokens: string[], idf: Map<string, number>): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  const vector = new Map<string, number>();
  for (const [token, count] of tf) {
    const weight = idf.get(token);
    if (weight === undefined) continue;
    vector.set(token, weight * (1 + Math.log(1 + count)));
  }
  return vector;
}

function sparseCosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [token, value] of a) {
    dot += value * (b.get(token) ?? 0);
    normA += value * value;
  }
  for (const value of b.values()) normB += value * value;
  if (normA === 0 || normB === 0) return 0;
  return Math.max(0, dot / (Math.sqrt(normA) * Math.sqrt(normB)));
}

function denseCosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * (b[i] ?? 0);
    normA += a[i]! * a[i]!;
  }
  for (const value of b) normB += value * value;
  if (normA === 0 || normB === 0) return 0;
  return Math.max(0, dot / (Math.sqrt(normA) * Math.sqrt(normB)));
}

/** 空查询/全符号查询：按附图编号列出（usable 得分 1，否则 0.5）。 */
function listHits(entries: FigureIndexEntry[], limit: number): FigureRetrieveResult {
  const hits = entries
    .map(entry => ({ entry, score: entry.analysis.usable ? 1 : 0.5 }))
    .sort(
      (a, b) =>
        a.entry.analysis.figureNumber - b.entry.analysis.figureNumber ||
        a.entry.imagePath.localeCompare(b.entry.imagePath),
    )
    .slice(0, limit);
  return { hits, method: "keyword" };
}

/**
 * 检索附图索引条目。
 *
 * 空查询/全符号查询 → 列表模式（按附图编号排序）。正常查询走关键词，
 * 有 embedding 客户端且条目数在 MAX_VECTOR_DOCS 内时叠加向量并融合。
 */
export async function retrieveFigures(
  entries: FigureIndexEntry[],
  query: string,
  options: FigureRetrieveOptions,
): Promise<FigureRetrieveResult> {
  if (entries.length === 0) return { hits: [], method: "keyword" };
  const limit = Math.max(1, options.limit);
  const trimmed = (query ?? "").trim();
  const documents = entries.map(buildFigureDocumentText);

  const queryTokens = tokenizeFigureText(trimmed);
  if (queryTokens.length === 0) return listHits(entries, limit);

  const docTokens = documents.map(tokenizeFigureText);
  const idf = computeIdf(docTokens);
  const queryVector = termVector(queryTokens, idf);

  const keywordScores = docTokens.map(tokens => sparseCosine(queryVector, termVector(tokens, idf)));

  let method: FigureRetrieveMethod = "keyword";
  let note: string | undefined;
  let vectorScores: number[] | undefined;

  if (options.embeddingClient && entries.length <= MAX_VECTOR_DOCS) {
    try {
      const vectors = await options.embeddingClient.embed([trimmed, ...documents]);
      const queryEmbedding = vectors[0];
      if (queryEmbedding && queryEmbedding.length > 0) {
        vectorScores = entries.map((_, index) => {
          const documentEmbedding = vectors[index + 1];
          return documentEmbedding ? denseCosine(queryEmbedding, documentEmbedding) : 0;
        });
      }
    } catch {
      // embedding 端点不可用：降级关键词检索，不阻断工具。
    }
  } else if (options.embeddingClient && entries.length > MAX_VECTOR_DOCS) {
    note = `索引条目 ${entries.length} 超过向量检索上限 ${MAX_VECTOR_DOCS}，本次仅关键词检索`;
  }

  let scores: number[];
  if (vectorScores) {
    const hasKeywordHit = keywordScores.some(score => score > 0);
    if (!hasKeywordHit) {
      method = "vector";
      scores = vectorScores;
      note = "关键词无命中，已按向量相似度返回结果";
    } else {
      method = "hybrid";
      scores = keywordScores.map(
        (keyword, index) => HYBRID_KEYWORD_WEIGHT * keyword + HYBRID_VECTOR_WEIGHT * (vectorScores[index] ?? 0),
      );
    }
  } else {
    scores = keywordScores;
  }

  const ranked = entries
    .map((entry, index) => ({ entry, score: scores[index] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.entry.analysis.figureNumber - b.entry.analysis.figureNumber);
  // 关键词/混合路过滤零分条目（无词元重叠且无向量贡献 = 无命中）；
  // 纯向量路保留全部（相对相似度排序，由 limit 截断）。
  const hits = (method === "vector" ? ranked : ranked.filter(hit => hit.score > 0)).slice(0, limit);
  return note ? { hits, method, note } : { hits, method };
}
