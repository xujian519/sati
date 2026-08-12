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
import type { EmbeddingClient } from "../../model/embedding/types.js";
import { cosineSimilarity } from "../../context/vector/cosine.js";
import { registerChunkUncompress } from "./chunk-compression.js";

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
    // chunk 压缩解压函数（--compress-chunks 产物 BLOB；明文原样返回）。
    registerChunkUncompress(db);
    // scale 列仅 --migrate-int8 后的库存在；旧 schema 无此列，查询时回退常量。
    const cols = db.prepare("SELECT name FROM pragma_table_info('embeddings')").all() as Array<{ name: string }>;
    const hasScale = cols.some(c => c.name === "scale");
    const rows = db
      .prepare(
        `SELECT sati_uncompress(c.content) AS content, e.vector, e.dim, ${hasScale ? "e.scale" : "1.0"} AS scale
         FROM chunks c JOIN embeddings e ON e.chunk_id = c.id
         WHERE length(sati_uncompress(c.content)) BETWEEN 100 AND 500 ORDER BY RANDOM() LIMIT ?`,
      )
      .all(sampleSize) as Array<{ content: string; vector: Uint8Array; dim: number; scale: number }>;
    if (rows.length === 0) return null;

    // 双格式兼容：dim*4 字节 = float32（XiaoNuo 原始）；dim 字节 = int8（--migrate-int8
    // 产物），乘 scale 反量化回 float32 再算余弦（量化误差内等价）。
    const vectors: Float32Array[] = rows.map(row => {
      const dim = row.dim || Math.floor(row.vector.byteLength / 4);
      if (row.vector.byteLength === dim * 4) {
        return new Float32Array(row.vector.buffer, row.vector.byteOffset, dim);
      }
      const int8 = new Int8Array(row.vector.buffer, row.vector.byteOffset, dim);
      const scale = row.scale || 1;
      const out = new Float32Array(dim);
      for (let i = 0; i < dim; i += 1) {
        out[i] = (int8[i] ?? 0) * scale;
      }
      return out;
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
