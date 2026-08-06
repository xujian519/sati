/**
 * `memory.embedding` 配置压缩（写回前的清理）。
 *
 * EmbeddingConfigSection 每次变更基于当前值构造 draft 后整体写回；压缩函数负责：
 * - 空块（无字段）→ undefined，避免写入空对象；
 * - 字符串字段 trim 后为空则丢弃；
 * - 仅含 `enabled: false` 的块整体丢弃——没有自定义字段可丢，避免 YAML 残留墓碑。
 *
 * embedding 与 rerank 两个层级共用同一策略（keepOrDrop），防止压缩规则分叉。
 */

import type { SatiConfig } from "../modelPool/types";

export type MemoryEmbeddingConfig = NonNullable<SatiConfig["memory"]>["embedding"];
export type MemoryRerankConfig = NonNullable<MemoryEmbeddingConfig>["rerank"];

/** 压缩策略：无字段、或仅 enabled 且为 false 的空块 → 丢弃。 */
function keepOrDrop<T extends { enabled?: boolean }>(next: T): T | undefined {
  return Object.keys(next).some(key => key !== "enabled") || next.enabled === true ? next : undefined;
}

export function compactRerank(rerank: MemoryRerankConfig): MemoryRerankConfig | undefined {
  if (!rerank || Object.keys(rerank).length === 0) return undefined;
  const next: NonNullable<MemoryRerankConfig> = {};
  if (rerank.enabled !== undefined) next.enabled = rerank.enabled;
  if (rerank.provider?.trim()) next.provider = rerank.provider.trim();
  if (rerank.baseUrl?.trim()) next.baseUrl = rerank.baseUrl.trim();
  if (rerank.apiKey?.trim()) next.apiKey = rerank.apiKey.trim();
  if (rerank.model?.trim()) next.model = rerank.model.trim();
  if (rerank.timeoutMs !== undefined) next.timeoutMs = rerank.timeoutMs;
  if (rerank.topN !== undefined) next.topN = rerank.topN;
  return keepOrDrop(next);
}

export function compactEmbedding(embedding: MemoryEmbeddingConfig): MemoryEmbeddingConfig | undefined {
  if (!embedding || Object.keys(embedding).length === 0) return undefined;
  const next: NonNullable<MemoryEmbeddingConfig> = {};
  if (embedding.enabled !== undefined) next.enabled = embedding.enabled;
  if (embedding.provider?.trim()) next.provider = embedding.provider.trim();
  if (embedding.baseUrl?.trim()) next.baseUrl = embedding.baseUrl.trim();
  if (embedding.apiKey?.trim()) next.apiKey = embedding.apiKey.trim();
  if (embedding.model?.trim()) next.model = embedding.model.trim();
  if (embedding.dimensions !== undefined) next.dimensions = embedding.dimensions;
  if (embedding.timeoutMs !== undefined) next.timeoutMs = embedding.timeoutMs;
  if (embedding.batchSize !== undefined) next.batchSize = embedding.batchSize;
  if (embedding.indexMemory !== undefined) next.indexMemory = embedding.indexMemory;
  if (embedding.indexWiki !== undefined) next.indexWiki = embedding.indexWiki;
  const rerank = compactRerank(embedding.rerank);
  if (rerank) next.rerank = rerank;
  return keepOrDrop(next);
}
