/**
 * embedding 查询端与 knowledge.db 库向量一致性自检。
 *
 * 背景：knowledge.db embeddings 由 XiaoNuo 管道以 BGE-M3 ONNX int8 生成；
 * Sati 查询端默认用 Ollama bge-m3（同源，实测余弦 ≈0.985）。若用户配置了
 * 其他 embedding 模型（向量空间不同），余弦将失去意义——语义召回应降级。
 *
 * 方法：取 knowledge.db 若干锚点（chunk 原文 + 已有向量），用当前
 * EmbeddingClient 对同一原文生成查询向量，逐对算余弦，均值低于阈值则
 * 判定不一致（语义召回自动降级跳过，复用既有熔断路径）。
 */

import { DatabaseSync } from "node:sqlite";
import { cosineSimilarity } from "../../context/vector/cosine.js";
import type { EmbeddingClient } from "../../model/embedding/types.js";

export type EmbeddingConsistencySample = {
  /** 锚点原文预览（≤60 字符，诊断用）。 */
  text: string;
  /** 查询向量与库向量的余弦。 */
  cosine: number;
};

export type EmbeddingConsistencyResult = {
  ok: boolean;
  meanCosine: number;
  sampleCount: number;
  samples: EmbeddingConsistencySample[];
};

export type EmbeddingConsistencyOptions = {
  /** 锚点样本数（默认 8）。 */
  sampleSize?: number;
  /** 判定阈值（默认 0.97）。 */
  threshold?: number;
  logger?: { warn?: (...args: unknown[]) => void };
};

/**
 * 执行一致性自检。knowledge.db 不可用或样本为空时返回 null（不视为失败，
 * 调用方按"无法自检"处理）；embedding 请求失败时同样返回 null 并 warn。
 */
export async function checkEmbeddingConsistency(
  dbPath: string,
  client: EmbeddingClient,
  options: EmbeddingConsistencyOptions = {},
): Promise<EmbeddingConsistencyResult | null> {
  const sampleSize = options.sampleSize ?? 8;
  const threshold = options.threshold ?? 0.97;
  const logger = options.logger;

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const rows = db
      .prepare(
        `SELECT c.content, e.vector FROM chunks c JOIN embeddings e ON e.chunk_id = c.id
         WHERE length(c.content) BETWEEN 100 AND 500 ORDER BY RANDOM() LIMIT ?`,
      )
      .all(sampleSize) as Array<{ content: string; vector: Uint8Array }>;
    if (rows.length === 0) return null;

    const vectors: Float32Array[] = rows.map(row => {
      return new Float32Array(row.vector.buffer, row.vector.byteOffset, Math.floor(row.vector.byteLength / 4));
    });
    const queryVectors = await client.embed(rows.map(row => row.content));

    const samples: EmbeddingConsistencySample[] = rows.map((row, i) => {
      const query = Float32Array.from(queryVectors[i] ?? []);
      const cosine = cosineSimilarity(query, vectors[i]!);
      return { text: row.content.slice(0, 60), cosine };
    });
    const meanCosine = samples.reduce((sum, s) => sum + s.cosine, 0) / samples.length;
    const ok = meanCosine >= threshold;
    if (!ok) {
      logger?.warn?.(
        `[knowledge] embedding 查询端与知识库向量不一致（均值 ${meanCosine.toFixed(4)} < ${threshold}），语义召回降级。建议使用 bge-m3 系模型。`,
      );
    }
    return { ok, meanCosine, sampleCount: samples.length, samples };
  } catch (error) {
    logger?.warn?.(`[knowledge] 一致性自检失败（跳过）: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    db.close();
  }
}
